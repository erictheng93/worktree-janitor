[English](manual.md) | 繁體中文

# worktree-janitor 使用手冊

本手冊說明 worktree-janitor 0.1.0。簡短介紹請見 [README](../README.zh-TW.md)。

網址與指令中的 `OWNER` 是發布此儲存庫的 GitHub 帳號或組織，請換成該名稱。

## 目錄

1. [概念](#概念)
2. [安裝](#安裝)
3. [命令列參考](#命令列參考)
4. [Hook 模式](#hook-模式)
5. [報告格式](#報告格式)
6. [結束代碼](#結束代碼)
7. [保留原因與處理方式](#保留原因與處理方式)
8. [環境變數](#環境變數)
9. [平台說明](#平台說明)
10. [解除安裝](#解除安裝)
11. [疑難排解](#疑難排解)
12. [常見問題](#常見問題)
13. [已知限制](#已知限制)

## 概念

### Worktree

git worktree 是附加在同一個儲存庫上的額外工作目錄（`git worktree add`）。儲存庫原本的 checkout 稱為**主要 worktree**，永遠是 `git worktree list` 的第一筆。Claude Code 等程式開發代理程式會為每個工作階段或子代理建立一個 worktree，各自使用自己的分支，所以用完的 worktree 會不斷累積。

不論從哪裡啟動，worktree-janitor 一律從主要 worktree 運作：`--repo`（或目前目錄）可以是主要 worktree，也可以是該儲存庫任何一個連結的 worktree。它絕不移除主要 worktree、bare 儲存庫項目，或包含主要 worktree 的 worktree。

### 基底分支偵測

基底分支是已完成的工作合併進去的分支。選擇基底之前，若存在名為 `origin` 的遠端，janitor 會先執行 `git fetch --prune --quiet origin`（逾時 15 秒；失敗時，例如離線，會被忽略）。接著，除非指定了 `--base`，否則取下列第一個能解析為提交的參照：

1. `origin/HEAD` 指向的目標（例如 `origin/main`）
2. `origin/main`
3. `origin/master`
4. `main`
5. `master`

`--base <ref>` 接受任何能解析為提交的參照，例如 `origin/develop` 或 `release`。無法解析時，執行會以 `base branch not found` 失敗。基底的本機名稱（去掉 `origin/` 或 `upstream/` 前綴後的名稱）受保護、不會被刪除。

### 分支如何算已合併

對於某個 worktree 的分支或某個本機分支，設其最新提交為 `T`，janitor 會計算 `base..T` 中的提交數：

| 情況 | 檢查方式 | 結果 |
| --- | --- | --- |
| 領先基底若干提交，且每個提交在基底中都有等價的修補 | `git cherry <base> T` 沒有任何 `+` 行 | 已合併（rebase 合併、cherry-pick） |
| 領先基底若干提交，且 `gh` 回報有一個已合併的 PR，其 head 提交等於 `T` | `gh pr list --state merged --head <branch> --json headRefOid,number --limit 30` | 已合併（squash 合併） |
| 領先若干提交，以上皆非 | | 未合併 |
| 領先 0 個提交，且 `T` 只能經由某個 merge commit 的第二個父提交從基底到達 | `T` 不在 `git rev-list --first-parent <base>` 中 | 已合併（merge commit） |
| 領先 0 個提交，`T` 在基底的 first-parent 鏈上，且 `gh` 回報有 head 為 `T` 的已合併 PR | 同上 | 已合併（例如 fast-forward 合併） |
| 領先 0 個提交，其他情況 | | 未合併：從未有自己工作的新分支 |

注意事項：

- `gh` 是選用的。若未安裝、未登入、離線，或儲存庫不在 GitHub 上，第一次呼叫失敗後本次執行就不再使用它，squash 合併的分支會被保留，原因中附帶 `(gh unavailable for squash check)`。
- PR 的 head 提交必須與本機分支的最新提交完全相同。PR 合併之後又有新提交（或被 amend）的分支，不會被視為已合併。
- first-parent 走訪上限為 50,000 個提交。超過時，領先 0 個提交的分支只有在 `gh` 確認後才算已合併。

### 沒有提交的新分支

從基底建立、從未提交過的分支，領先 0 個提交且位於基底的 first-parent 鏈上。沒有 `gh` 時它與 fast-forward 合併的分支無法區分，所以會被保留：移除它可能會刪掉某人剛開始使用的 worktree。

例外：Claude Code 名為 `worktree-*` 的附屬分支，若領先 0 個提交**且**沒有被任何 worktree checkout，就會被刪除。

### 鎖定

`git worktree lock` 會把 worktree 標記為使用中。Claude Code 會鎖定它建立的 worktree，原因格式為 `claude agent <name> (pid <pid>)` 或 `claude session <name> (pid <pid> start <time>)`。janitor 處理這種鎖定的方式與 Claude Code 相同：

- PID 仍在執行：保留（`locked by a live Claude Code process`）
- PID 已不在：鎖定已失效，不會阻止移除，等資料夾刪除後再解除鎖定
- 其他任何鎖定（使用者自己的 `git worktree lock`、其他工具）：保留

`--include-locked` 會覆寫仍有效與來源不明的鎖定。PID 被重複使用可能讓已結束的工作階段看起來仍在執行；這只會讓 worktree 被保留。

### 連結與掛載點

這裡的**連結**指 symlink、NTFS junction，或 Node.js 回報為連結的其他 reparse point。worktree 內的連結絕不會被跟隨：janitor 只移除連結本身，之後確認其目標仍然存在。

**掛載點**是掛上另一個檔案系統（或某個資料夾的 bind mount）的資料夾。其內容不屬於 worktree，所以含有掛載點的 worktree 會被保留；janitor 絕不卸載任何東西。使用兩種彼此獨立的偵測方式：

- Linux：`/proc/self/mountinfo` 中位於 worktree 本身或其下的所有掛載點。這是偵測同一檔案系統上 bind mount 的唯一方法。
- 所有作業系統：裝置 ID（`st_dev`）與 worktree 根目錄不同的資料夾。掃描沒有深度限制。

## 安裝

### Claude Code 外掛

從 GitHub 安裝（在 shell 中執行；預設範圍為 `user`，對所有專案生效）：

```
claude plugin marketplace add OWNER/worktree-janitor
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

marketplace 來源也可以寫成網址 `https://github.com/OWNER/worktree-janitor`，或本機 clone 的路徑。一步完成的寫法：

```
claude plugin install worktree-janitor --marketplace OWNER/worktree-janitor
```

在 Claude Code 中也可以使用 `/plugin marketplace add OWNER/worktree-janitor` 與 `/plugin install worktree-janitor@worktree-janitor-marketplace`。

安裝後請重新啟動 Claude Code。外掛提供：

| 元件 | 說明 |
| --- | --- |
| `SessionStart` hook | `node ${CLAUDE_PLUGIN_ROOT}/scripts/janitor.mjs --hook session-start`，逾時 30 秒 |
| `PostToolUse` hook | matcher 為 `Bash\|PowerShell`，`node ... --hook post-tool-use`，逾時 30 秒；只在 `gh pr merge` 之後動作 |
| `/worktree-janitor:clean-worktrees` | 試跑、顯示報告、請你確認，之後才以 `--apply` 執行。只有你能呼叫；模型不會自行呼叫 |

hook 使用 exec 形式（`"command": "node"` 加上 `args` 陣列），不經過 shell，路徑含空格也不需要加引號。`node` 必須在 `PATH` 中。

日後更新：

```
claude plugin marketplace update worktree-janitor-marketplace
claude plugin update worktree-janitor@worktree-janitor-marketplace
```

### Codex CLI 外掛

```
codex plugin marketplace add OWNER/worktree-janitor
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

`codex plugin marketplace add` 也接受 `owner/repo@ref`、HTTPS 或 SSH 的 git 網址，或本機路徑。Codex 會把外掛複製到 `$CODEX_HOME/plugins/cache/`，並在 `config.toml` 中啟用。

| 元件 | 說明 |
| --- | --- |
| `SessionStart` hook | `node "${PLUGIN_ROOT}/scripts/janitor.mjs" --hook session-start`，逾時 30 秒 |
| `PostToolUse` hook | matcher 為 `Bash`，`node "${PLUGIN_ROOT}/scripts/janitor.mjs" --hook post-tool-use`，逾時 30 秒 |
| `$clean-worktrees` skill | 與 Claude Code 指令相同的「先試跑、確認後才執行」流程；只能明確呼叫 |

安裝後啟動 Codex 並信任這些 hook：Codex 會在啟動時詢問，或開啟 `/hooks`。未受信任的 hook 永遠不會執行。從 GitHub 安裝的 marketplace 可用 `codex plugin marketplace upgrade worktree-janitor-marketplace` 更新。

不要再另外執行 `install.mjs --codex`：兩者會註冊相同的 hook，導致每個 hook 執行兩次。安裝程式若發現外掛已啟用，會顯示警告。

### 安裝程式 scripts/install.mjs

安裝程式在 clone 中執行，所有設定都指向**該 clone** 的 `scripts/janitor.mjs`，所以請把 clone 留在原處（搬移後需重新安裝）。

```
git clone https://github.com/OWNER/worktree-janitor.git
cd worktree-janitor
node scripts/install.mjs --all --dry-run
```

| 選項 | 作用 |
| --- | --- |
| `--claude` | Claude Code：透過 `claude` CLI，把這個 clone 加為本機 marketplace `worktree-janitor-marketplace`，並以使用者範圍安裝外掛。只執行尚未完成的步驟。`claude` 不在 `PATH` 中時顯示訊息並略過 |
| `--codex` | Codex CLI：hook、skill 與 `AGENTS.md` 規則（見下方） |
| `--all` | 同時 `--claude` 與 `--codex` |
| `--uninstall` | 只移除安裝程式加入的內容，其他一概不動 |
| `--dry-run` | 列出所有預計的變更，不寫入任何東西 |
| `-h`、`--help` | 使用說明 |

沒有 `--claude`、`--codex` 或 `--all` 時，會顯示使用說明並以 2 結束。

`--codex` 寫入的內容（`$CODEX_HOME` 預設為 `~/.codex`）：

| 目標 | 內容 |
| --- | --- |
| `$CODEX_HOME/hooks.json`（若該檔案已存在） | 兩組 hook；已存在就原地取代，否則附加在後。既有的群組絕不移動，因為 Codex 的信任鍵與位置有關 |
| 否則為 `$CODEX_HOME/config.toml` | 相同的 hook，以 `[[hooks.*]]` 表格寫在 `# >>> worktree-janitor >>>` ... `# <<< worktree-janitor <<<` 區塊內 |
| `~/.agents/skills/clean-worktrees/SKILL.md` 與 `agents/openai.yaml` | `$clean-worktrees` skill，只能明確呼叫 |
| `$CODEX_HOME/AGENTS.md` | 一段有標記的規則，要求 Codex 絕不直接執行 `git worktree remove`，改用 janitor |

Codex 會合併 `hooks.json` 與 `config.toml` 內的 `[hooks]` 表格，但只要同一層設定同時使用兩者，每次啟動工作階段都會警告，所以安裝程式會沿用你已經在用的那一種。

行為細節：

- 冪等：再執行一次會顯示 `ok ... (already installed)` 且不重寫任何檔案，已信任的 hook 會維持信任。
- 第一次修改既有檔案之前，會把原始內容存成 `<file>.worktree-janitor.bak`（只存一次）。解除安裝時，若檔案沒有其他變動就還原成完全相同的原始內容，刪除它建立的檔案，並移除備份。
- Codex 自己插入在標記區塊內的表格（hook 信任項目）在重新安裝與解除安裝時都會保留。
- 以下情況會拒絕並且不寫入：`hooks.json` 不是有效的 JSON；`config.toml` 已用靜態陣列定義 hook（`SessionStart = [...]` 或 `hooks = {...}`，再加表格會讓 TOML 失效）；已存在一個不是由它安裝的 `clean-worktrees` skill；標記區塊被手動修改過。
- `--claude` 在名為 `worktree-janitor-marketplace` 的 marketplace 已指向其他 clone 時會拒絕；請先從那個 clone 執行 `--claude --uninstall`。
- 在 Windows 上，hook 指令以雙引號包住路徑；若路徑含有 `$`、反引號、`"` 或排版用引號，則改用單引號（Codex 在 Windows 上以 PowerShell 執行 hook 指令，其他平台則用 `sh`）。
- 結束代碼：成功為 0，任一步驟失敗為 1，用法錯誤為 2。

執行 `--codex` 之後，請啟動 Codex 並信任這兩個 hook（啟動時的提示或 `/hooks`）。hook 指令有變動時（例如從其他路徑重新安裝），需要重新信任。

### 用範本手動設定 Codex

`integrations/codex/` 內有與安裝程式寫入內容完全相同的 hook，路徑使用佔位字串 `/path/to/claude-worktree-janitor`：

- [`integrations/codex/config.toml`](../integrations/codex/config.toml)：把佔位字串換成你的 clone 的絕對路徑（Windows 上也可以用正斜線），然後把 `# >>> worktree-janitor >>>` 那一行起的所有內容附加到 `$CODEX_HOME/config.toml`。有了這些標記，日後可用 `node scripts/install.mjs --codex --uninstall` 移除。
- [`integrations/codex/hooks.json`](../integrations/codex/hooks.json)：如果你的 hook 已經放在 `$CODEX_HOME/hooks.json`，改用這個檔案，把其中兩組 hook 合併進你的檔案。

兩個檔案擇一使用，不要同時使用，之後在 Codex 中信任這些 hook。

### 純命令列

不需要安裝：clone 此儲存庫（或只複製沒有任何相依套件的 `scripts/janitor.mjs`），以 Node.js 18 以上或 Bun 執行：

```
node scripts/janitor.mjs --repo /path/to/repo
bun scripts/janitor.mjs --repo /path/to/repo
```

若要接到其他工具的 hook，呼叫 `node /path/to/janitor.mjs --hook session-start` 或 `--hook post-tool-use`，並從 stdin 傳入 [Hook 模式](#hook-模式) 中描述的 payload。

## 命令列參考

```
node janitor.mjs [--apply] [--repo <path>] [--base <branch>] [--json]
                 [--hook session-start|post-tool-use] [--include-locked]
```

| 選項 | 意義 |
| --- | --- |
| （無） | 試跑：列出會被移除或保留的項目及原因 |
| `--apply` | 移除 worktree 並刪除分支 |
| `--repo <path>` | 要處理的儲存庫（預設：目前目錄）。該儲存庫的任何 worktree 都可以；janitor 一律從主要 worktree 運作 |
| `--base <branch>` | 基底分支。預設值見[基底分支偵測](#基底分支偵測) |
| `--json` | 以 JSON 而非文字輸出報告 |
| `--hook <kind>` | Hook 模式，`session-start` 或 `post-tool-use`。隱含 `--apply`，從 stdin 讀取 JSON payload，安靜執行，永遠以 0 結束 |
| `--include-locked` | 連被仍在執行或來源不明的擁有者鎖定的 worktree 也移除 |
| `-h`、`--help` | 使用說明 |

也接受 `--repo=<path>`、`--base=<branch>` 與 `--hook=<kind>` 寫法。未知的參數會把使用說明輸出到 stderr 並以 1 結束。

範例：

```
# 會移除哪些？（不更動任何 worktree 或分支）
node scripts/janitor.mjs

# 從任何地方處理另一個儲存庫
node scripts/janitor.mjs --repo ~/src/my-app

# 實際執行
node scripts/janitor.mjs --repo ~/src/my-app --apply

# 基底分支不是 main/master
node scripts/janitor.mjs --base origin/develop

# 連被使用者或其他工具鎖定的 worktree 也移除
node scripts/janitor.mjs --apply --include-locked

# 供程式讀取的報告
node scripts/janitor.mjs --json

# 模擬合併後的 hook
echo '{"tool_input":{"command":"gh pr merge 12 --squash"},"cwd":"/path/to/repo"}' | node scripts/janitor.mjs --hook post-tool-use
```

## Hook 模式

| | `--hook session-start` | `--hook post-tool-use` |
| --- | --- | --- |
| 代理程式何時執行 | 每次工作階段開始 | 每次 shell 工具呼叫之後（Claude Code 為 `Bash` 或 `PowerShell`，Codex 為 `Bash`） |
| 何時動作 | 一律 | 指令符合 `gh pr merge`（也包含 `gh.exe`、不分大小寫、可在字串任何位置，包含 `bash -lc` 或 `powershell -Command` 包裝內） |
| stdin 等待時間 | 最多 1 秒 | 最多 3 秒 |

共同行為：

- 隱含 `--apply`。
- 整次執行限制在約 20 秒內；時間用完時剩下的項目會以 `time budget exhausted` 原因保留，下次再處理。`gh` 呼叫的逾時為 6 秒（非 hook 模式為 10 秒）。
- 輸出：沒有輸出；或在有東西被移除或刪除、移除中途停止、或安全檢查觸發時，於 stdout 輸出一行。例如：`worktree-janitor: removed 1 merged worktree(s) (wt-login); deleted 1 merged branch(es) (feature-login)`。最多列出四個名稱，其餘以 `+N more` 表示。加上 `--json` 則改為輸出完整報告。
- 永遠以 0 結束，即使參數錯誤、payload 無法解析、不是儲存庫或發生內部錯誤也一樣，所以 hook 絕不會讓工作階段失敗。

### Payload 格式

janitor 只讀取兩個欄位：`cwd`（字串），以及 `post-tool-use` 時 `tool_input` 內的指令。其餘欄位一律忽略。

Claude Code `PostToolUse`（節錄）：

```json
{
  "hook_event_name": "PostToolUse",
  "cwd": "/path/to/repo",
  "tool_name": "Bash",
  "tool_input": { "command": "gh pr merge 12 --squash --delete-branch" }
}
```

PowerShell 工具的 `tool_name` 為 `PowerShell`，結構相同。

Codex CLI `PostToolUse`（擷取自 Windows 上的 Codex 0.172，ID 已遮蔽，節錄）：

```json
{
  "session_id": "00000000-0000-0000-0000-000000000000",
  "turn_id": "00000000-0000-0000-0000-000000000001",
  "transcript_path": null,
  "cwd": "/path/to/repo",
  "hook_event_name": "PostToolUse",
  "permission_mode": "bypassPermissions",
  "tool_name": "Bash",
  "tool_input": { "command": "gh pr merge 7 --squash --delete-branch" },
  "tool_response": "...",
  "tool_use_id": "call_redacted"
}
```

Codex 在 Windows 上也送出 `tool_name` 為 `Bash`，且 `tool_input.command` 是模型寫下的原始指令，不含 Codex 執行它時使用的 shell 包裝。

`SessionStart` payload（兩種代理程式皆同）包含 `cwd`、`hook_event_name` 與工作階段資訊；只會使用 `cwd`。

讀取指令的方式如下，確保任何 payload 結構都無法讓 hook 當掉：

- `tool_input.command`（或 `tool_input.cmd`）為字串；
- argv 陣列，例如 `["bash", "-lc", "gh pr merge 5"]`，以空格串接；
- `tool_input` 本身為字串；
- 其他任何形式都視為沒有指令，`post-tool-use` 會安靜結束。

空的、不是 JSON，或不是 JSON 物件的 payload 會被忽略：`post-tool-use` 不做任何事，`session-start` 則從目前目錄執行。

**BOM 處理：** Windows PowerShell 5.1 會在管線輸入的 stdin 前加上 UTF-8 位元組順序標記（EF BB BF），導致 `JSON.parse` 失敗。janitor 會把它去除，並且等所有位元組到齊後才以 UTF-8 解碼，所以跨區塊切開的多位元組字元也能正確讀取。

**工作目錄：** payload 的 `cwd` 會決定處理哪個儲存庫（除非指定了 `--repo`），並且和 janitor 自己的工作目錄一樣，保護它所在的 worktree 不被移除。

## 報告格式

### 文字

小型儲存庫的試跑結果（路徑已縮短）：

```
worktree-janitor (dry run)  repo: /home/user/src/app  base: origin/main
Worktrees:
  kept          /home/user/src/app  [main]
                main worktree
  kept          /home/user/src/app-fresh  [fresh]
                0 commits ahead of origin/main (fresh branch, not treated as merged)
  kept          /home/user/src/app-locked  [locked-one]
                locked: manual hold
  would-remove  /home/user/src/app-login  [feature-login]
                merged: tip is reachable from origin/main through a merge commit
  kept          /home/user/src/app-wip  [wip]
                dirty: 1 modified/untracked path(s)
Branches:
  would-delete  feature-login
                merged: tip is reachable from origin/main through a merge commit
  kept          fresh
                checked out in worktree /home/user/src/app-fresh
  kept          locked-one
                checked out in worktree /home/user/src/app-locked
  kept          main
                base branch
  kept          wip
                checked out in worktree /home/user/src/app-wip
  would-delete  worktree-agent-1
                companion worktree-* branch with 0 commits ahead, not checked out
Dry run: nothing was changed. Re-run with --apply to act.
```

錯誤會以 `error: <message>` 行接在清單後面。試跑時，`would-remove` worktree 的分支會被當作該 worktree 已經移除來評估。

### JSON

```json
{
  "repo": "/home/user/src/app",
  "base": "origin/main",
  "applied": false,
  "worktrees": [
    { "path": "/home/user/src/app-login", "branch": "feature-login", "action": "would-remove",
      "reason": "merged: tip is reachable from origin/main through a merge commit" }
  ],
  "branches": [
    { "name": "feature-login", "action": "would-delete",
      "reason": "merged: tip is reachable from origin/main through a merge commit" }
  ],
  "errors": []
}
```

| 欄位 | 意義 |
| --- | --- |
| `repo` | 主要 worktree 的路徑 |
| `base` | 使用的基底參照，例如 `origin/main` |
| `applied` | 使用 `--apply` 或 hook 模式時為 `true`，試跑時為 `false` |
| `worktrees[]` | 每個已註冊的 worktree 一筆，包含主要 worktree：`path`、`branch`（detached 時為 `null`）、`action`、`reason`，`partial` 時另有 `stoppedAt` |
| `branches[]` | 每個本機分支一筆：`name`、`action`、`reason` |
| `errors[]` | 失敗與安全停止的訊息。以 `SAFETY` 開頭的訊息表示安全檢查被觸發 |

Worktree 的 action：

| Action | 意義 |
| --- | --- |
| `kept` | 未更動；`reason` 說明原因 |
| `would-remove` | 試跑：加上 `--apply` 時會被移除 |
| `removed` | 資料夾已刪除，註冊資訊已清除。原因後可能附加 `; unlinked N link(s), targets untouched`、`; stale Claude Code lock (pid not alive)` 或 `; lock overridden by --include-locked`。資料夾原本就不存在的 worktree 為 `directory missing; registration pruned` |
| `partial` | 已開始刪除但中途停止。`stoppedAt` 是停止的位置；之後的東西都沒有刪除；worktree 仍然保持註冊 |

分支的 action：`kept`、`would-delete`（試跑）、`deleted`（`git branch -D` 成功）。

## 結束代碼

| 指令 | 代碼 | 時機 |
| --- | --- | --- |
| `janitor.mjs` | 0 | 執行完成且沒有錯誤（包含試跑，以及沒有任何事要做的情況） |
| `janitor.mjs` | 1 | 未知參數、不是 git 儲存庫、找不到基底分支、目前目錄已刪除且沒有絕對路徑的 `--repo`、`errors` 中有任何項目，或有任何 `partial` worktree |
| `janitor.mjs --hook ...` | 0 | 一律 |
| `install.mjs` | 0 | 成功（`--help` 也是） |
| `install.mjs` | 1 | 某個步驟失敗（訊息會說明是哪一步） |
| `install.mjs` | 2 | 未知參數，或沒有 `--claude`、`--codex`、`--all` 任何一個 |

## 保留原因與處理方式

Worktree，依檢查執行順序排列：

| 原因 | 意義 | 處理方式 |
| --- | --- | --- |
| `main worktree` | 儲存庫的主要 checkout | 不需處理；永遠不會被移除 |
| `bare repository entry` | bare 儲存庫本身 | 不需處理 |
| `locked by a live Claude Code process (pid N)` | 執行中的 Claude Code 工作階段或子代理正在使用 | 等它結束；程序結束後就會被清理 |
| `locked: <reason>` / `locked` | 被使用者或其他工具鎖定 | `git worktree unlock <path>`，或加上 `--include-locked` 執行 |
| `detached HEAD (externally managed)` | 沒有 checkout 任何分支 | 不再需要的話請自行移除 |
| `contains the main worktree` | 主要 worktree 位於其中 | 不需處理；永遠不會被移除 |
| `current working directory is inside it` | janitor（或 hook 的工作階段）正在其中執行 | 改從其他地方執行，例如主要 worktree |
| `dirty: N modified/untracked path(s)` | `git status` 不為空 | 提交、stash 或刪除這些變更後再執行 |
| `git status failed: ...` | git 無法讀取這個 worktree | 在該處執行 `git status` 查看原因 |
| `not merged: N commit(s) not in <base>` | 有工作不在基底中 | 合併它，或保留不動。如果是 squash 合併，請安裝 `gh` 並登入 |
| `... (gh unavailable for squash check)` | 同上，且無法詢問 `gh` | 安裝 `gh`、執行 `gh auth login`，或檢查網路 |
| `0 commits ahead of <base> (fresh branch, not treated as merged)` | 沒有自己的提交；可能是新分支，也可能是 fast-forward 合併 | 不用的話請自行刪除；有 `gh` 時可偵測 fast-forward 合併的 PR |
| `could not compare with base` | `git rev-list` 失敗 | 確認基底與分支都存在（`git fetch`） |
| `contains populated submodule <path> (git refuses to remove such worktrees)` | 刪除會遺失 submodule 資料 | 解除 submodule 初始化（`git submodule deinit`），或手動移除 worktree |
| `has submodule git dirs in <dir> (git refuses to remove such worktrees)` | submodule 的物件庫位於該 worktree 的管理資料夾中 | 同上 |
| `could not locate the worktree git dir` / `git ls-files failed: ...` | 無法讀取 git 中繼資料 | 用 `git worktree list` 與 `git status` 檢查該 worktree |
| `contains mount point <path>; unmount it first` | worktree 本身或其下有掛載點（多個時附 `(+N more)`） | 卸載它（`umount`，Windows 上移除磁碟掛載），再重新執行 |
| `cannot read /proc/self/mountinfo (...)` / `/proc/self/mountinfo lists no mounts` | 僅限 Linux：無法排除掛載點 | 在有掛載 `/proc` 的環境執行（某些容器與沙箱會隱藏它） |
| `cannot read <dir>; cannot rule out mount points, not deleting` | 內部某個資料夾無法列出 | 修正其權限，或自行移除 |
| `time budget exhausted while scanning for links and mount points` / `time budget exhausted` | hook 模式用完約 20 秒的時間預算 | 不需處理；下次執行會繼續。非常大的目錄樹請手動執行 CLI（沒有時間限制） |
| `skipped after a safety abort` | 本次執行中先前的 worktree 觸發了安全停止 | 先查看 `SAFETY` 錯誤 |
| `removal failed: ...` | 刪除沒有開始，或沒有刪除任何東西；包含 `no longer registered`，以及刪除前再次執行的掛載點檢查 | 閱讀訊息；排除原因後重新執行 |

分支：

| 原因 | 處理方式 |
| --- | --- |
| `base branch` / `protected branch name` | 不需處理；`main`、`master`、`develop`、`trunk` 與基底永遠不會被刪除 |
| `checked out in worktree <path>` | 該 worktree 被移除後就會刪除 |
| 任何 `not merged` / `0 commits ahead` 原因 | 同上方 worktree 的說明 |
| `delete failed: ...` | 閱讀 git 的訊息（`git branch -D <name>`） |
| `skipped after a safety abort` / `time budget exhausted` | 同上方 worktree 的說明 |

### partial

`partial` worktree 表示刪除已開始但中途停止，例如某個資料夾被發現位於其他裝置（出現了掛載點）、類型改變、被替換，或無法刪除（在 Windows 上通常是檔案被其他程式開啟中）。停止點之後的一切都沒有被動到：`stoppedAt` 的資料夾、其餘的目錄樹、worktree 的 `.git` 檔案（刻意最後才刪）以及它的註冊資訊。它的分支會被保留，因為仍處於 checkout 狀態。

處理方式：

1. 閱讀原因與 `errors` 中的項目。查看 `stoppedAt`：是掛載點、連結，還是使用中的檔案？
2. 排除原因：卸載、關閉佔用檔案的程式、修正權限。
3. 此時已刪除的追蹤檔案會在該 worktree 中顯示為刪除，因此會被判為 `dirty`。可以用 `git -C <worktree> restore .` 還原後再執行 janitor；或在確定 worktree 底下沒有任何掛載點或指向他處的連結之後，自行刪除剩下的資料夾並執行 `git worktree prune`。

在 hook 模式中，一行摘要一定會提到部分移除（`PARTIAL removal of <name>: ...`）。

## 環境變數

| 變數 | 使用者 | 用途 |
| --- | --- | --- |
| `CODEX_HOME` | `install.mjs` | Codex 設定資料夾（預設 `~/.codex`） |
| `JANITOR_GH` | `janitor.mjs` | 取代 `gh` 執行的指令，用於不在 `PATH` 中的 `gh`。以 `.js`、`.mjs` 或 `.cjs` 結尾的路徑會用目前的 Node.js/Bun 執行檔執行。測試以此指向假的 `gh` |
| `JANITOR_CLAUDE` | `install.mjs` | 取代 `PATH` 中 `claude` 的指令（`.js`/`.mjs`/`.cjs` 以 Node.js 執行）。供測試使用 |
| `JANITOR_RUNTIME` | 測試 | 測試中執行 `janitor.mjs` 的執行檔，例如 `bun`。測試執行器本身一律是 Node.js |
| `JANITOR_REQUIRE_MOUNT_TESTS` | 測試 | 設定後，若 Linux 掛載點測試會被略過，則有一個測試會失敗（CI 在 Ubuntu 上設定此值） |
| `JANITOR_TEST_FOREIGN_DEV_AT` | `janitor.mjs`，僅供測試 | 讓指定的資料夾在刪除程序清空它之後回報不同的裝置，以便不需 root 就能測試刪除中途停止。**一般使用時絕對不要設定**：它會讓刪除中途停止 |

janitor 執行 git 與 gh 時會設定 `GIT_TERMINAL_PROMPT=0`、`GH_PROMPT_DISABLED=1` 與 `GCM_INTERACTIVE=never`，所以不會有任何認證提示卡住 hook。

## 平台說明

### Windows

- **Junction：** Node.js 與 Bun 會把 NTFS junction 回報為符號連結。仍能 `readlink` 的資料夾也會被當作連結。移除連結時依序嘗試 unlink、`rmdir`（不加 `/s`），最後才用 `cmd /c rmdir`；每一種都只移除連結本身。
- **長路徑：** 所有檔案操作都使用 `\\?\` 路徑，所以深度超過 `MAX_PATH`（260 個字元）的 worktree（`node_modules` 很常見）也能正確刪除。
- **大小寫：** 路徑先解析為實際路徑，再以不分大小寫的方式比較。
- **掛載的磁碟區：** 掛載到資料夾的磁碟區預期不會被回報為連結，因此靠裝置 ID 檢查來偵測（未經驗證，見[已知限制](#已知限制)）。
- **使用中的檔案：** Windows 無法刪除被其他程序開啟的檔案，也無法刪除某個程序的目前目錄；兩者都會讓刪除停止（`partial`）。
- **PowerShell 5.1** 會在管線輸入的 stdin 加上 BOM；janitor 會去除它。
- checkout 中的**檔案 symlink** 需要開發人員模式或系統管理員權限，且 `core.symlinks=false` 時 git 會把它們 checkout 成一般文字檔。junction 不需要特殊權限。
- Codex 透過 `powershell.exe -NoProfile -Command` 執行 hook 指令；安裝程式的引號處理已考慮這點。

### macOS

- `/var` 與 `/tmp` 是指向 `/private` 的符號連結。git 輸出的是實際路徑，hook payload 卻不一定，所以所有比較都先解析實際路徑；已不存在的路徑則透過最近一個仍存在的上層資料夾解析。
- APFS 預設不分大小寫，但也可以格式化為區分大小寫，因此路徑解析後以完全相同的方式比較，並以裝置與 inode 比對作為第二道檢查。誤判只會讓 worktree 被保留。
- 掛載的磁碟區由裝置 ID 檢查偵測；macOS 沒有 mountinfo。

### Linux

- 掛載點讀取自 `/proc/self/mountinfo`（第 5 個欄位，並解碼 `\040` 等八進位跳脫字元）。若該檔案無法讀取或沒有列出任何項目，所有候選 worktree 都會被保留。
- 檔案系統視為區分大小寫：`/src/Wt` 與 `/src/wt` 是不同的資料夾。
- 如果啟動 janitor 時所在的資料夾已被刪除（例如 hook 在剛移除的 worktree 中觸發），只要給了絕對路徑的 `--repo`（或 hook payload 中的 `cwd` 為絕對路徑）仍可執行。否則手動執行會以 1 結束並顯示 `current directory no longer exists; pass an absolute --repo`，hook 則安靜地以 0 結束。（Windows 無法刪除程序的工作目錄，所以不會發生這種情況。）

### 所有平台

- 文字檔一律以 LF 換行 checkout（`.gitattributes`），所以在 Windows 上建立的 clone 也能在 Linux 與 macOS 上執行。
- 腳本只需要 Node.js 標準函式庫；在 Bun 下行為相同。

## 解除安裝

| 安裝方式 | 移除方式 |
| --- | --- |
| Claude Code 外掛 | `claude plugin uninstall worktree-janitor@worktree-janitor-marketplace`，再執行 `claude plugin marketplace remove worktree-janitor-marketplace` |
| Codex 外掛 | `codex plugin remove worktree-janitor@worktree-janitor-marketplace`，再執行 `codex plugin marketplace remove worktree-janitor-marketplace` |
| `install.mjs --claude` | `node scripts/install.mjs --claude --uninstall`（從同一個 clone 執行） |
| `install.mjs --codex` | `node scripts/install.mjs --codex --uninstall`（可先加 `--dry-run` 預覽） |
| 手動設定 Codex | 若使用含標記的 `config.toml` 範本，執行 `node scripts/install.mjs --codex --uninstall`；否則手動刪除那兩組 hook |
| 純命令列 | 刪除 clone |

安裝程式解除安裝時，若 `worktree-janitor-marketplace` 指向其他 clone，會保持不動並提示。

## 疑難排解

### Hook 沒有執行

- **Codex：hook 未受信任。** 開啟 `/hooks`，信任兩個 worktree-janitor hook。`codex exec` 會安靜地略過未受信任的 hook。從其他路徑重新安裝後指令已改變，必須重新信任。
- **外掛未啟用。** `claude plugin list` 或 `codex plugin list` 應顯示它已安裝且已啟用。安裝後請重新啟動代理程式。
- **`node` 不在 `PATH` 中。** hook 會執行 `node`。請在代理程式啟動的環境中確認 `node --version`（從圖形介面啟動的代理程式可能看不到 shell 的 `PATH`）。
- **`post-tool-use` 沒有動作。** 這是設計如此：只有在 shell 指令包含 `gh pr merge` 時才動作。在瀏覽器或其他工具中完成的合併，會在下次工作階段開始時處理。
- **沒有任何輸出。** 除非有東西被移除，否則 hook 不輸出任何訊息。執行 `node scripts/janitor.mjs --repo <repo>` 查看完整報告。

### Worktree 被保留

先試跑並閱讀原因，再參考[保留原因與處理方式](#保留原因與處理方式)：

```
node scripts/janitor.mjs --repo <repo>
```

常見情況：未追蹤的檔案讓 worktree 被判為 `dirty`；squash 合併的分支需要 `gh`（已安裝並登入）；PR head 與本機最新提交不同的分支不會被視為已合併。

### 移除中途停止

見 [partial](#partial)。

### 摘要重複出現

如果 Codex 中每則摘要都出現兩次，代表外掛與安裝程式同時生效。移除其中一個（[解除安裝](#解除安裝)）。

## 常見問題

**試跑會更動任何東西嗎？**
不會更動任何 worktree 或分支。它會執行 `git fetch --prune origin`，這會更新遠端追蹤參照。

**它會刪除遠端分支嗎？**
不會，只刪除本機分支。遠端分支請用 `gh pr merge --delete-branch` 或你的代管服務處理。

**為什麼不直接呼叫 `git worktree remove`？**
因為它的遞迴刪除在 Windows 上會跟隨 NTFS junction，在所有作業系統上都會進入掛載點。janitor 改用自己的「失敗即停止」刪除方式。

**它會刪掉我的 `node_modules` junction 目標嗎？**
不會。junction 只會被解除連結，之後確認目標仍然存在；若目標不見了，會產生 `SAFETY` 錯誤並停止執行。

**我用 GitLab 或 Bitbucket 可以嗎？**
除了需要 `gh` 的 squash 合併偵測之外，其他功能都能用。squash 合併的分支會被保留，請自行移除。

**可以從 cron 或 CI 執行嗎？**
可以：`node scripts/janitor.mjs --repo <repo> --apply --json`，並檢查結束代碼。

**需要網路嗎？**
不需要。沒有網路時 fetch 會安靜地失敗並改用本機基底；本次執行也會停用 `gh`。

**Hook 會卡住或讓工作階段失敗嗎？**
不會。hook 永遠以 0 結束，約 20 秒後停止（hook 逾時為 30 秒），也絕不會要求輸入認證資訊。

## 已知限制

- **macOS** 只透過 CI（GitHub 代管的 macOS runner）驗證，沒有在實體機器上驗證過。
- **Windows 磁碟區掛載點**（掛載到 NTFS 資料夾的磁碟）預期會被裝置 ID 檢查偵測到，但尚未驗證。
- **btrfs 子磁碟區、overlayfs 等** 可能讓同一檔案系統上的資料夾回報不同的裝置 ID。這種 worktree 會以 `contains mount point` 被保留：是誤判，但是安全的誤判。
- **Fast-forward 合併** 在 git 歷史中與新分支無從區分，只能透過 `gh` 偵測。
- **本身含有 merge commit 的分支**（例如曾把基底合併進該分支）可能無法被 `git cherry` 辨識，需要 `gh`。
- **只有 `gh pr merge` 會觸發 post-tool hook。** 在其他地方完成的合併（網頁介面、其他工具、隊友）會在下次工作階段開始或手動執行 janitor 時處理。
- Squash 偵測要求 PR 的 head 提交等於本機分支的最新提交，每個分支最多查看 30 個已合併的 PR，且只適用於 GitHub 儲存庫。
- Hook 執行限制在約 20 秒內；非常大的 worktree 可能需要好幾個工作階段，或手動執行。
- 只會 fetch 名為 `origin` 的遠端。

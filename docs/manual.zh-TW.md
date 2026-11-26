[English](manual.md) | 繁體中文

# worktree-janitor 使用手冊

本手冊說明 worktree-janitor 0.1.0。簡短介紹請見 [README](../README.zh-TW.md)。

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

[README](../README.zh-TW.md#安裝) 是精簡版：依使用情境推薦的安裝管道，以及每個管道可以直接複製貼上的指令。本章補充每個管道會建立哪些東西、所有選項，以及更新與解除安裝的行為。指令中的 `v0.1.0` 請換成你要安裝的版本。

### 選擇安裝管道

| 你使用 | 推薦 | 原因 |
| --- | --- | --- |
| Claude Code（CLI 或桌面版 App） | 從 GitHub marketplace 安裝 [Claude Code 外掛](#claude-code-外掛)，固定在標籤上 | 不需要管理本機檔案；外掛內含 hook 與 `/worktree-janitor:clean-worktrees` |
| Codex（CLI 或桌面版 App） | 從 GitHub marketplace 安裝 [Codex 外掛](#codex-外掛)，以 `--ref` 固定版本，再信任它的 hook | 同上，適用 Codex；外掛的 hook 不靠 `PATH` 也找得到 `node` |
| 兩者都沒用，macOS 或 Linux | [Homebrew](#homebrew) | 用 `brew upgrade` 更新；Node.js 會一併安裝 |
| 兩者都沒用，Windows | [install.ps1](#installps1windows) | 不需要系統管理員權限；把 `worktree-janitor` 加到使用者 `PATH` |
| 想給腳本用一份經過驗證的副本，或兩個代理程式共用一份 | [install.sh](#installshmacoslinux) / [install.ps1](#installps1windows) 搭配 `--claude --codex` / `-Claude -Codex` | 發行版壓縮檔經過 SHA-256 驗證；升級後 hook 路徑不變 |

**每個工具只用一種安裝管道：**

- **Claude Code：** 來自 GitHub marketplace 的外掛與安裝程式的本機 marketplace 名稱相同，都叫 `worktree-janitor-marketplace`。安裝程式不會動到其他管道的 marketplace：它會顯示 `skipped: marketplace worktree-janitor-marketplace already comes from ...`，不做任何變更。
- **Codex：** 外掛和安裝程式寫入的 hook（`install.sh --codex`、`install.ps1 -Codex`、`install.mjs --codex`）註冊的是相同的兩個 hook，同時存在時每個 hook 都會執行兩次。`install.mjs` 發現外掛已啟用時會發出警告。

### 需求

- **Node.js 18 以上**或 Bun，用來執行 janitor。各作業系統的安裝方式請見 [README 的事前準備](../README.zh-TW.md#事前準備)。
- **git**，需在 `PATH` 中。`git worktree list --porcelain` 失敗時 janitor 會拒絕執行，git 早於 2.7 就會如此（`git 2.7 or newer is required`）。CI 中測試過最舊的 git 是 2.25.1。
- **gh**（GitHub CLI），選用：只有 squash 合併與少數其他情況需要（見[分支如何算已合併](#分支如何算已合併)）。
- `install.sh`：`curl` 或 `wget`、`tar`，以及 `sha256sum`、`shasum`、`openssl` 其中之一。`install.ps1`：Windows PowerShell 5.1 或 PowerShell 7。

### Claude Code 外掛

Claude Code 的 CLI 與桌面版 App 共用 `~/.claude`，所以在終端機安裝後兩者都能使用。安裝後請重新啟動執行中的工作階段或 App。

```
claude plugin marketplace add https://github.com/erictheng93/worktree-janitor.git#v0.1.0
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

- marketplace 來源也可以寫成簡寫 `erictheng93/worktree-janitor@v0.1.0`（Claude Code 會用 SSH clone，需要 GitHub 的 SSH key），或本機資料夾的路徑。沒有 `#<標籤>` 時會跟著預設分支走，那不是正式發行版。
- 一步完成的寫法（Claude Code 2.1.292 以上）：`claude plugin install worktree-janitor --marketplace https://github.com/erictheng93/worktree-janitor.git#v0.1.0`。
- 在互動式 Claude Code 工作階段中，同樣的指令可寫成 `/plugin marketplace add ...` 與 `/plugin install ...`。
- 預設範圍為 `user`，對所有專案生效。過程中不會詢問任何問題：外掛沒有 `userConfig`。

外掛提供：

| 元件 | 說明 |
| --- | --- |
| `SessionStart` hook | `node ${CLAUDE_PLUGIN_ROOT}/scripts/janitor.mjs --hook session-start`，逾時 30 秒 |
| `PostToolUse` hook | matcher 為 `Bash\|PowerShell`，`node ... --hook post-tool-use`，逾時 30 秒；只在 `gh pr merge` 之後動作 |
| `/worktree-janitor:clean-worktrees` | 先試跑並顯示報告，請你確認後再以 `--apply` 執行。只有你能呼叫，模型不會自行呼叫 |

hook 使用 exec 形式（`"command": "node"` 加上 `args` 陣列），不經過 shell，含空白的路徑也不需要加引號。**`node` 必須在 Claude Code 處理程序的 `PATH` 中。** 從終端機啟動的工作階段會沿用 shell 的 `PATH`；從 Dock 或「開始」功能表啟動的桌面版 App 則不一定：在 macOS 上，由 launchd 啟動的 App 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，除非 App 自己匯入登入 shell 的環境。如果 hook 在桌面版 App 中沒有執行，請把 Node.js 安裝到那個 `PATH` 找得到的位置（在 Windows 上，nodejs.org 的安裝程式與 `winget` 會把它加進系統 `PATH`），或從終端機啟動 App。

**確認：** `claude plugin list` 會列出 `worktree-janitor@worktree-janitor-marketplace`，版本 `0.1.0`；工作階段中有 `/worktree-janitor:clean-worktrees`；`claude --debug-file <檔案>` 的紀錄中有 `SessionStart:startup [node .../scripts/janitor.mjs --hook session-start] ... finished with status 0`。

**更新：** `claude plugin marketplace update` 會停在原本固定的標籤，而且 Claude Code 只在外掛版本號改變時才更新，所以要改掉固定的標籤：

```
claude plugin marketplace remove worktree-janitor-marketplace
claude plugin install worktree-janitor --marketplace https://github.com/erictheng93/worktree-janitor.git#v0.2.0
```

如果你的 Claude Code 沒有一步完成的寫法，就用新標籤重新加入 marketplace，再執行 `claude plugin install worktree-janitor@worktree-janitor-marketplace`。更新後請重新啟動工作階段。沒有固定標籤的 marketplace 則用 `claude plugin marketplace update worktree-janitor-marketplace` 與 `claude plugin update worktree-janitor@worktree-janitor-marketplace` 更新。

**解除安裝：**

```
claude plugin uninstall worktree-janitor@worktree-janitor-marketplace
claude plugin marketplace remove worktree-janitor-marketplace
```

### Codex 外掛

Codex CLI 與桌面版 App 共用 `CODEX_HOME`（預設 `~/.codex`），所以在終端機安裝後兩者都能使用。

```
codex plugin marketplace add erictheng93/worktree-janitor --ref v0.1.0
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

`codex plugin marketplace add` 也接受 `owner/repo@ref`、HTTPS 或 SSH 的 git 網址，或本機路徑。Codex 會把外掛複製到 `$CODEX_HOME/plugins/cache/`，並在 `config.toml` 中啟用。

接著**信任這兩個 hook**：CLI 用 `/hooks` 或啟動時的提示；桌面版 App 在「Settings > Hooks」。未受信任的 hook 永遠不會執行，`codex exec` 會默默略過它們。

| 元件 | 說明 |
| --- | --- |
| `SessionStart` hook | 用找到的第一個 node（見下方）執行 `${PLUGIN_ROOT}/scripts/janitor.mjs --hook session-start`，逾時 30 秒 |
| `PostToolUse` hook | matcher 為 `Bash`，同上但改為 `--hook post-tool-use`，逾時 30 秒 |
| `$clean-worktrees` skill | 與 Claude Code 指令相同的「先試跑、確認後執行」流程；只能明確呼叫 |

外掛的 hook 不需要 `node` 在 `PATH` 中。在 macOS 與 Linux 上（`command`，由 `sh` 執行），會依序嘗試 `PATH` 中的 node、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、`~/.volta/bin/node` 與 fnm 的預設 alias（`~/.local/share/fnm/aliases/default/bin/node`、`~/Library/Application Support/fnm/aliases/default/bin/node`），都找不到就安靜地以 0 結束。在 Windows 上（`commandWindows`，由 PowerShell 執行），先找 `PATH` 中的 `node.exe`，再找 `%ProgramFiles%\nodejs\node.exe`。nvm、asdf、mise 與 `n` 安裝的 node 只能透過 `PATH` 找到。

**確認：** `codex plugin list` 會列出已啟用的 `worktree-janitor@worktree-janitor-marketplace`，版本 `0.1.0`；`/hooks` 會列出外掛的 SessionStart 與 PostToolUse（`Bash`）兩個 hook。

**更新：** 用另一個 `--ref` 再次加入 marketplace 會失敗（「already added from a different source」），所以要移除後重新加入：

```
codex plugin remove worktree-janitor@worktree-janitor-marketplace
codex plugin marketplace remove worktree-janitor-marketplace
codex plugin marketplace add erictheng93/worktree-janitor --ref v0.2.0
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

接著**重新信任 hook**。Codex 依已安裝外掛所有檔案的內容計算 hook 的信任狀態，所以每次更新都要重新核准。沒有固定版本的 marketplace 可用 `codex plugin marketplace upgrade worktree-janitor-marketplace` 更新。

**解除安裝：** 上面更新步驟的前兩行。之後會留下一個空的 `$CODEX_HOME/plugins/cache/worktree-janitor-marketplace` 資料夾。

### install.ps1（Windows）

可在 Windows PowerShell 5.1 與 PowerShell 7 下執行，不需要系統管理員權限。在 Windows PowerShell 5.1 下，下載時會啟用 TLS 1.2。

```powershell
# 指定版本，可加選項（推薦）
& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.ps1))) -Version v0.1.0 -None

# 最新版；`iex` 無法傳入選項
irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1 | iex

# 已下載的檔案
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version v0.1.0 -All
```

沒有 `-Version` 時，不論腳本是從哪個網址下載的，都會安裝最新版。`-Version` 也接受不含 `v` 的 `0.1.0`。

| 選項 | 作用 |
| --- | --- |
| `-Version vX.Y.Z` | 要安裝的版本（預設：從 GitHub API 取得最新版） |
| `-Dir DIR` | 安裝根目錄（預設 `%LOCALAPPDATA%\worktree-janitor`） |
| `-Node PATH` | 要使用的 `node.exe`（預設：`PATH` 中的 node；需 Node.js 18 以上） |
| `-Claude` | 另外從安裝的這份設定 Claude Code 外掛（需要 `claude` 在 `PATH` 中） |
| `-Codex` | 另外設定 Codex 的 hook、skill 與 `AGENTS.md` 規則 |
| `-All` | 兩者都設定 |
| `-None` | 都不設定，只裝檔案與啟動器。不能與上面三個選項並用 |
| （四者皆未指定） | `PATH` 中找得到的 `claude` / `codex` 各設定一份 |
| `-Uninstall` | 移除整合（除非以 `-Claude`、`-Codex` 或 `-None` 縮小範圍，否則全部移除）、啟動器、使用者 `PATH` 項目與安裝目錄 |
| `-DryRun` | 只列出會做的事，不做任何變更 |
| `-Help` | 使用說明 |

會建立的東西：

- `<Dir>\v0.1.0\`：發行版 zip，SHA-256 與 `SHA256SUMS` 相符後才解壓；以及指向它的 junction `<Dir>\current`。
- `<Dir>\bin\worktree-janitor.cmd`：以安裝時找到的 node 絕對路徑執行（找不到時改用 `PATH` 中的 node）；另有 `<Dir>\bin\worktree-janitor`，是給 Git Bash 用的 sh 啟動器，因為 Git Bash 不加副檔名就找不到 `.cmd` 檔。
- 把 `<Dir>\bin` 附加到**使用者** `PATH`（HKCU，保持 `REG_EXPAND_SZ`，讓 `%變數%` 維持未展開）。新開的終端機才會生效，已開啟的不會。
- 加上 `-Codex` 或 `-Claude` 時：與 [install.mjs](#從-git-clone-安裝scriptsinstallmjs) 相同的整合，指向 `<Dir>\current`。Codex hook 會帶有 `command_windows`。

**執行原則（Execution Policy）：** 兩種 `irm` 寫法都是在記憶體中執行腳本內容，不受執行原則限制。直接執行下載的 `install.ps1` 檔案，在 `Restricted` 與（對下載檔案而言的）`RemoteSigned` 原則下會被擋下，所以只對那一個 `powershell` 處理程序加上 `-ExecutionPolicy Bypass`；你的原則設定不會改變。

**確認：** 在新的終端機執行 `worktree-janitor --help`。

**更新：** 用新的 `-Version` 或 `latest` 的寫法再執行一次。同一版本不會重複下載；新版本會移動 `current`、刪除它先前安裝的舊版本，Codex hook 指令維持不變（不需重新信任），除非 node 路徑改變。

**解除安裝：**

```powershell
& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1))) -Uninstall
```

使用者 `PATH` 項目會被移除，`PATH` 字串會完全恢復原狀。如果安裝在其他位置，請加上 `-Dir`。

### install.sh（macOS、Linux）

POSIX `sh`，絕不使用 sudo。

```
# 指定版本，可加選項（推薦）
curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.sh | sh -s -- --version v0.1.0 --none

# 最新版
curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh

# 已下載的檔案
sh install.sh --version v0.1.0 --codex
```

| 選項 | 作用 |
| --- | --- |
| `--version vX.Y.Z` | 要安裝的版本（預設：從 GitHub API 取得最新版；還沒有任何發行版時會明確報錯） |
| `--dir DIR` | 安裝根目錄（預設 `~/.worktree-janitor`） |
| `--bin-dir DIR` | `worktree-janitor` 啟動器放置的位置（預設 `~/.local/bin`） |
| `--node PATH` | 要使用的 node（預設：`PATH` 中的 node；需 Node.js 18 以上） |
| `--claude`、`--codex`、`--all`、`--none` | 與 install.ps1 的 `-Claude`、`-Codex`、`-All`、`-None` 相同；預設：`PATH` 中找得到的 `claude` / `codex` 各設定一份 |
| `--uninstall` | 移除整合（除非以 `--claude`、`--codex` 或 `--none` 縮小範圍，否則全部移除）、啟動器與安裝目錄 |
| `--dry-run` | 只列出會做的事，不做任何變更 |
| `-h`、`--help` | 使用說明 |

也接受 `--version=vX.Y.Z` 的寫法（`--dir`、`--bin-dir`、`--node` 同樣可以用 `=`）。

會建立的東西：

- `~/.worktree-janitor/v0.1.0/`：發行版 tarball，SHA-256 與 `SHA256SUMS` 相符後才解壓；以及指向它的 symlink `~/.worktree-janitor/current`。
- `~/.local/bin/worktree-janitor`：以安裝時找到的 node 絕對路徑執行的啟動器，找不到時改用 `PATH` 中的 node。macOS 預設不會把 `~/.local/bin` 放進 `PATH`，這時安裝程式會顯示要加進 profile 的那一行。
- 加上 `--codex` 時：如果 `$CODEX_HOME/hooks.json` 存在就寫入其中，否則在 `$CODEX_HOME/config.toml` 中寫入一個有標記的區塊；skill 放在 `~/.agents/skills/clean-worktrees`；規則寫入 `$CODEX_HOME/AGENTS.md`。hook 指向 `~/.worktree-janitor/current/scripts/janitor.mjs`，並優先使用 node 的絕對路徑。
- 加上 `--claude` 時：位於 `~/.worktree-janitor/current` 的本機 marketplace，以及外掛（使用者範圍）。

腳本的所有內容都包在函式裡，只在最後一行呼叫，所以下載不完整時什麼都不會執行。

**確認：** `worktree-janitor --help`；`readlink ~/.worktree-janitor/current`。

**更新：** 再執行一次（最新版）或加上 `--version`。同一版本：不會下載任何東西。新版本：`current` 會移動、刪除它先前安裝的舊版本，Codex hook 指令維持不變（不需重新信任），除非 node 路徑改變；Claude Code 外掛從 `current` 讀取並原地更新。

**解除安裝：** 腳本不在壓縮檔裡，所以要再下載一次：

```
curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh -s -- --uninstall
```

它會移除整合、啟動器，以及只有它自己建立的檔案；安裝目錄清空後才會刪除。空的 `~/.agents/skills` 資料夾會留著。

**環境變數**（兩個安裝程式皆適用）：`HTTPS_PROXY` / `https_proxy` 作為下載用的代理伺服器（絕不顯示出來；install.ps1 會把網址中的帳密轉成 `PSCredential`）；`WORKTREE_JANITOR_BASE_URL`（發行版檔案的鏡像位置：https 網址、`file://` 網址或本機資料夾）；`WORKTREE_JANITOR_API_URL`（取得最新版的 API 端點）；install.ps1 另有 `WORKTREE_JANITOR_NO_USER_PATH=1`（不更動使用者 `PATH`）。

### Homebrew

適用 macOS 與 Linux（Homebrew on Linux）。formula 放在本儲存庫中（`Formula/worktree-janitor.rb`），沒有另外的 tap 儲存庫，所以 tap 時要寫出完整網址：

```
brew tap erictheng93/worktree-janitor https://github.com/erictheng93/worktree-janitor
brew trust erictheng93/worktree-janitor
brew install erictheng93/worktree-janitor/worktree-janitor
```

**`brew trust`。** 新版 Homebrew 在 tap 受信任之前，會拒絕載入第三方 tap 的 formula：「Refusing to load formula erictheng93/worktree-janitor/worktree-janitor from untrusted tap erictheng93/worktree-janitor. Run `brew trust --formula erictheng93/worktree-janitor/worktree-janitor` or `brew trust erictheng93/worktree-janitor` to trust it.」`--formula` 只信任那一個 formula。舊版 Homebrew 沒有 `brew trust` 指令（「Unknown command: brew trust」），也不需要這一步。寫在腳本裡可以用：`brew commands --quiet | grep -qx trust && brew trust erictheng93/worktree-janitor`。

formula 安裝到 `libexec`，相依於 Homebrew 的 `node`，它的 `bin/worktree-janitor` 包裝腳本以絕對路徑執行 `$(brew --prefix)/opt/node/bin/node`，所以 `PATH` 中沒有 node 也能使用。Homebrew 安裝的是 formula 指向的版本；`brew pin worktree-janitor` 可以固定在該版本。

它絕不寫入 Claude Code 或 Codex 的設定。`brew info worktree-janitor` 會顯示 caveats，內含外掛的安裝指令，以及讓 Codex hook 執行 Homebrew 這份程式的指令：

```
$(brew --prefix)/opt/node/bin/node $(brew --prefix)/opt/worktree-janitor/libexec/scripts/install.mjs --codex --node $(brew --prefix)/opt/node/bin/node
```

這些 hook 指向 `opt/` 路徑，所以 `brew upgrade` 之後依然有效。執行 `brew uninstall` 之前，請先加上 `--uninstall` 執行同一個指令。

**確認：** `worktree-janitor --help`；`brew test worktree-janitor`。

**更新：** `brew update && brew upgrade worktree-janitor`。

**解除安裝：** `brew uninstall worktree-janitor && brew untap erictheng93/worktree-janitor`。

### 發行版壓縮檔

[Releases 頁面](https://github.com/erictheng93/worktree-janitor/releases)上的每個發行版都包含：

| 檔案 | 內容 |
| --- | --- |
| `worktree-janitor-vX.Y.Z.tar.gz` | 執行所需的檔案（腳本、hook、skill、外掛 manifest、整合範本、文件），位於 `worktree-janitor-vX.Y.Z/` 之下 |
| `worktree-janitor-vX.Y.Z.zip` | 內容相同，給 Windows 使用 |
| `install.sh`、`install.ps1` | 安裝程式 |
| `SHA256SUMS` | 上面四個檔案的 SHA-256 |

每個檔案也都附有 GitHub 建置來源證明（build provenance attestation）。發布流程會建置兩次，結果必須逐位元組相同才會發布。

用瀏覽器或 `gh release download v0.1.0 -R erictheng93/worktree-janitor` 下載，然後驗證：

```
# Linux
grep ' worktree-janitor-v0.1.0.tar.gz$' SHA256SUMS | sha256sum -c -
# macOS
grep ' worktree-janitor-v0.1.0.tar.gz$' SHA256SUMS | shasum -a 256 -c -
# 建置來源，任何作業系統（需要 gh）
gh attestation verify worktree-janitor-v0.1.0.tar.gz -R erictheng93/worktree-janitor
```

```powershell
# Windows PowerShell 5.1 或 7：雜湊值相符時顯示 True
$f = 'worktree-janitor-v0.1.0.zip'
$want = ((Get-Content SHA256SUMS) | Where-Object { $_.EndsWith("  $f") }).Split(' ')[0]
(Get-FileHash $f -Algorithm SHA256).Hash -eq $want
Expand-Archive $f -DestinationPath .
```

解壓到任何位置後，執行 `node worktree-janitor-v0.1.0/scripts/janitor.mjs`，或用其中的 `scripts/install.mjs` 設定 hook（見下一節）；hook 會指向那個資料夾，所以之後請不要搬動它。

### 從 git clone 安裝：scripts/install.mjs

安裝程式在 clone（或解壓後的發行版）中執行，所有設定都指向**該資料夾**的 `scripts/janitor.mjs`，所以請把它留在原處（搬移後需重新安裝）。`install.sh` 與 `install.ps1` 執行的就是 `<dir>/current` 中的這支腳本。

```
git clone https://github.com/erictheng93/worktree-janitor.git
cd worktree-janitor
node scripts/install.mjs --all --dry-run
```

| 選項 | 作用 |
| --- | --- |
| `--claude` | Claude Code：透過 `claude` CLI，把這個資料夾加為本機 marketplace `worktree-janitor-marketplace`，並以使用者範圍安裝外掛。只執行尚未完成的步驟。`claude` 不在 `PATH` 中時顯示訊息並略過 |
| `--codex` | Codex：hook、skill 與 `AGENTS.md` 規則（見下方） |
| `--all` | 同時 `--claude` 與 `--codex` |
| `--uninstall` | 只移除安裝程式加入的內容，其他一概不動 |
| `--dry-run` | 列出所有預計的變更，不寫入任何東西 |
| `--root <dir>` | hook 與 marketplace 要指向的 worktree-janitor 資料夾（預設：腳本所在的資料夾，照啟動時的路徑，不解析 symlink） |
| `--node <path>` | Codex hook 優先嘗試的 node 絕對路徑（預設：執行安裝程式的那個 node）；`PATH` 中的 node 與常見安裝位置作為備援 |
| `-h`、`--help` | 使用說明 |

沒有 `--claude`、`--codex` 或 `--all` 時，會顯示使用說明並以 2 結束。

`--codex` 寫入的內容（`$CODEX_HOME` 預設為 `~/.codex`）：

| 目標 | 內容 |
| --- | --- |
| `$CODEX_HOME/hooks.json`（若該檔案已存在） | 兩組 hook；已存在就原地取代，否則附加在後。既有的群組絕不移動，因為 Codex 的信任鍵與位置有關 |
| 否則為 `$CODEX_HOME/config.toml` | 相同的 hook，以 `[[hooks.*]]` 表格寫在 `# >>> worktree-janitor >>>` ... `# <<< worktree-janitor <<<` 區塊內 |
| `~/.agents/skills/clean-worktrees/SKILL.md` 與 `agents/openai.yaml` | `$clean-worktrees` skill，只能明確呼叫 |
| `$CODEX_HOME/AGENTS.md` | 一段有標記的規則，要求 Codex 絕不直接執行 `git worktree remove`，改用 janitor |

每個 hook 都有 `command`（macOS/Linux）與 `command_windows`，先嘗試 `--node` 指定的路徑，再依 [Codex 外掛](#codex-外掛)相同的順序尋找。Codex 會合併 `hooks.json` 與 `config.toml` 內的 `[hooks]` 表格，但只要同一層設定同時使用兩者，每次啟動工作階段都會警告，所以安裝程式會沿用你已經在用的那一種。

行為細節：

- 冪等：再執行一次會顯示 `ok ... (already installed)` 且不重寫任何檔案，已信任的 hook 會維持信任。
- 第一次修改既有檔案之前，會把原始內容存成 `<file>.worktree-janitor.bak`（只存一次）。解除安裝時，若檔案沒有其他變動就還原成完全相同的原始內容，刪除它建立的檔案，並移除備份。
- Codex 自己插入在標記區塊內的表格（hook 信任項目）在重新安裝與解除安裝時都會保留。
- 以下情況會拒絕並且不寫入：`hooks.json` 不是有效的 JSON；`config.toml` 已用靜態陣列定義 hook（`SessionStart = [...]` 或 `hooks = {...}`，再加表格會讓 TOML 失效）；已存在一個不是由它安裝的 `clean-worktrees` skill；標記區塊被手動修改過。
- `--codex` 發現 worktree-janitor 的 Codex 外掛也已啟用時會發出警告：hook 會執行兩次。
- 名為 `worktree-janitor-marketplace` 的 marketplace 已經來自其他地方（GitHub marketplace 或其他資料夾）時，`--claude` 會略過，不做任何變更；若要改用這個資料夾，請先移除那一個。已安裝外掛的版本與這個資料夾不同時，會先更新 marketplace 再更新外掛。`--claude --uninstall` 同樣不會動到來自其他來源的外掛。
- 在 Windows 上，hook 指令以雙引號包住路徑；若路徑含有 `$`、反引號、`"` 或排版用引號，則改用單引號（Codex 在 Windows 上以 PowerShell 執行 hook 指令，其他平台則用 `sh`）。
- 結束代碼：成功為 0，任一步驟失敗為 1，用法錯誤為 2。

執行 `--codex` 之後，請啟動 Codex 並信任這兩個 hook（啟動時的提示或 `/hooks`）。hook 指令有變動時（例如從其他路徑或用其他 node 重新安裝），需要重新信任。

### 用範本手動設定 Codex

`integrations/codex/` 內有與安裝程式寫入內容完全相同的 hook，路徑使用佔位字串 `/path/to/worktree-janitor`：

- [`integrations/codex/config.toml`](../integrations/codex/config.toml)：把佔位字串換成你的 clone 的絕對路徑（Windows 上也可以用正斜線），然後把 `# >>> worktree-janitor >>>` 那一行起的所有內容附加到 `$CODEX_HOME/config.toml`。有了這些標記，日後可用 `node scripts/install.mjs --codex --uninstall` 移除。
- [`integrations/codex/hooks.json`](../integrations/codex/hooks.json)：如果你的 hook 已經放在 `$CODEX_HOME/hooks.json`，改用這個檔案，把其中兩組 hook 合併進你的檔案。

兩個檔案擇一使用，不要同時使用，之後在 Codex 中信任這些 hook。

### 純命令列

不需要安裝：clone 此儲存庫、解壓發行版壓縮檔（或只複製沒有任何相依套件的 `scripts/janitor.mjs`），以 Node.js 18 以上或 Bun 執行：

```
node scripts/janitor.mjs --repo /path/to/repo
bun scripts/janitor.mjs --repo /path/to/repo
```

install.sh、install.ps1 或 Homebrew 裝的 `worktree-janitor` 指令就是同一支腳本，參數也相同。

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
| `locked by a live Claude Code process (pid N)` | 執行中的 Claude Code 工作階段或子代理正在使用 | 等它結束；處理程序結束後就會被清理 |
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
| `CODEX_HOME` | `install.mjs`、`install.sh`、`install.ps1` | Codex 設定資料夾（預設 `~/.codex`） |
| `HTTPS_PROXY`、`https_proxy` | `install.sh`、`install.ps1` | 下載用的代理伺服器；絕不顯示出來 |
| `WORKTREE_JANITOR_BASE_URL` | `install.sh`、`install.ps1` | 發行版檔案的位置，用來取代 GitHub 發行版（鏡像）：https 網址、`file://` 網址或本機資料夾 |
| `WORKTREE_JANITOR_API_URL` | `install.sh`、`install.ps1` | 取得最新版的端點，用來取代 GitHub API |
| `WORKTREE_JANITOR_NO_USER_PATH` | `install.ps1` | `1`：不要把啟動器資料夾加到使用者 `PATH` |
| `JANITOR_GH` | `janitor.mjs` | 取代 `gh` 執行的指令，用於不在 `PATH` 中的 `gh`。以 `.js`、`.mjs` 或 `.cjs` 結尾的路徑會用目前的 Node.js/Bun 執行檔執行。測試以此指向假的 `gh` |
| `JANITOR_CLAUDE` | `install.mjs` | 取代 `PATH` 中 `claude` 的指令（`.js`/`.mjs`/`.cjs` 以 Node.js 執行）。供測試使用 |
| `JANITOR_RUNTIME` | 測試 | 測試中執行 `janitor.mjs` 的執行檔，例如 `bun`。測試執行器本身一律是 Node.js |
| `JANITOR_REQUIRE_MOUNT_TESTS` | 測試 | 設定後，若 Linux 掛載點測試會被略過，則有一個測試會失敗（CI 在 Ubuntu 上設定此值） |
| `JANITOR_TEST_FOREIGN_DEV_AT` | `janitor.mjs`，僅供測試 | 讓指定的資料夾在刪除程序清空它之後回報不同的裝置，以便不需 root 就能測試刪除中途停止。**一般使用時絕對不要設定**：它會讓刪除中途停止 |

janitor 執行 git 與 gh 時會設定 `GIT_TERMINAL_PROMPT=0`、`GH_PROMPT_DISABLED=1` 與 `GCM_INTERACTIVE=never`，所以不會有任何認證提示卡住 hook。

## 平台說明

### 支援的平台

以下皆在 CI 中測試（GitHub 代管的 runner 與容器）：

| 平台 | janitor 測試套件 | 安裝程式與外掛 |
| --- | --- | --- |
| Windows Server 2022（build 20348，Windows 10 21H2 核心），x64 | Node.js 18、20、22；NTFS 磁碟區掛載點 | `install.ps1`，分別在 Windows PowerShell 5.1 與 PowerShell 7 下執行 |
| Windows Server 2025（build 26100，Windows 11 24H2 核心），x64 | Node.js 18、20、22；NTFS 磁碟區掛載點與 Dev Drive | `install.ps1`（5.1 與 7）；Claude Code 與 Codex 外掛（真實的 CLI） |
| Windows 11，arm64 | Node.js 20、22（Node.js 18 沒有該平台的版本） | - |
| macOS 15 與 macOS 26，arm64 | Node.js 18、20、22；APFS 與 HFS+ 磁碟映像檔 | macOS 15：`install.sh`、Homebrew、Claude Code 與 Codex 外掛 |
| macOS 15，Intel | Node.js 18、20、22 | `install.sh` |
| Ubuntu 24.04（runner） | Node.js 18、20、22、Bun；bind mount 與 tmpfs | `install.sh`、Linux 上的 Homebrew、Claude Code 與 Codex 外掛 |
| Debian 11 / 12、Ubuntu 20.04 / 22.04 / 24.04（容器） | 以 root 執行（含掛載測試），以及以沒有 sudo 的一般使用者執行 | Debian 12 上不用 sudo 執行 `install.sh` |
| Rocky Linux 8 / 9、AlmaLinux 8、RHEL UBI 8 / 9、CentOS Stream 9 / 10（容器） | 以 root 執行（含掛載測試），以及以沒有 sudo 的一般使用者執行 | Rocky Linux 9 上不用 sudo 執行 `install.sh` |
| CentOS 7 | 不支援：git 1.8.3 沒有 `git worktree`。手動執行會以 1 結束並顯示 `git 2.7 or newer is required`，hook 則安靜地以 0 結束，不會刪除任何東西 | - |

每個容器都使用該發行版自己的 git（2.25.1 到 2.52）、util-linux，以及版本達 18 以上時它自己的 Node.js。容器共用 Ubuntu runner 的核心，所以沒有任何一個處於 SELinux 強制模式：Red Hat 映像檔測試的是 RHEL 的使用者空間，而不是 RHEL 的核心或 SELinux 政策。掛載測試使用真實的掛載，若會被略過就讓 CI 失敗：掛載到資料夾的 VHDX 磁碟區（Windows）、`hdiutil` 磁碟映像檔（macOS）、`mount --bind` 與 tmpfs（Linux），並逐一確認掛載的資料完好無缺。

### Windows

- **Junction：** Node.js 與 Bun 會把 NTFS junction 回報為符號連結。仍能 `readlink` 的資料夾也會被當作連結。移除連結時依序嘗試 unlink、`rmdir`（不加 `/s`），最後才用 `cmd /c rmdir`；每一種都只移除連結本身。
- **長路徑：** 所有檔案操作都使用 `\\?\` 路徑，所以深度超過 `MAX_PATH`（260 個字元）的 worktree（`node_modules` 很常見）也能正確刪除。
- **大小寫：** 路徑先解析為實際路徑，再以不分大小寫的方式比較。
- **掛載的磁碟區：** 掛載到資料夾的磁碟區（NTFS、ReFS 或 Dev Drive）在 `lstat` 中不會被回報為連結，但它的裝置 ID 與 worktree 不同，所以裝置 ID 檢查會以 `contains mount point` 保留該 worktree。已在 CI 中以 Windows Server 2022 與 2025 上的 VHDX 磁碟區驗證。
- **使用中的檔案：** Windows 無法刪除被其他處理程序開啟的檔案，也無法刪除某個處理程序的目前目錄；兩者都會讓刪除停止（`partial`）。
- **PowerShell 5.1** 會在管線輸入的 stdin 加上 BOM；janitor 會去除它。
- checkout 中的**檔案 symlink** 需要開發人員模式或系統管理員權限，且 `core.symlinks=false` 時 git 會把它們 checkout 成一般文字檔。junction 不需要特殊權限。
- Codex 透過 `powershell.exe -NoProfile -Command` 執行 hook 指令；安裝程式的引號處理已考慮這點。

### macOS

- `/var` 與 `/tmp` 是指向 `/private` 的符號連結。git 輸出的是實際路徑，hook payload 卻不一定，所以所有比較都先解析實際路徑；已不存在的路徑則透過最近一個仍存在的上層資料夾解析。
- APFS 預設不分大小寫，但也可以格式化為區分大小寫，因此路徑解析後以完全相同的方式比較，並以裝置與 inode 比對作為第二道檢查。誤判只會讓 worktree 被保留。
- 掛載的磁碟區由裝置 ID 檢查偵測；macOS 沒有 mountinfo。已在 CI 中以掛載在 worktree 內的 APFS 與 HFS+ 磁碟映像檔驗證。

### Linux

- 掛載點讀取自 `/proc/self/mountinfo`（第 5 個欄位，並解碼 `\040` 等八進位跳脫字元）。若該檔案無法讀取或沒有列出任何項目，所有候選 worktree 都會被保留。
- 檔案系統視為區分大小寫：`/src/Wt` 與 `/src/wt` 是不同的資料夾。
- 如果啟動 janitor 時所在的資料夾已被刪除（例如 hook 在剛移除的 worktree 中觸發），只要給了絕對路徑的 `--repo`（或 hook payload 中的 `cwd` 為絕對路徑）仍可執行。否則手動執行會以 1 結束並顯示 `current directory no longer exists; pass an absolute --repo`，hook 則安靜地以 0 結束。（Windows 無法刪除處理程序的工作目錄，所以不會發生這種情況。）

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
| `install.ps1`（Windows） | `& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1))) -Uninstall` |
| `install.sh`（macOS、Linux） | `curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh \| sh -s -- --uninstall` |
| Homebrew | `brew uninstall worktree-janitor && brew untap erictheng93/worktree-janitor`（如果照 `brew info` 加了 Codex hook，先用 `--codex --uninstall` 移除） |
| 純命令列、發行版壓縮檔 | 刪除 clone 或解壓出來的資料夾 |

安裝程式解除安裝時，若 `worktree-janitor-marketplace` 來自其他地方（GitHub marketplace 或其他資料夾），會保持不動並提示。

## 疑難排解

### Hook 沒有執行

- **Codex：hook 未受信任。** 開啟 `/hooks`（桌面版 App：「Settings > Hooks」），信任兩個 worktree-janitor hook。`codex exec` 會安靜地略過未受信任的 hook。每次更新外掛之後，以及從其他路徑或用其他 node 重新安裝安裝程式的 hook 之後，都必須重新信任。
- **外掛未啟用。** `claude plugin list` 或 `codex plugin list` 應顯示它已安裝且已啟用。安裝後請重新啟動代理程式。
- **`node` 不在 `PATH` 中（Claude Code）。** Claude Code 外掛的 hook 直接以名稱執行 `node`。請在代理程式啟動的環境中確認 `node --version`：從 Dock 或「開始」功能表啟動的桌面版 App 可能看不到 shell 的 `PATH`（見 [Claude Code 外掛](#claude-code-外掛)）。Codex 的 hook 還會到常見的安裝位置尋找，但 nvm、asdf、mise 與 `n` 安裝的 node 只能透過 `PATH` 找到。
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

如果 Codex 中每則摘要都出現兩次，代表外掛與安裝程式寫入的 hook（來自 `install.sh`、`install.ps1`、`install.mjs` 或 Homebrew `brew info` 中的指令）同時生效。移除其中一個（[解除安裝](#解除安裝)）。

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

- **實體機器：** 所有平台都只透過 CI（GitHub 代管的 runner 與容器）驗證，沒有在實體硬體上驗證過。
- **SELinux** 強制模式沒有測試過；RHEL 系列的容器跑在 Ubuntu runner 的核心上。
- **git 早於 2.7**（CentOS 7 內建 1.8.3）會被拒絕。測試過最舊的 git 是 2.25.1。
- **Claude Code 外掛的 hook 需要 `node` 在 Claude Code 處理程序的 `PATH` 中**；從 Dock 或「開始」功能表啟動的桌面版 App 可能沒有。曾考慮用 `userConfig` 選項指定 node 路徑，但已放棄：Claude Code 不會為 hook 套用預設值，每位使用者都得先設定才能讓 hook 運作。
- **Codex hook 的備援搜尋** 涵蓋 `PATH`、Homebrew、Volta 與 fnm；nvm、asdf、mise 與 `n` 只能透過 `PATH`（安裝程式寫入的 hook 另外會嘗試安裝時記錄的 node 絕對路徑）。在 Windows 上若兩種 PowerShell 都沒有，Codex 會改用 `cmd.exe /c`，而它無法執行 `command_windows`。
- **每次更新 Codex 外掛後都必須重新信任 hook**（Codex 會對外掛的所有檔案計算雜湊值）；安裝程式寫入的 hook 只有在指令文字改變時才需要。
- **`install.sh --uninstall`** 需要再下載一次腳本；它不在安裝的檔案中。
- **Homebrew 安裝的是 formula 指向的那個版本**，沒有各版本專屬的 formula。要停留在某個版本請用 `brew pin`。
- **btrfs 子磁碟區、overlayfs 等** 可能讓同一檔案系統上的資料夾回報不同的裝置 ID。這種 worktree 會以 `contains mount point` 被保留：是誤判，但是安全的誤判。
- **Fast-forward 合併** 在 git 歷史中與新分支無從區分，只能透過 `gh` 偵測。
- **本身含有 merge commit 的分支**（例如曾把基底合併進該分支）可能無法被 `git cherry` 辨識，需要 `gh`。
- **只有 `gh pr merge` 會觸發 post-tool hook。** 在其他地方完成的合併（網頁介面、其他工具、隊友）會在下次工作階段開始或手動執行 janitor 時處理。
- Squash 偵測要求 PR 的 head 提交等於本機分支的最新提交，每個分支最多查看 30 個已合併的 PR，且只適用於 GitHub 儲存庫。
- Hook 執行限制在約 20 秒內；非常大的 worktree 可能需要好幾個工作階段，或手動執行。
- 只會 fetch 名為 `origin` 的遠端。

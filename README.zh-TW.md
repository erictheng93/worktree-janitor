[English](README.md) | 繁體中文

# worktree-janitor

自動移除已合併的 git worktree 與本機分支，而且絕不會穿過連結或掛載點刪到別的地方。可作為 Claude Code 或 Codex CLI 外掛自動執行，也能在任何終端機手動執行。

## 解決什麼問題

- **已合併的 worktree 越積越多。** 程式開發代理程式會為每個任務或子代理建立一個 worktree（與一個分支）。pull request 合併後，worktree 資料夾、它的分支以及 Claude Code 的 `worktree-*` 附屬分支都還留在原地。
- **`git worktree remove` 可能刪到 worktree 以外的檔案。** 在 Windows 上，git 的遞迴刪除會跟隨 NTFS junction。如果 worktree 裡的 `node_modules`（或 Rust 的 `target`、Python 虛擬環境等）是指向主要 checkout 的 junction，移除 worktree 時主要 checkout 裡的那份也會一起被刪掉。
- **worktree 裡的掛載點。** 在任何作業系統上，遞迴刪除都會進入 worktree 內的 bind mount、tmpfs 或掛載的磁碟區，先把掛載來源（位於儲存庫之外）清空，最後才因「Device or resource busy」失敗。

worktree-janitor 從不呼叫 `git worktree remove`。它自己刪除 worktree：遇到連結只解除連結、不跟隨；含有掛載點的 worktree 一律不刪；遇到任何意外立即停止。

## 功能

- 移除分支已合併進基底分支的 worktree：merge commit、rebase 合併（`git cherry`）或 squash 合併（透過 `gh`，選用）。
- 刪除已合併的本機分支，以及 Claude Code 的 `worktree-*` 附屬分支。
- 預設為試跑（dry run）；加上 `--apply` 才會動作。`--json` 供程式讀取。
- 無法證明安全的一律保留：有修改或未追蹤的檔案、detached HEAD、仍有效的鎖定、沒有提交的新分支、submodule、掛載點、主要 worktree，以及你目前所在的 worktree。
- 每個保留決定都附一行原因。
- Hook 在工作階段開始時與 `gh pr merge` 之後執行；執行時間限制在約 20 秒內，且絕不會讓你的工作階段失敗。
- 單一、無相依套件的腳本（只用 Node.js 標準函式庫），因此適用於任何程式語言的儲存庫。

## 支援的平台與代理程式

| 需求 | 說明 |
| --- | --- |
| 作業系統 | Windows、macOS、Linux（CI 三者都測試） |
| 執行環境 | Node.js 18 以上，或 Bun |
| git | 必要，需在 `PATH` 中 |
| gh（GitHub CLI） | 選用。只有辨識 squash 合併（以及少數其他情況，見[使用手冊](docs/manual.zh-TW.md#分支如何算已合併)）時需要 |

| 代理程式 | 整合方式 |
| --- | --- |
| Claude Code | 外掛：`SessionStart` + `PostToolUse` hook，以及 `/worktree-janitor:clean-worktrees` 指令 |
| Codex CLI | 外掛或安裝程式：`SessionStart` + `PostToolUse` hook，以及 `$clean-worktrees` skill |
| 其他任何工具 | 自行執行 `node scripts/janitor.mjs`，可從終端機、腳本或其他工具的 hook 呼叫 |

## 快速開始

以下指令中的 `OWNER` 是發布此儲存庫的 GitHub 帳號或組織，請換成該名稱。

### Claude Code

```
claude plugin marketplace add OWNER/worktree-janitor
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

預設安裝範圍是使用者層級（user scope），因此對所有專案生效。安裝後請重新啟動 Claude Code。之後可以執行 `/worktree-janitor:clean-worktrees` 進行互動式試跑，或什麼都不做：hook 會在下次工作階段開始時以及每次 `gh pr merge` 之後自動清理。

### Codex CLI

以下兩種方式**只能擇一**。絕對不要同時使用：兩者會註冊相同的兩個 hook，每個 hook 都會執行兩次。

**方式 A：外掛**

```
codex plugin marketplace add OWNER/worktree-janitor
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

**方式 B：安裝程式**（hook 指向你自己的 clone）

```
git clone https://github.com/OWNER/worktree-janitor.git
cd worktree-janitor
node scripts/install.mjs --codex --dry-run   # 預覽
node scripts/install.mjs --codex
```

接著啟動 Codex 並**信任這些 hook**：Codex 會在啟動時詢問，或開啟 `/hooks` 設定。未受信任的 hook 永遠不會執行。skill 需明確呼叫：`$clean-worktrees`。

### 其他工具或不使用代理程式

```
git clone https://github.com/OWNER/worktree-janitor.git
node worktree-janitor/scripts/janitor.mjs --repo /path/to/your/repo           # 試跑
node worktree-janitor/scripts/janitor.mjs --repo /path/to/your/repo --apply   # 實際執行
```

## 判斷規則

由上而下，第一條符合的規則生效。worktree 必須通過所有檢查才會被移除。

| Worktree | 結果 |
| --- | --- |
| 主要 worktree，或 bare 儲存庫項目 | 保留 |
| 被執行中的 Claude Code 程序鎖定，或被其他人鎖定 | 保留（可用 `--include-locked` 覆寫） |
| 被已結束的 Claude Code 程序鎖定 | 鎖定已失效，繼續判斷 |
| 資料夾已不存在 | 清除（prune）註冊資訊 |
| Detached HEAD | 保留 |
| 包含主要 worktree 或目前的工作目錄 | 保留 |
| 有修改或未追蹤的檔案（`git status` 不為空） | 保留 |
| 分支未合併進基底，或領先 0 個提交且從未合併 | 保留 |
| 有已初始化的 submodule，或 submodule 的 git 資料夾 | 保留 |
| 含有掛載點，或有無法讀取的資料夾 | 保留 |
| 以上全部通過 | 移除（內部的連結只解除連結，目標不受影響） |

| 分支 | 結果 |
| --- | --- |
| 基底分支，或名為 `main`、`master`、`develop`、`trunk` | 保留 |
| 仍被保留中的 worktree checkout | 保留 |
| 已合併進基底 | 刪除 |
| `worktree-*` 且領先 0 個提交、未被任何 worktree checkout | 刪除 |
| 其他 | 保留 |

完整細節（包含每一種原因字串及處理方式）請見[使用手冊](docs/manual.zh-TW.md#保留原因與處理方式)。

## 安全保證

- **預設試跑。** 沒有 `--apply` 就不會更動任何 worktree 或分支（hook 模式隱含 `--apply`）。試跑唯一會更新的是遠端追蹤參照（remote-tracking refs），來自 `git fetch --prune origin`。
- **絕不跟隨連結。** 每個 symlink 或 junction 都只解除連結，之後再確認目標仍然存在。
- **絕不刪進掛載點。** 刪除任何東西之前先檢查掛載點（Linux 透過 `/proc/self/mountinfo`，所有作業系統都比對裝置 ID），刪除過程中每個資料夾都會再檢查一次。
- **失敗即停止（fail closed）。** 遇到任何意外立即停止，不再刪除任何東西，並回報停止位置（`partial`）。worktree 的 `.git` 檔案最後才刪，所以中途停止的 worktree 仍會在 git 中保持註冊。
- **絕不卸載、絕不強制移除**，也絕不碰主要 worktree 或遠端分支。
- **Hook 絕不破壞工作階段。** 永遠以 0 結束，除非有東西被移除，否則不輸出任何訊息。

## 適用任何程式語言

worktree-janitor 只與 git（以及選用的 `gh`）溝通，不讀取專案檔案，所以 Rust、Python、Go、Java 或任何其他語言的儲存庫都不需要額外設定。Node.js（或 Bun）只用來執行腳本本身。共用的 `target` 或 `.venv` junction 這類語言特有的連結，正是它設計來安全處理的情況。

## 文件

- [使用手冊](docs/manual.zh-TW.md)：概念、所有選項、hook payload、報告格式、結束代碼、平台說明、疑難排解、常見問題、已知限制
- [變更紀錄](CHANGELOG.md)

## 參與貢獻

歡迎到 `https://github.com/OWNER/worktree-janitor` 回報問題或送出 pull request。

```
npm test
```

測試會在系統暫存資料夾下建立拋棄式儲存庫，只需要 Node.js 18 以上與 git。在 Linux 上，掛載點測試只有以 root 身分或在可免密碼使用 `sudo` 時才會執行，否則略過；設定 `JANITOR_REQUIRE_MOUNT_TESTS=1` 可讓略過變成失敗。`JANITOR_RUNTIME=bun npm test` 會以 Bun 執行每次 janitor 呼叫。請讓腳本維持零相依套件。

## 授權條款

[MIT](LICENSE)

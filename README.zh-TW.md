[English](README.md) | 繁體中文

# worktree-janitor

自動移除已合併的 git worktree 與本機分支，而且絕不會穿過連結或掛載點刪到別的地方。可作為 Claude Code 或 Codex 外掛自動執行，也能在任何終端機手動執行。

- [安裝](#安裝)：[推薦方式](#推薦方式)、[事前準備](#事前準備)、[所有安裝管道](#所有安裝管道)
- [平台支援](#平台支援)
- [解決什麼問題](#解決什麼問題)、[判斷規則](#判斷規則)、[安全保證](#安全保證)
- [使用手冊](docs/manual.zh-TW.md)、[變更紀錄](CHANGELOG.md)

## 安裝

### 推薦方式

選擇符合你的情況即可。以下每段指令都會安裝 `v0.1.0` 版。

**你使用 Claude Code**（CLI 或桌面版 App）：從 GitHub marketplace 安裝外掛，並固定在發行版標籤。

```
claude plugin marketplace add erictheng93/worktree-janitor@v0.1.0
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

安裝後重新啟動 Claude Code。CLI 與桌面版 App 共用同一份設定，所以一次就涵蓋兩者。

**你使用 Codex**（CLI 或桌面版 App）：用 `--ref` 固定版本安裝外掛，然後信任它的 hook。

```
codex plugin marketplace add erictheng93/worktree-janitor --ref v0.1.0
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

啟動 Codex，信任 worktree-janitor 的兩個 hook：CLI 用 `/hooks`（或啟動時的提示），桌面版 App 在「Settings > Hooks」。未受信任的 hook 永遠不會執行。

**兩者都沒用，或只想要命令列工具**：

macOS 或 Linux，使用 Homebrew：

```
brew tap erictheng93/worktree-janitor https://github.com/erictheng93/worktree-janitor
brew trust erictheng93/worktree-janitor
brew install erictheng93/worktree-janitor/worktree-janitor
```

新版 Homebrew 在執行 `brew trust` 之前會拒絕載入第三方 tap；舊版 Homebrew 沒有這個指令，會回應「Unknown command: brew trust」，忽略即可。

Windows，在 PowerShell 中執行（Windows PowerShell 5.1 或 PowerShell 7 皆可）：

```powershell
& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.ps1))) -Version v0.1.0 -None
```

開一個新的終端機視窗，執行 `worktree-janitor --help` 確認。

**為什麼推薦這幾種。** 每一種都安裝固定的發行版：外掛固定在標籤上；PowerShell 安裝程式下載該發行版的壓縮檔，SHA-256 與發布的 `SHA256SUMS` 不符就拒絕安裝；Homebrew 會檢查 formula 裡的 sha256。全部都不需要 sudo 或系統管理員權限，也都有一行指令就能完成的更新方式（見下文）。外掛還內含 hook 以及 `/worktree-janitor:clean-worktrees` 指令（Claude Code）或 `$clean-worktrees` skill（Codex），不必自己管理本機檔案。

**每個工具只用一種安裝管道。** 尤其是 Codex：絕對不要把外掛和安裝程式寫入的 hook（`install.sh --codex`、`install.ps1 -Codex`、`install.mjs --codex`）同時使用，兩者會註冊相同的兩個 hook，每個 hook 都會執行兩次。安裝程式發現外掛已啟用時會發出警告；對於從其他管道安裝的 Claude Code 外掛，則一律不動。

### 事前準備

worktree-janitor 需要 **Node.js 18 以上** 與 **git**，且都要在 `PATH` 中。`gh`（GitHub CLI）為選用，只用來辨識 squash 合併。

| 作業系統 | 安裝 Node.js 與 git |
| --- | --- |
| Windows | `winget install OpenJS.NodeJS.LTS` 與 `winget install Git.Git` |
| macOS | `brew install node git`（或用 nodejs.org 的安裝程式；Xcode Command Line Tools 內含 git） |
| Debian 12、Ubuntu 24.04 | `sudo apt-get install nodejs git`（內建 Node.js 18） |
| Debian 11、Ubuntu 20.04 / 22.04 | `sudo apt-get install git`，Node.js 另從 nodejs.org 或 NodeSource 安裝（系統套件版本太舊） |
| RHEL / Rocky / Alma 8 與 9、CentOS Stream 9 | `sudo dnf install git` 與 `sudo dnf module install nodejs:20/common` |
| CentOS Stream 10、Fedora | `sudo dnf install nodejs git` |

Homebrew 會自動把 Node.js 當成相依套件安裝。`install.sh` 另外需要 `curl` 或 `wget`、`tar`，以及 `sha256sum`、`shasum`、`openssl` 其中之一，原生的 macOS、Debian、Ubuntu 與 RHEL 系列都已內建。`install.ps1` 只需要 Windows PowerShell 5.1。

### 所有安裝管道

| 管道 | 適用 | 更新方式 | 章節 |
| --- | --- | --- | --- |
| Claude Code 外掛 | Claude Code CLI 與桌面版 App | 改用新的標籤 | [Claude Code](#claude-code-外掛) |
| Codex 外掛 | Codex CLI 與桌面版 App | 改用新的標籤，並重新信任 hook | [Codex](#codex-外掛) |
| `install.ps1` | Windows（命令列工具，可選擇加裝 hook） | 再執行一次 | [PowerShell](#windowspowershellinstallps1) |
| Homebrew | macOS、Linux（命令列工具） | `brew upgrade` | [Homebrew](#homebrewmacoslinux) |
| `install.sh` | macOS、Linux（命令列工具，可選擇加裝 hook） | 再執行一次 | [curl](#macoslinuxcurlinstallsh) |
| 發行版壓縮檔 | 任何作業系統、腳本、離線環境 | 重新下載 | [手動下載](#手動下載) |
| git clone + `install.mjs` | 貢獻者 | `git pull` | [從 git clone 安裝](#從-git-clone-安裝) |

#### Claude Code 外掛

終端機（Claude Code CLI）：

```
claude plugin marketplace add erictheng93/worktree-janitor@v0.1.0
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

也接受 `owner/repo#v0.1.0` 的寫法。Claude Code 2.1.292 以上還能用一行完成：`claude plugin install worktree-janitor --marketplace erictheng93/worktree-janitor@v0.1.0`。外掛安裝在使用者層級（user scope），對所有專案生效，過程中不會詢問任何問題。

桌面版 App：在終端機執行上面兩行指令即可，App 讀取的是同一份 `~/.claude` 設定，裝完重新啟動 App。hook 直接以名稱呼叫 `node`，所以 App 本身看得到的 `PATH` 裡必須有 node。從 Dock 或「開始」功能表啟動的 App 不一定會繼承 shell 的 `PATH`；如果 hook 在 App 裡沒有執行，請把 Node.js 安裝成全系統可用（例如 nodejs.org 的安裝程式或 `winget`），或從終端機啟動 App。

- **確認：** `claude plugin list` 會列出 `worktree-janitor@worktree-janitor-marketplace`，版本 `0.1.0`；在工作階段中可以使用 `/worktree-janitor:clean-worktrees`。
- **更新：** `claude plugin marketplace update` 會停留在原本固定的標籤，所以要改掉固定的標籤，然後重新啟動：
  ```
  claude plugin marketplace remove worktree-janitor-marketplace
  claude plugin install worktree-janitor --marketplace erictheng93/worktree-janitor@v0.2.0
  ```
- **解除安裝：**
  ```
  claude plugin uninstall worktree-janitor@worktree-janitor-marketplace
  claude plugin marketplace remove worktree-janitor-marketplace
  ```

#### Codex 外掛

終端機（Codex CLI）：

```
codex plugin marketplace add erictheng93/worktree-janitor --ref v0.1.0
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

（也可以寫成 `erictheng93/worktree-janitor@v0.1.0`。）接著啟動 `codex`，在 `/hooks` 或啟動時的提示中，信任 worktree-janitor 的 SessionStart 與 PostToolUse 兩個 hook。`codex exec` 會默默略過未受信任的 hook。

桌面版 App：在終端機執行相同的指令（App 與 CLI 共用 `CODEX_HOME`，預設為 `~/.codex`），再到「Settings > Hooks」信任這兩個 hook。

外掛的 hook 不需要 `node` 在 `PATH` 中：在 macOS/Linux 上還會到 `/opt/homebrew/bin`、`/usr/local/bin`、Volta 以及 fnm 的預設 alias 尋找，在 Windows 上會找 `%ProgramFiles%\nodejs`。nvm、asdf、mise 與 `n` 安裝的 node 只能透過 `PATH` 找到。

- **確認：** `codex plugin list` 會列出已啟用的 `worktree-janitor@worktree-janitor-marketplace`，版本 `0.1.0`；`/hooks` 會列出它的兩個 hook；skill 是 `$clean-worktrees`（只能明確呼叫）。
- **更新：** 用另一個 `--ref` 再次加入 marketplace 會失敗（「already added from a different source」），所以要先移除再重新加入：
  ```
  codex plugin remove worktree-janitor@worktree-janitor-marketplace
  codex plugin marketplace remove worktree-janitor-marketplace
  codex plugin marketplace add erictheng93/worktree-janitor --ref v0.2.0
  codex plugin add worktree-janitor@worktree-janitor-marketplace
  ```
  **每次更新後都要重新信任 hook。** Codex 以外掛所有檔案的雜湊值判斷 hook 是否受信任，所以任何新版本都會顯示為未受信任。
- **解除安裝：** 執行上面更新步驟的前兩行。

#### Windows：PowerShell（install.ps1）

適用 Windows PowerShell 5.1（Windows 10 與 11 內建）與 PowerShell 7（`pwsh`），不需要系統管理員權限。

安裝指定版本（推薦），可加選項：

```powershell
& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.ps1))) -Version v0.1.0 -None
```

安裝最新版。這種簡短寫法無法傳入選項，因此會替 `PATH` 中找得到的 `claude`、`codex` 設定整合：

```powershell
irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1 | iex
```

使用已下載的 `install.ps1`：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version v0.1.0 -None
```

| 選項 | 作用 |
| --- | --- |
| `-Version vX.Y.Z` | 要安裝的版本（預設：最新版） |
| `-Dir DIR` | 安裝根目錄（預設 `%LOCALAPPDATA%\worktree-janitor`） |
| `-Node PATH` | 要使用的 `node.exe`（預設：`PATH` 中的那一個） |
| `-Claude`、`-Codex`、`-All`、`-None` | 要設定哪些整合。預設：`PATH` 中找得到的 `claude` / `codex` 各設定一份。`-None`：只裝命令列工具 |
| `-Uninstall` | 移除整合（除非指定 `-Claude`、`-Codex` 或 `-None`，否則全部移除）、啟動器、使用者 `PATH` 項目與安裝目錄 |
| `-DryRun` | 只列出會做的事，不做任何變更 |

- **執行原則（Execution Policy）：** `irm` 的寫法是在記憶體中執行腳本，不受執行原則限制。直接執行下載下來的 `install.ps1` 檔案則會被預設的 `Restricted` / `RemoteSigned` 原則擋下，所以那種寫法要對該處理程序加上 `-ExecutionPolicy Bypass`。
- **PATH：** 安裝程式會把 `%LOCALAPPDATA%\worktree-janitor\bin` 加到**使用者** `PATH`（絕不動系統 `PATH`），並顯示訊息告知。請開新的終端機視窗讓它生效。啟動器是 `worktree-janitor.cmd`，另外還有給 Git Bash 用的 sh 啟動器 `worktree-janitor`。設定 `WORKTREE_JANITOR_NO_USER_PATH=1` 可以讓它不動 `PATH`，改由你自己加入。
- **確認：** 在新的終端機執行 `worktree-janitor --help`。
- **更新：** 用新的 `-Version`（或 `latest` 的寫法）再執行一次安裝指令。同一版本不會重複下載。
- **解除安裝：**
  ```powershell
  & ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1))) -Uninstall
  ```
  `PATH` 項目會被移除，使用者 `PATH` 會完全恢復成原本的樣子。

#### Homebrew（macOS、Linux）

formula 放在本儲存庫中，所以 tap 時要寫出完整網址：

```
brew tap erictheng93/worktree-janitor https://github.com/erictheng93/worktree-janitor
brew trust erictheng93/worktree-janitor
brew install erictheng93/worktree-janitor/worktree-janitor
```

- **`brew trust`：** 新版 Homebrew 會拒絕載入未受信任的第三方 tap 裡的 formula（「Refusing to load formula ... from untrusted tap」）。`brew trust erictheng93/worktree-janitor` 信任整個 tap；`brew trust --formula erictheng93/worktree-janitor/worktree-janitor` 只信任這一個 formula。舊版 Homebrew 沒有 `brew trust`，也不需要這一步。
- Homebrew 會把 Node.js 當成相依套件安裝，`worktree-janitor` 指令以絕對路徑執行 Homebrew 的 node，所以就算 `PATH` 中沒有 node 也能用。Homebrew 安裝的是 formula 所指向的版本；`brew pin worktree-janitor` 可以把它固定在目前版本。
- Homebrew 絕不更動 Claude Code 或 Codex 的設定。`brew info worktree-janitor` 會列出外掛的安裝指令，以及讓 Codex hook 執行 Homebrew 這份程式的指令（以 `opt/` 路徑執行 `install.mjs --codex`，`brew upgrade` 之後依然有效）。
- **確認：** `worktree-janitor --help`；`brew test worktree-janitor`。
- **更新：** `brew update && brew upgrade worktree-janitor`。
- **解除安裝：** `brew uninstall worktree-janitor && brew untap erictheng93/worktree-janitor`（如果照 `brew info` 加了 Codex hook，請先用 `--codex --uninstall` 執行同一個指令）。

#### macOS、Linux：curl（install.sh）

```
curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.sh | sh -s -- --version v0.1.0 --none
```

改裝最新版：`curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh`（會替 `PATH` 中找得到的 `claude`、`codex` 設定整合）。

這個腳本會下載 `worktree-janitor-v0.1.0.tar.gz` 與 `SHA256SUMS`，SHA-256 不符就中止，解壓到 `~/.worktree-janitor/v0.1.0`，讓 `~/.worktree-janitor/current` 指向它，並寫入啟動器 `~/.local/bin/worktree-janitor`。全程不使用 sudo，下載不完整時什麼都不會執行。

| 選項 | 作用 |
| --- | --- |
| `--version vX.Y.Z` | 要安裝的版本（預設：最新版） |
| `--dir DIR` | 安裝根目錄（預設 `~/.worktree-janitor`） |
| `--bin-dir DIR` | 啟動器所在目錄（預設 `~/.local/bin`） |
| `--node PATH` | 要使用的 node（預設：`PATH` 中的那一個） |
| `--claude`、`--codex`、`--all`、`--none` | 要設定哪些整合，與 `install.ps1` 相同 |
| `--uninstall` | 移除整合、啟動器與安裝目錄 |
| `--dry-run` | 只列出會做的事，不做任何變更 |

- **PATH：** macOS（以及部分 Linux 環境）預設不會把 `~/.local/bin` 放進 `PATH`；安裝程式會顯示要加進 profile 的那一行。
- **確認：** `worktree-janitor --help`。
- **更新：** 用新的 `--version` 再執行一次。Codex hook 一直指向 `~/.worktree-janitor/current`，所以會維持受信任狀態。
- **解除安裝：** 腳本本身不在安裝的檔案裡，要再下載一次：
  ```
  curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh -s -- --uninstall
  ```

#### 手動下載

每個發行版都有 `worktree-janitor-vX.Y.Z.tar.gz`、`worktree-janitor-vX.Y.Z.zip`、`install.sh`、`install.ps1` 與 `SHA256SUMS`，每個檔案也都附有 GitHub 建置來源證明（build provenance attestation）。可以從 [Releases 頁面](https://github.com/erictheng93/worktree-janitor/releases)下載，或執行 `gh release download v0.1.0 -R erictheng93/worktree-janitor`。

驗證雜湊值，macOS / Linux：

```
grep ' worktree-janitor-v0.1.0.tar.gz$' SHA256SUMS | sha256sum -c -      # Linux
grep ' worktree-janitor-v0.1.0.tar.gz$' SHA256SUMS | shasum -a 256 -c -  # macOS
tar -xzf worktree-janitor-v0.1.0.tar.gz
```

Windows（PowerShell；雜湊值相符時顯示 `True`）：

```powershell
$f = 'worktree-janitor-v0.1.0.zip'
$want = ((Get-Content SHA256SUMS) | Where-Object { $_.EndsWith("  $f") }).Split(' ')[0]
(Get-FileHash $f -Algorithm SHA256).Hash -eq $want
Expand-Archive $f -DestinationPath .
```

驗證建置來源（需要 `gh`）：`gh attestation verify worktree-janitor-v0.1.0.tar.gz -R erictheng93/worktree-janitor`。

壓縮檔會解出 `worktree-janitor-v0.1.0/` 資料夾。執行 `node worktree-janitor-v0.1.0/scripts/janitor.mjs --repo <repo>`，或用 `node worktree-janitor-v0.1.0/scripts/install.mjs --codex` 加裝指向它的 hook（之後請不要搬動這個資料夾）。

#### 從 git clone 安裝

```
git clone https://github.com/erictheng93/worktree-janitor.git
cd worktree-janitor
node scripts/install.mjs --codex --dry-run   # 預覽
node scripts/install.mjs --codex             # 或 --claude、--all
```

hook 會指向這份 clone，所以請不要搬動它。`node scripts/install.mjs --codex --uninstall` 只會移除它加上的東西。詳見[使用手冊](docs/manual.zh-TW.md#從-git-clone-安裝scriptsinstallmjs)。

### 安裝之後

使用外掛的話，照常工作即可：hook 會在每次工作階段開始時以及 `gh pr merge` 之後自動清理。想互動式試跑，可以執行 `/worktree-janitor:clean-worktrees`（Claude Code）或 `$clean-worktrees`（Codex）。

使用命令列工具：

```
worktree-janitor --repo /path/to/your/repo           # 試跑：列出會移除什麼與原因
worktree-janitor --repo /path/to/your/repo --apply   # 實際執行
```

沒有安裝啟動器時，`node scripts/janitor.mjs`（或 `bun scripts/janitor.mjs`）接受相同的參數。

## 平台支援

除非另外註明，以下項目在每個 pull request 都會於 CI 中執行。

| 平台 | janitor 測試套件 | 安裝程式與外掛 |
| --- | --- | --- |
| Windows Server 2022（Windows 10 21H2 核心），x64 | Node.js 18、20、22 | `install.ps1`，分別在 Windows PowerShell 5.1 與 PowerShell 7 下執行 |
| Windows Server 2025（Windows 11 24H2 核心），x64 | Node.js 18、20、22 | `install.ps1`（5.1 與 7）；Claude Code 與 Codex 外掛 |
| Windows 11，arm64 | Node.js 20、22 | - |
| macOS 15，arm64 | Node.js 18、20、22 | `install.sh`；Homebrew；Claude Code 與 Codex 外掛 |
| macOS 26，arm64 | Node.js 18、20、22 | - |
| macOS 15，Intel | Node.js 18、20、22 | `install.sh` |
| Ubuntu 24.04（GitHub runner） | Node.js 18、20、22 與 Bun | `install.sh`；Linux 上的 Homebrew；Claude Code 與 Codex 外掛 |
| Debian 11 / 12、Ubuntu 20.04 / 22.04 / 24.04 | 以 root 及沒有 sudo 的一般使用者執行 | Debian 12 上以沒有 sudo 的一般使用者執行 `install.sh` |
| Rocky Linux 8 / 9、AlmaLinux 8、RHEL UBI 8 / 9、CentOS Stream 9 / 10 | 以 root 及沒有 sudo 的一般使用者執行 | Rocky Linux 9 上以沒有 sudo 的一般使用者執行 `install.sh` |
| CentOS 7 | **不支援**：git 1.8.3 沒有 `git worktree`；janitor 會明確拒絕執行，不刪除任何東西 | - |

- **git：** 如果 git 沒有 `git worktree list`（早於 2.7），janitor 會拒絕執行。CI 中最舊的 git 是 2.25.1（Ubuntu 20.04）。每個發行版都用它自己套件庫的 git 測試，版本從 2.25 起跳。
- **Node.js：** 需要 18 以上；也可以用 Bun 執行 janitor（CI 在 Ubuntu 上以 Bun 跑完整個測試套件）。Windows arm64 從 Node.js 20 開始測試，因為 Node.js 18 沒有該平台的版本。
- **掛載點：** Windows 的磁碟區掛載點（掛載到資料夾的 NTFS VHDX）與 Dev Drive（ReFS）透過裝置 ID（`st_dev`）偵測；macOS 掛載在 worktree 內的 APFS 與 HFS+ 磁碟映像檔也用同樣方式偵測；Linux 的 bind mount 與 tmpfs 透過 `/proc/self/mountinfo` 偵測。以上都在 CI 中以真實的掛載測試，事後並確認掛載的資料完好無缺。
- **未測試：** 強制模式（enforcing）的 SELinux（容器共用 Ubuntu runner 的核心，所以 Red Hat 映像檔測試的是 RHEL 的使用者空間，而不是它的核心或 SELinux 政策），以及實體機器（CI 一律在 GitHub 代管的 runner 與容器上執行）。

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

| 代理程式 | 整合方式 |
| --- | --- |
| Claude Code | 外掛：`SessionStart` + `PostToolUse` hook，以及 `/worktree-janitor:clean-worktrees` 指令 |
| Codex | 外掛，或由安裝程式寫入的 hook：`SessionStart` + `PostToolUse` hook，以及 `$clean-worktrees` skill |
| 其他任何工具 | 自行執行 `worktree-janitor`（或 `node scripts/janitor.mjs`），可從終端機、腳本或其他工具的 hook 呼叫 |

## 判斷規則

由上而下，第一條符合的規則生效。worktree 必須通過所有檢查才會被移除。

| Worktree | 結果 |
| --- | --- |
| 主要 worktree，或 bare 儲存庫項目 | 保留 |
| 被執行中的 Claude Code 處理程序鎖定，或被其他人鎖定 | 保留（可用 `--include-locked` 覆寫） |
| 被已結束的 Claude Code 處理程序鎖定 | 鎖定已失效，繼續判斷 |
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

- [使用手冊](docs/manual.zh-TW.md)：概念、安裝細節、所有選項、hook payload、報告格式、結束代碼、平台說明、疑難排解、常見問題、已知限制
- [變更紀錄](CHANGELOG.md)

## 參與貢獻

歡迎到 `https://github.com/erictheng93/worktree-janitor` 回報問題或送出 pull request。

```
npm test
```

測試會在系統暫存資料夾下建立拋棄式儲存庫，只需要 Node.js 18 以上與 git。在 Linux 上，掛載點測試只有以 root 身分或在可免密碼使用 `sudo` 時才會執行，否則略過；設定 `JANITOR_REQUIRE_MOUNT_TESTS=1` 可讓略過變成失敗。`JANITOR_RUNTIME=bun npm test` 會以 Bun 執行每次 janitor 呼叫。`npm ci && npm run typecheck` 會用 TypeScript 檢查 JSDoc 型別（只在開發時需要，腳本本身仍然零相依）。請讓腳本維持零相依套件。

## 授權條款

[MIT](LICENSE)

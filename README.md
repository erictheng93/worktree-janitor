English | [繁體中文](README.zh-TW.md)

# worktree-janitor

Removes git worktrees and local branches whose work is already merged, without ever deleting through a link or into a mount. Runs automatically as a Claude Code or Codex plugin, or by hand from any terminal.

- [Installation](#installation): [recommended](#recommended), [prerequisites](#prerequisites), [every channel](#all-installation-channels)
- [Platform support](#platform-support)
- [What it solves](#the-problem), [how it decides](#how-it-decides), [safety guarantees](#safety-guarantees)
- [User manual](docs/manual.md), [changelog](CHANGELOG.md)

## Installation

### Recommended

Pick the line that describes you. Every block installs the latest release. The plugins follow the `stable` branch, which the release workflow moves to each new release tag and nothing else, so they never pick up unreleased work from `main`.

**You use Claude Code** (CLI or desktop app): install the plugin from the GitHub marketplace, on the `stable` branch.

```
claude plugin marketplace add https://github.com/erictheng93/worktree-janitor.git#stable
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

Restart Claude Code. The CLI and the desktop app share the same configuration, so this covers both.

**You use Codex** (CLI or desktop app): install the plugin on the `stable` branch with `--ref`, then trust its hooks.

```
codex plugin marketplace add erictheng93/worktree-janitor --ref stable
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

Start Codex and trust the two worktree-janitor hooks: `/hooks` in the CLI (or the prompt at startup), Settings > Hooks in the desktop app. Untrusted hooks never run.

**You use neither, or just want the command**:

macOS or Linux, with Homebrew:

```
brew tap erictheng93/worktree-janitor https://github.com/erictheng93/worktree-janitor
brew trust erictheng93/worktree-janitor
brew install erictheng93/worktree-janitor/worktree-janitor
```

Current Homebrew refuses a third-party tap until you run `brew trust`; older Homebrew has no such command and answers "Unknown command: brew trust", which you can ignore.

Windows, in PowerShell (Windows PowerShell 5.1 or PowerShell 7):

```powershell
& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.ps1))) -Version v0.1.0 -None
```

Open a new terminal, then run `worktree-janitor --help`.

**Why these.** Each one installs a fixed release: the plugins follow `stable`, which only ever points at a release tag, the PowerShell installer downloads that release's archive and refuses it unless its SHA-256 matches the published `SHA256SUMS`, and Homebrew checks the formula's sha256. None needs sudo or administrator rights, and each has a one-command update path (below). The plugins also ship the hooks and the `/worktree-janitor:clean-worktrees` command (Claude Code) or `$clean-worktrees` skill (Codex), so there are no local files to look after.

**Use one channel per tool.** For Codex in particular, never combine the plugin with hooks from an installer (`install.sh --codex`, `install.ps1 -Codex`, `install.mjs --codex`): both register the same two hooks, so every hook would run twice. The installers warn when they find the plugin enabled, and leave a Claude Code plugin from another channel alone.

### Prerequisites

worktree-janitor needs **Node.js 18 or newer** and **git** on `PATH`. `gh` (GitHub CLI) is optional; it is used only to recognize squash merges.

| OS | Install Node.js and git |
| --- | --- |
| Windows | `winget install OpenJS.NodeJS.LTS` and `winget install Git.Git` |
| macOS | `brew install node git` (or the nodejs.org installer; the Xcode Command Line Tools provide git) |
| Debian 12, Ubuntu 24.04 | `sudo apt-get install nodejs git` (these ship Node.js 18) |
| Debian 11, Ubuntu 20.04 / 22.04 | `sudo apt-get install git`, plus Node.js from nodejs.org or NodeSource (the packaged Node.js is too old) |
| RHEL / Rocky / Alma 8 and 9, CentOS Stream 9 | `sudo dnf install git` and `sudo dnf module install nodejs:20/common` |
| CentOS Stream 10, Fedora | `sudo dnf install nodejs git` |

Homebrew installs Node.js for you as a dependency. `install.sh` also needs `curl` or `wget`, `tar`, and one of `sha256sum`, `shasum` or `openssl`, which stock macOS, Debian, Ubuntu and the RHEL family already have. `install.ps1` needs nothing beyond Windows PowerShell 5.1.

### All installation channels

| Channel | For | Updates | Section |
| --- | --- | --- | --- |
| Claude Code plugin | Claude Code CLI and desktop app | `marketplace update` + `plugin update` | [Claude Code](#claude-code-plugin) |
| Codex plugin | Codex CLI and desktop app | `marketplace upgrade`, re-trust hooks | [Codex](#codex-plugin) |
| `install.ps1` | Windows (command, optional hooks) | run it again | [PowerShell](#windows-powershell-installps1) |
| Homebrew | macOS, Linux (command) | `brew upgrade` | [Homebrew](#homebrew-macos-linux) |
| `install.sh` | macOS, Linux (command, optional hooks) | run it again | [curl](#macos-linux-curl-installsh) |
| Release archive | any OS, scripts, air-gapped machines | download again | [Manual download](#manual-download) |
| git clone + `install.mjs` | contributors | `git pull` | [From a clone](#from-a-git-clone) |

#### Claude Code plugin

Terminal (Claude Code CLI):

```
claude plugin marketplace add https://github.com/erictheng93/worktree-janitor.git#stable
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

The shorthand `erictheng93/worktree-janitor@stable` works too, but Claude Code clones it over SSH, so it needs a GitHub SSH key; the HTTPS URL above does not. Claude Code 2.1.292 and newer also take the one-step form `claude plugin install worktree-janitor --marketplace https://github.com/erictheng93/worktree-janitor.git#stable`. The plugin is installed at user scope, so it applies to every project. Nothing prompts.

Desktop app: run the same two commands in a terminal; the app reads the same `~/.claude` configuration. Restart the app afterwards. The hooks start `node` by name, so it must be on the `PATH` the app itself sees. An app started from the Dock or the Start menu may not inherit your shell's `PATH`; if the hooks do not run there, install Node.js system-wide (for example the nodejs.org installer or `winget`), or start the app from a terminal.

- **Verify:** `claude plugin list` shows `worktree-janitor@worktree-janitor-marketplace` at version `0.1.0`, and `/worktree-janitor:clean-worktrees` is available in a session.
- **Update:** fetch the newest release from `stable`, then restart Claude Code:
  ```
  claude plugin marketplace update worktree-janitor-marketplace
  claude plugin update worktree-janitor@worktree-janitor-marketplace
  ```
  To stay on one exact release instead, add the marketplace with `#v0.1.0` in place of `#stable`. A tag never moves, so updating then means `claude plugin marketplace remove worktree-janitor-marketplace` and adding it again with the new tag.
- **Uninstall:**
  ```
  claude plugin uninstall worktree-janitor@worktree-janitor-marketplace
  claude plugin marketplace remove worktree-janitor-marketplace
  ```

#### Codex plugin

Terminal (Codex CLI):

```
codex plugin marketplace add erictheng93/worktree-janitor --ref stable
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

(`erictheng93/worktree-janitor@stable` works too.) Then start `codex` and trust the SessionStart and PostToolUse hooks of worktree-janitor in `/hooks`, or at the startup prompt. `codex exec` skips untrusted hooks silently.

Desktop app: run the same commands in a terminal (the app shares `CODEX_HOME`, default `~/.codex`), then trust the hooks in Settings > Hooks.

The plugin's hooks do not need `node` on `PATH`: they also look in `/opt/homebrew/bin`, `/usr/local/bin`, Volta and fnm's default alias on macOS/Linux, and `%ProgramFiles%\nodejs` on Windows. nvm, asdf, mise and `n` installs are found only through `PATH`.

- **Verify:** `codex plugin list` shows `worktree-janitor@worktree-janitor-marketplace` enabled at version `0.1.0`; `/hooks` lists its two hooks; the skill is `$clean-worktrees` (explicit invocation only).
- **Update:** `codex plugin marketplace upgrade worktree-janitor-marketplace` fetches the newest release from `stable` and updates the installed plugin.
  **Trust the hooks again after every update.** Codex hashes all of a plugin's files for hook trust, so any new version shows up as untrusted.
  To stay on one exact release, use `--ref v0.1.0`. Adding the marketplace again with another `--ref` fails ("already added from a different source"), so moving that pin means removing the plugin and the marketplace (the uninstall commands below) and adding them again.
- **Uninstall:**
  ```
  codex plugin remove worktree-janitor@worktree-janitor-marketplace
  codex plugin marketplace remove worktree-janitor-marketplace
  ```

#### Windows: PowerShell (install.ps1)

Works in Windows PowerShell 5.1 (built into Windows 10 and 11) and in PowerShell 7 (`pwsh`). No administrator rights.

Install a specific release (recommended), with options:

```powershell
& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.ps1))) -Version v0.1.0 -None
```

Install the latest release; this short form cannot take options, so it sets up Claude Code and Codex integrations for whichever of `claude` and `codex` is on `PATH`:

```powershell
irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1 | iex
```

From a downloaded copy of `install.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version v0.1.0 -None
```

| Option | Effect |
| --- | --- |
| `-Version vX.Y.Z` | Release to install (default: the latest) |
| `-Dir DIR` | Install root (default `%LOCALAPPDATA%\worktree-janitor`) |
| `-Node PATH` | `node.exe` to use (default: the one on `PATH`) |
| `-Claude`, `-Codex`, `-All`, `-None` | Integrations to set up. Default: one for each of `claude` / `codex` found on `PATH`. `-None`: the command only |
| `-Uninstall` | Remove the integrations (all unless `-Claude`, `-Codex` or `-None`), the launcher, the user `PATH` entry and the install directory |
| `-DryRun` | Print what would happen, change nothing |

- **Execution policy:** the `irm` forms run the script from memory and are not blocked by the execution policy. Running a downloaded `install.ps1` file is, under the default `Restricted` / `RemoteSigned` policies, hence `-ExecutionPolicy Bypass` for that one process.
- **PATH:** the installer adds `%LOCALAPPDATA%\worktree-janitor\bin` to your **user** `PATH` (never the system `PATH`) and prints that it did. Open a new terminal to pick it up. The launcher is `worktree-janitor.cmd`, plus an sh launcher `worktree-janitor` for Git Bash. Set `WORKTREE_JANITOR_NO_USER_PATH=1` to leave `PATH` alone and add the directory yourself.
- **Verify:** in a new terminal, `worktree-janitor --help`.
- **Update:** run the install command again with the new `-Version` (or the `latest` form). The same version is not downloaded twice.
- **Uninstall:**
  ```powershell
  & ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1))) -Uninstall
  ```
  The `PATH` entry is removed and your user `PATH` comes back exactly as it was.

#### Homebrew (macOS, Linux)

The formula lives in this repository, so the tap needs the explicit URL:

```
brew tap erictheng93/worktree-janitor https://github.com/erictheng93/worktree-janitor
brew trust erictheng93/worktree-janitor
brew install erictheng93/worktree-janitor/worktree-janitor
```

- **`brew trust`:** current Homebrew refuses to load a formula from an untrusted third-party tap ("Refusing to load formula ... from untrusted tap"). `brew trust erictheng93/worktree-janitor` trusts the tap; `brew trust --formula erictheng93/worktree-janitor/worktree-janitor` trusts only this formula. Older Homebrew has no `brew trust` and needs no such step.
- Homebrew installs Node.js as a dependency, and the `worktree-janitor` command runs Homebrew's node by absolute path, so it works even without node on `PATH`. Homebrew installs the release the formula points to; `brew pin worktree-janitor` keeps it there.
- Homebrew never changes Claude Code or Codex settings. `brew info worktree-janitor` shows the plugin commands, and the command for Codex hooks that run the Homebrew copy (`install.mjs --codex` on the `opt/` path, which survives `brew upgrade`).
- **Verify:** `worktree-janitor --help`; `brew test worktree-janitor`.
- **Update:** `brew update && brew upgrade worktree-janitor`.
- **Uninstall:** `brew uninstall worktree-janitor && brew untap erictheng93/worktree-janitor` (if you added the Codex hooks from `brew info`, first run that command with `--codex --uninstall`).

#### macOS, Linux: curl (install.sh)

```
curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.sh | sh -s -- --version v0.1.0 --none
```

Latest release instead: `curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh` (sets up integrations for whichever of `claude` and `codex` is on `PATH`).

The script downloads `worktree-janitor-v0.1.0.tar.gz` and `SHA256SUMS`, aborts unless the SHA-256 matches, unpacks to `~/.worktree-janitor/v0.1.0`, points `~/.worktree-janitor/current` at it and writes the launcher `~/.local/bin/worktree-janitor`. It never uses sudo, and a truncated download runs nothing.

| Option | Effect |
| --- | --- |
| `--version vX.Y.Z` | Release to install (default: the latest) |
| `--dir DIR` | Install root (default `~/.worktree-janitor`) |
| `--bin-dir DIR` | Launcher directory (default `~/.local/bin`) |
| `--node PATH` | node to use (default: the one on `PATH`) |
| `--claude`, `--codex`, `--all`, `--none` | Integrations, as for `install.ps1` |
| `--uninstall` | Remove the integrations, the launcher and the install directory |
| `--dry-run` | Print what would happen, change nothing |

- **PATH:** `~/.local/bin` is not on `PATH` by default on macOS (and some Linux setups); the installer prints the line to add to your profile.
- **Verify:** `worktree-janitor --help`.
- **Update:** run it again with the new `--version`. Codex hooks keep pointing at `~/.worktree-janitor/current`, so they stay trusted.
- **Uninstall:** the script is not part of the installed files, so fetch it again:
  ```
  curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh -s -- --uninstall
  ```

#### Manual download

Each release has `worktree-janitor-vX.Y.Z.tar.gz`, `worktree-janitor-vX.Y.Z.zip`, `install.sh`, `install.ps1` and `SHA256SUMS`, plus a GitHub build provenance attestation for each file. Download from the [releases page](https://github.com/erictheng93/worktree-janitor/releases) or with `gh release download v0.1.0 -R erictheng93/worktree-janitor`.

Verify the checksum, macOS / Linux:

```
grep ' worktree-janitor-v0.1.0.tar.gz$' SHA256SUMS | sha256sum -c -      # Linux
grep ' worktree-janitor-v0.1.0.tar.gz$' SHA256SUMS | shasum -a 256 -c -  # macOS
tar -xzf worktree-janitor-v0.1.0.tar.gz
```

Windows (PowerShell; prints `True` when the hash matches):

```powershell
$f = 'worktree-janitor-v0.1.0.zip'
$want = ((Get-Content SHA256SUMS) | Where-Object { $_.EndsWith("  $f") }).Split(' ')[0]
(Get-FileHash $f -Algorithm SHA256).Hash -eq $want
Expand-Archive $f -DestinationPath .
```

Verify where it was built (needs `gh`): `gh attestation verify worktree-janitor-v0.1.0.tar.gz -R erictheng93/worktree-janitor`.

The archive unpacks to `worktree-janitor-v0.1.0/`. Run `node worktree-janitor-v0.1.0/scripts/janitor.mjs --repo <repo>`, or add hooks pointing at it with `node worktree-janitor-v0.1.0/scripts/install.mjs --codex` (keep the directory where it is afterwards).

#### From a git clone

```
git clone https://github.com/erictheng93/worktree-janitor.git
cd worktree-janitor
node scripts/install.mjs --codex --dry-run   # preview
node scripts/install.mjs --codex             # or --claude, or --all
```

The hooks point at this clone, so keep it where it is. `node scripts/install.mjs --codex --uninstall` removes exactly what it added. Details: [manual](docs/manual.md#from-a-git-clone-scriptsinstallmjs).

### After installing

With a plugin, keep working: the hooks clean up at every session start and right after `gh pr merge`. Run `/worktree-janitor:clean-worktrees` (Claude Code) or `$clean-worktrees` (Codex) for an interactive dry run.

With the command:

```
worktree-janitor --repo /path/to/your/repo           # dry run: what would go, and why
worktree-janitor --repo /path/to/your/repo --apply   # act
```

Without an installed launcher, `node scripts/janitor.mjs` (or `bun scripts/janitor.mjs`) takes the same arguments.

## Platform support

Everything below runs in CI on every pull request, unless marked otherwise.

| Platform | Janitor test suite | Installers and plugins |
| --- | --- | --- |
| Windows Server 2022 (Windows 10 21H2 kernel), x64 | Node.js 18, 20, 22 | `install.ps1` under Windows PowerShell 5.1 and PowerShell 7 |
| Windows Server 2025 (Windows 11 24H2 kernel), x64 | Node.js 18, 20, 22 | `install.ps1` under 5.1 and 7; Claude Code and Codex plugins |
| Windows 11, arm64 | Node.js 20, 22 | - |
| macOS 15, arm64 | Node.js 18, 20, 22 | `install.sh`; Homebrew; Claude Code and Codex plugins |
| macOS 26, arm64 | Node.js 18, 20, 22 | - |
| macOS 15, Intel | Node.js 18, 20, 22 | `install.sh` |
| Ubuntu 24.04 (GitHub runner) | Node.js 18, 20, 22, and Bun | `install.sh`; Homebrew on Linux; Claude Code and Codex plugins |
| Debian 11 / 12, Ubuntu 20.04 / 22.04 / 24.04 | as root and as a user without sudo | `install.sh` as a user without sudo on Debian 12 |
| Rocky Linux 8 / 9, AlmaLinux 8, RHEL UBI 8 / 9, CentOS Stream 9 / 10 | as root and as a user without sudo | `install.sh` as a user without sudo on Rocky Linux 9 |
| CentOS 7 | **unsupported**: git 1.8.3 has no `git worktree`; the janitor refuses cleanly and deletes nothing | - |

- **git:** the janitor refuses to run with a git that has no `git worktree list` (older than 2.7). The oldest git in CI is 2.25.1 (Ubuntu 20.04). Each distro is tested with its own packaged git, from 2.25 up.
- **Node.js:** 18 or newer; Bun runs the janitor too (CI runs the whole suite with Bun on Ubuntu). Windows arm64 is tested from Node.js 20, because there is no Node.js 18 build for it.
- **Mounts:** Windows volume mount points (an NTFS VHDX mounted on a folder) and Dev Drive (ReFS) are detected through the device ID (`st_dev`); macOS APFS and HFS+ disk images attached inside a worktree are detected the same way; Linux bind mounts and tmpfs are detected through `/proc/self/mountinfo`. All of these are exercised with real mounts in CI, and the mounted data is checked intact afterwards.
- **Not exercised:** SELinux in enforcing mode (the containers share the Ubuntu runner's kernel, so the Red Hat images test RHEL userland, not its kernel or SELinux policy), and physical machines in general (CI runs on GitHub-hosted runners and containers).

## The problem

- **Merged worktrees pile up.** Coding agents create a worktree (and a branch) per task or subagent. After the pull request is merged, the worktree directory, its branch and Claude Code's `worktree-*` companion branches stay behind.
- **`git worktree remove` can delete files outside the worktree.** On Windows, git's recursive delete follows NTFS junctions. A worktree whose `node_modules` (or Rust `target`, a Python virtualenv, ...) is a junction into the main checkout loses the main checkout's copy when it is removed.
- **Mounts inside a worktree.** On every OS, a recursive delete crosses into a bind mount, tmpfs or mounted volume inside the worktree, empties the mounted source (which lives outside the repository), and only then fails with "Device or resource busy".

worktree-janitor never calls `git worktree remove`. It deletes the worktree itself, unlinking links instead of following them, refusing worktrees that contain a mount point, and stopping at the first surprise.

## Features

- Removes worktrees whose branch is merged into the base branch: merge commit, rebase merge (`git cherry`) or squash merge (via `gh`, optional).
- Deletes merged local branches and Claude Code's `worktree-*` companion branches.
- Dry run by default; `--apply` acts. `--json` for scripts.
- Keeps anything it cannot prove safe: dirty or untracked files, detached HEAD, live locks, fresh 0-commit branches, submodules, mount points, the main worktree, and the worktree you are standing in.
- Every keep decision comes with a one-line reason.
- Hooks run at session start and right after `gh pr merge`; they are bounded to about 20 seconds and never fail your session.
- One dependency-free script (Node.js standard library only), so it works for repositories in any language.

| Agent | How it integrates |
| --- | --- |
| Claude Code | Plugin: `SessionStart` + `PostToolUse` hooks and the `/worktree-janitor:clean-worktrees` command |
| Codex | Plugin, or hooks from an installer: `SessionStart` + `PostToolUse` hooks and the `$clean-worktrees` skill |
| Anything else | Run `worktree-janitor` (or `node scripts/janitor.mjs`) yourself, from a terminal, a script or another tool's hook |

## How it decides

The first matching rule wins. A worktree is removed only if it passes every check.

| Worktree | Result |
| --- | --- |
| Main worktree, or a bare repository entry | kept |
| Locked by a live Claude Code process, or by anyone else | kept (override with `--include-locked`) |
| Locked by a Claude Code process that is no longer running | lock is stale, removal continues |
| Directory already gone | registration pruned |
| Detached HEAD | kept |
| Contains the main worktree, or the current working directory | kept |
| Modified or untracked files (`git status` not empty) | kept |
| Branch not merged into the base, or 0 commits ahead and never merged | kept |
| Has a populated submodule, or submodule git dirs | kept |
| Contains a mount point, or a directory that cannot be read | kept |
| Everything above passed | removed (links inside are unlinked, targets untouched) |

| Branch | Result |
| --- | --- |
| The base branch, or named `main`, `master`, `develop`, `trunk` | kept |
| Checked out in a worktree that stays | kept |
| Merged into the base | deleted |
| `worktree-*` with 0 commits ahead and not checked out | deleted |
| Anything else | kept |

Full details, including every reason string and what to do about it: [manual](docs/manual.md#keep-reasons-and-what-to-do).

## Safety guarantees

- **Dry run by default.** No worktree or branch changes without `--apply` (hook modes imply it). The only thing a dry run updates is your remote-tracking refs, through `git fetch --prune origin`.
- **Never follows links.** Every symlink or junction is unlinked, then its target is checked to still exist.
- **Never deletes into a mount.** Mount points are checked before anything is deleted (on Linux through `/proc/self/mountinfo`, on every OS by device ID), and every directory is re-checked during deletion.
- **Fails closed.** On any surprise it stops at once, deletes nothing further and reports where it stopped (`partial`). The worktree's `.git` file is deleted last, so a stopped deletion stays registered with git.
- **Never unmounts, never force-removes**, and never touches the main worktree or remote branches.
- **Hooks never break a session.** They always exit 0 and stay quiet unless something was removed.

## Works for any language

worktree-janitor only talks to git (and optionally `gh`). It does not read project files, so a Rust, Python, Go, Java or any other repository needs no configuration. Node.js (or Bun) is needed only to run the script. Language-specific links such as a shared `target` or `.venv` junction are exactly what it is built to handle safely.

## Documentation

- [User manual](docs/manual.md): concepts, installation details, every flag, hook payloads, report format, exit codes, platform notes, troubleshooting, FAQ, limitations
- [Changelog](CHANGELOG.md)

## Contributing

Issues and pull requests are welcome at `https://github.com/erictheng93/worktree-janitor`.

```
npm test
```

The suite builds throwaway repositories under the system temp directory and needs only Node.js 18+ and git. On Linux the mount tests run only as root or with passwordless `sudo` and are skipped otherwise; set `JANITOR_REQUIRE_MOUNT_TESTS=1` to make a skip fail instead. `JANITOR_RUNTIME=bun npm test` runs every janitor invocation under Bun. `npm ci && npm run typecheck` checks the JSDoc types with TypeScript (development only; the script itself stays dependency-free). Please keep the script dependency-free.

## License

[MIT](LICENSE)

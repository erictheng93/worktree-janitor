English | [繁體中文](manual.zh-TW.md)

# worktree-janitor user manual

This manual describes worktree-janitor 0.1.0. For a short overview see the [README](../README.md).

## Contents

1. [Concepts](#concepts)
2. [Installation](#installation)
3. [Command-line reference](#command-line-reference)
4. [Hook modes](#hook-modes)
5. [Report format](#report-format)
6. [Exit codes](#exit-codes)
7. [Keep reasons and what to do](#keep-reasons-and-what-to-do)
8. [Environment variables](#environment-variables)
9. [Platform notes](#platform-notes)
10. [Uninstall](#uninstall)
11. [Troubleshooting](#troubleshooting)
12. [FAQ](#faq)
13. [Known limitations](#known-limitations)

## Concepts

### Worktrees

A git worktree is an extra working directory attached to one repository (`git worktree add`). The repository's original checkout is the **main worktree**; it is always the first entry of `git worktree list`. Coding agents such as Claude Code create one worktree per session or subagent, each on its own branch, so finished ones accumulate.

worktree-janitor always works from the main worktree, wherever it is started: `--repo` (or the current directory) may be the main worktree or any linked worktree of the repository. It never removes the main worktree, a bare repository entry, or a worktree that contains the main worktree.

### Base branch detection

The base branch is the branch that merged work lands in. Before choosing it, the janitor runs `git fetch --prune --quiet origin` when a remote named `origin` exists (15 second timeout; a failure, for example when offline, is ignored). Then, unless `--base` is given, it takes the first of these that resolves to a commit:

1. the target of `origin/HEAD` (for example `origin/main`)
2. `origin/main`
3. `origin/master`
4. `main`
5. `master`

`--base <ref>` accepts any ref that resolves to a commit, such as `origin/develop` or `release`. If it does not resolve, the run fails with `base branch not found`. The local name of the base (the ref without an `origin/` or `upstream/` prefix) is protected from deletion.

### How a branch counts as merged

For a worktree's branch or a local branch with tip commit `T`, the janitor counts the commits in `base..T`:

| Situation | Check | Result |
| --- | --- | --- |
| Commits ahead of base, all with an equivalent patch in base | `git cherry <base> T` lists no `+` line | merged (rebase merge, cherry-pick) |
| Commits ahead of base, `gh` reports a merged PR whose head commit equals `T` | `gh pr list --state merged --head <branch> --json headRefOid,number --limit 30` | merged (squash merge) |
| Commits ahead, neither of the above | | not merged |
| 0 commits ahead, `T` is reachable from base only through a merge commit's second parent | `T` is not on `git rev-list --first-parent <base>` | merged (merge commit) |
| 0 commits ahead, `T` is on the base's first-parent chain, `gh` reports a merged PR with head `T` | as above | merged (for example a fast-forward merge) |
| 0 commits ahead, otherwise | | not merged: a fresh branch that never had its own work |

Notes:

- `gh` is optional. If it is missing, not authenticated, offline, or the repository is not on GitHub, the first failing call disables it for the rest of the run, and squash-merged branches are kept with `(gh unavailable for squash check)` in the reason.
- The PR's head commit must equal the local tip exactly. A branch that got new commits (or was amended) after the PR merged is not treated as merged.
- The first-parent walk is capped at 50,000 commits. Beyond that, a 0-commits-ahead branch is treated as merged only if `gh` confirms it.

### Fresh (0-commit) branches

A branch created from the base and never committed to has 0 commits ahead and sits on the base's first-parent chain. It is indistinguishable from a fast-forward-merged branch without `gh`, so it is kept: removing it could discard a worktree someone is just starting to use.

Exception: Claude Code's companion branches named `worktree-*` are deleted when they have 0 commits ahead **and** are not checked out in any worktree.

### Locks

`git worktree lock` marks a worktree as in use. Claude Code locks the worktrees it creates with a reason of the form `claude agent <name> (pid <pid>)` or `claude session <name> (pid <pid> start <time>)`. The janitor treats such a lock the way Claude Code does:

- the PID is alive: kept (`locked by a live Claude Code process`)
- the PID is not alive: the lock is stale, it does not block removal, and the worktree is unlocked once its directory is gone
- any other lock (a person's `git worktree lock`, another tool): kept

`--include-locked` overrides live and unknown locks. PID reuse can make a dead session look alive; that only ever keeps a worktree.

### Links and mounts

A **link** here is a symlink, an NTFS junction, or another reparse point that Node.js reports as a link. A link inside a worktree is never followed: the janitor removes the link itself and then checks that its target still exists.

A **mount point** is a directory where another filesystem (or a bind mount of a directory) is attached. Its content does not belong to the worktree, so a worktree containing one is kept; the janitor never unmounts anything. Two independent detectors are used:

- Linux: every mount point listed in `/proc/self/mountinfo` at or below the worktree. This is the only way to see a bind mount from the same filesystem.
- Every OS: a directory whose device ID (`st_dev`) differs from the worktree root's. The scan has no depth limit.

## Installation

The [README](../README.md#installation) has the short version: the recommended channel for each audience and copy-paste commands for every channel. This chapter adds what each channel creates, every option, and how updates and uninstalls behave. Commands use `v0.1.0`; substitute the release you want.

### Choosing a channel

| You use | Recommended | Why |
| --- | --- | --- |
| Claude Code (CLI or desktop app) | [Claude Code plugin](#claude-code-plugin) from the GitHub marketplace, on the `stable` branch | No local files to manage; the plugin ships the hooks and `/worktree-janitor:clean-worktrees` |
| Codex (CLI or desktop app) | [Codex plugin](#codex-plugin) from the GitHub marketplace with `--ref stable`, then trust its hooks | The same for Codex; the plugin's hooks find `node` without `PATH` |
| Neither, on macOS or Linux | [Homebrew](#homebrew) | Updates with `brew upgrade`; Node.js comes as a dependency |
| Neither, on Windows | [install.ps1](#installps1-windows) | No admin rights; puts `worktree-janitor` on the user `PATH` |
| One verified copy for scripts, or both agents from one copy | [install.sh](#installsh-macos-linux) / [install.ps1](#installps1-windows) with `--claude --codex` / `-Claude -Codex` | SHA-256-verified release archive; hook paths survive upgrades |

Use **one channel per tool**:

- **Claude Code:** a plugin from the GitHub marketplace and the installers' local marketplace have the same marketplace name, `worktree-janitor-marketplace`. The installers leave a marketplace from another channel alone: they print `skipped: marketplace worktree-janitor-marketplace already comes from ...` and change nothing.
- **Codex:** the plugin and installer hooks (`install.sh --codex`, `install.ps1 -Codex`, `install.mjs --codex`) register the same two hooks, so together every hook runs twice. `install.mjs` warns when it finds the plugin enabled.

### Requirements

- **Node.js 18 or newer**, or Bun, to run the janitor. How to install it on each OS: [README prerequisites](../README.md#prerequisites).
- **git** on `PATH`. The janitor refuses to run when `git worktree list --porcelain` fails, which is the case for git older than 2.7 (`git 2.7 or newer is required`). The oldest git exercised in CI is 2.25.1.
- **gh** (GitHub CLI), optional: needed only for squash merges and a few other cases ([How a branch counts as merged](#how-a-branch-counts-as-merged)).
- `install.sh`: `curl` or `wget`, `tar`, and one of `sha256sum`, `shasum`, `openssl`. `install.ps1`: Windows PowerShell 5.1 or PowerShell 7.

### Claude Code plugin

Claude Code's CLI and desktop app share `~/.claude`, so installing from a terminal makes the plugin available in both. Restart running sessions or the app afterwards.

```
claude plugin marketplace add https://github.com/erictheng93/worktree-janitor.git#stable
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

- The marketplace source can also be written as the shorthand `erictheng93/worktree-janitor@stable` (Claude Code clones it over SSH, so it needs a GitHub SSH key), or as the path of a local directory. Without `#stable` or `#<tag>` it follows `main`, which is not a release.
- One-step form, Claude Code 2.1.292 and newer: `claude plugin install worktree-janitor --marketplace https://github.com/erictheng93/worktree-janitor.git#stable`.
- In an interactive Claude Code session the same commands are available as `/plugin marketplace add ...` and `/plugin install ...`.
- The default scope is `user`, which applies to every project. Nothing prompts: the plugin has no `userConfig`.

The plugin provides:

| Component | Details |
| --- | --- |
| `SessionStart` hook | `node ${CLAUDE_PLUGIN_ROOT}/scripts/janitor.mjs --hook session-start`, 30 s timeout |
| `PostToolUse` hook | matcher `Bash\|PowerShell`, `node ... --hook post-tool-use`, 30 s timeout; acts only after `gh pr merge` |
| `/worktree-janitor:clean-worktrees` | Dry run, shows the report, asks you to confirm, then runs with `--apply`. Only you can invoke it; the model does not call it on its own |

The hooks use exec form (`"command": "node"` plus an `args` array), so no shell is involved and paths with spaces need no quoting. **`node` must be on the `PATH` of the Claude Code process.** A terminal session has your shell's `PATH`. The desktop app started from the Dock or the Start menu may not: on macOS, apps started by launchd get only `/usr/bin:/bin:/usr/sbin:/sbin` unless the app imports the login shell's environment. If the hooks do not run in the desktop app, install Node.js where that `PATH` finds it (on Windows the nodejs.org installer and `winget` add it to the system `PATH`), or start the app from a terminal.

**Verify:** `claude plugin list` shows `worktree-janitor@worktree-janitor-marketplace` with version `0.1.0`; `/worktree-janitor:clean-worktrees` exists in a session; `claude --debug-file <file>` logs `SessionStart:startup [node .../scripts/janitor.mjs --hook session-start] ... finished with status 0`.

**Update:** the marketplace follows `stable`, which the release workflow moves to each new release tag (and never to unreleased commits on `main`). Fetch it and update the plugin, then restart sessions:

```
claude plugin marketplace update worktree-janitor-marketplace
claude plugin update worktree-janitor@worktree-janitor-marketplace
```

Claude Code only updates a plugin whose `version` changed; every release bumps it (the release workflow refuses a tag that does not match the manifests).

To stay on one exact release, add the marketplace with `#v0.1.0` instead of `#stable`. A tag never moves, so updating means `claude plugin marketplace remove worktree-janitor-marketplace`, then adding it again with the new tag and running `claude plugin install worktree-janitor@worktree-janitor-marketplace`.

**Uninstall:**

```
claude plugin uninstall worktree-janitor@worktree-janitor-marketplace
claude plugin marketplace remove worktree-janitor-marketplace
```

### Codex plugin

Codex CLI and the desktop app share `CODEX_HOME` (default `~/.codex`), so installing from a terminal covers both.

```
codex plugin marketplace add erictheng93/worktree-janitor --ref stable
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

`codex plugin marketplace add` also accepts `owner/repo@ref`, an HTTPS or SSH git URL, or a local path. Codex copies the plugin into `$CODEX_HOME/plugins/cache/` and enables it in `config.toml`.

Then **trust the two hooks**: in the CLI, `/hooks` or the prompt at startup; in the desktop app, Settings > Hooks. Untrusted hooks never run, and `codex exec` skips them silently.

| Component | Details |
| --- | --- |
| `SessionStart` hook | runs `${PLUGIN_ROOT}/scripts/janitor.mjs --hook session-start` with the first node it finds (below), 30 s timeout |
| `PostToolUse` hook | matcher `Bash`, the same with `--hook post-tool-use`, 30 s timeout |
| `$clean-worktrees` skill | Same dry-run-then-confirm flow as the Claude Code command; explicit invocation only |

The plugin's hooks do not need `node` on `PATH`. On macOS and Linux (`command`, run by `sh`) they try node on `PATH`, `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.volta/bin/node`, and fnm's default alias (`~/.local/share/fnm/aliases/default/bin/node`, `~/Library/Application Support/fnm/aliases/default/bin/node`), and exit 0 silently when there is none. On Windows (`commandWindows`, run by PowerShell) they try `node.exe` on `PATH`, then `%ProgramFiles%\nodejs\node.exe`. nvm, asdf, mise and `n` installs are found only through `PATH`.

**Verify:** `codex plugin list` shows `worktree-janitor@worktree-janitor-marketplace` enabled with version `0.1.0`; `/hooks` lists a SessionStart and a PostToolUse (`Bash`) hook from the plugin.

**Update:** `codex plugin marketplace upgrade worktree-janitor-marketplace` fetches the newest release from `stable` and updates the installed plugin. Then **trust the hooks again**: Codex computes hook trust over the content of every file of an installed plugin, so each update needs a new approval.

To stay on one exact release, use `--ref v0.1.0`. Adding the marketplace again with another `--ref` fails ("already added from a different source"), so moving that pin means running the two uninstall commands below and adding the marketplace and plugin again.

**Uninstall:** `codex plugin remove worktree-janitor@worktree-janitor-marketplace`, then `codex plugin marketplace remove worktree-janitor-marketplace`. An empty `$CODEX_HOME/plugins/cache/worktree-janitor-marketplace` directory is left behind.

### install.ps1 (Windows)

Runs under Windows PowerShell 5.1 and PowerShell 7, without administrator rights. On Windows PowerShell 5.1 it enables TLS 1.2 for its downloads.

```powershell
# a specific release, with options (recommended)
& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.ps1))) -Version v0.1.0 -None

# the latest release; `iex` cannot pass options
irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1 | iex

# a downloaded copy
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version v0.1.0 -All
```

Without `-Version`, the script installs the latest release, whichever URL it was downloaded from. `-Version` also accepts `0.1.0` without the `v`.

| Option | Effect |
| --- | --- |
| `-Version vX.Y.Z` | Release to install (default: the latest, from the GitHub API) |
| `-Dir DIR` | Install root (default `%LOCALAPPDATA%\worktree-janitor`) |
| `-Node PATH` | `node.exe` to use (default: node on `PATH`; Node.js 18+) |
| `-Claude` | Also set up the Claude Code plugin from the installed copy (needs `claude` on `PATH`) |
| `-Codex` | Also set up Codex hooks, skill and `AGENTS.md` rule |
| `-All` | Both |
| `-None` | Neither: files and launcher only. Cannot be combined with the three above |
| (none of the four) | One integration for each of `claude` / `codex` found on `PATH` |
| `-Uninstall` | Remove the integrations (all unless `-Claude`, `-Codex` or `-None` narrows it), the launcher, the user `PATH` entry and the install directory |
| `-DryRun` | Print what would happen, change nothing |
| `-Help` | Usage |

What it creates:

- `<Dir>\v0.1.0\`: the release zip, unpacked only after its SHA-256 matched `SHA256SUMS`, and the junction `<Dir>\current` pointing at it.
- `<Dir>\bin\worktree-janitor.cmd`, which runs the absolute node found at install time (falling back to node on `PATH`), plus `<Dir>\bin\worktree-janitor`, an sh launcher for Git Bash, where `.cmd` files are not found without the extension.
- `<Dir>\bin` appended to the **user** `PATH` (HKCU, kept as `REG_EXPAND_SZ` so `%VARS%` stay unexpanded). New terminals pick it up; already open ones do not.
- With `-Codex` or `-Claude`: the same integrations as [install.mjs](#from-a-git-clone-scriptsinstallmjs), pointing at `<Dir>\current`. Codex hooks get a `command_windows`.

**Execution policy:** the two `irm` forms run the script text from memory, which the execution policy does not restrict. Running the downloaded `install.ps1` file is blocked under the `Restricted` and (for downloaded files) `RemoteSigned` policies, so pass `-ExecutionPolicy Bypass` to that one `powershell` process; nothing about your policy changes.

**Verify:** in a new terminal, `worktree-janitor --help`.

**Update:** run it again, with the new `-Version` or the `latest` form. The same version is not downloaded twice; a new version moves `current`, deletes the older versions it installed, and leaves Codex hook commands unchanged (no re-trust) unless the node path changed.

**Uninstall:**

```powershell
& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1))) -Uninstall
```

The user `PATH` entry is removed and the `PATH` string comes back exactly as it was. Pass `-Dir` if you installed elsewhere.

### install.sh (macOS, Linux)

POSIX `sh`, never sudo.

```
# a specific release, with options (recommended)
curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.sh | sh -s -- --version v0.1.0 --none

# the latest release
curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh

# a downloaded copy
sh install.sh --version v0.1.0 --codex
```

| Option | Effect |
| --- | --- |
| `--version vX.Y.Z` | Release to install (default: the latest, from the GitHub API; a clear error when there is no release) |
| `--dir DIR` | Install root (default `~/.worktree-janitor`) |
| `--bin-dir DIR` | Where the `worktree-janitor` launcher goes (default `~/.local/bin`) |
| `--node PATH` | node to use (default: node on `PATH`; Node.js 18+) |
| `--claude`, `--codex`, `--all`, `--none` | As `-Claude`, `-Codex`, `-All`, `-None` for install.ps1; default: one integration for each of `claude` / `codex` on `PATH` |
| `--uninstall` | Remove the integrations (all unless `--claude`, `--codex` or `--none` narrows it), the launcher and the install directory |
| `--dry-run` | Print what would happen, change nothing |
| `-h`, `--help` | Usage |

`--version=vX.Y.Z` (and the same `=` form for `--dir`, `--bin-dir`, `--node`) works too.

What it creates:

- `~/.worktree-janitor/v0.1.0/`: the release tarball, unpacked only after its SHA-256 matched `SHA256SUMS`, and the symlink `~/.worktree-janitor/current` pointing at it.
- `~/.local/bin/worktree-janitor`: a launcher that runs the absolute node found at install time, falling back to node on `PATH`. `~/.local/bin` is not on `PATH` by default on macOS; the installer then prints the line to add to your profile.
- With `--codex`: hooks in `$CODEX_HOME/hooks.json` if that file exists, else a marked block in `$CODEX_HOME/config.toml`; the skill in `~/.agents/skills/clean-worktrees`; a rule in `$CODEX_HOME/AGENTS.md`. The hooks point at `~/.worktree-janitor/current/scripts/janitor.mjs` and try the absolute node first.
- With `--claude`: a local marketplace at `~/.worktree-janitor/current` and the plugin (user scope).

Everything in the script is inside functions called on its last line, so a truncated download runs nothing.

**Verify:** `worktree-janitor --help`; `readlink ~/.worktree-janitor/current`.

**Update:** run it again (latest) or with `--version`. Same version: nothing is downloaded. New version: `current` moves, the older versions it installed are deleted, Codex hook commands stay the same (no re-trust) unless the node path changed, and the Claude Code plugin is read from `current` and updated in place.

**Uninstall:** the script is not inside the archive, so download it again:

```
curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh -s -- --uninstall
```

It removes the integrations, the launcher, and only files it created; the install directory goes when it is empty. Empty `~/.agents/skills` directories stay.

**Environment** (both installers): `HTTPS_PROXY` / `https_proxy` for the downloads (never printed; install.ps1 passes credentials in the URL as a `PSCredential`), `WORKTREE_JANITOR_BASE_URL` (a mirror of the release assets: an https URL, a `file://` URL or a local directory), `WORKTREE_JANITOR_API_URL` (the latest-release endpoint), and for install.ps1 `WORKTREE_JANITOR_NO_USER_PATH=1` (do not touch the user `PATH`).

### Homebrew

macOS and Linux (Homebrew on Linux). The formula lives in this repository (`Formula/worktree-janitor.rb`); there is no separate tap repository, so the tap needs the explicit URL:

```
brew tap erictheng93/worktree-janitor https://github.com/erictheng93/worktree-janitor
brew trust erictheng93/worktree-janitor
brew install erictheng93/worktree-janitor/worktree-janitor
```

**`brew trust`.** Current Homebrew refuses to load a formula from a third-party tap until the tap is trusted: "Refusing to load formula erictheng93/worktree-janitor/worktree-janitor from untrusted tap erictheng93/worktree-janitor. Run `brew trust --formula erictheng93/worktree-janitor/worktree-janitor` or `brew trust erictheng93/worktree-janitor` to trust it." `--formula` trusts only that one formula. Older Homebrew has no `brew trust` command ("Unknown command: brew trust") and needs no such step. In a script: `brew commands --quiet | grep -qx trust && brew trust erictheng93/worktree-janitor`.

The formula installs into `libexec`, depends on Homebrew's `node`, and its `bin/worktree-janitor` wrapper runs `$(brew --prefix)/opt/node/bin/node` by absolute path, so it works without node on `PATH`. Homebrew installs the release the formula points to; `brew pin worktree-janitor` holds it there.

It never writes Claude Code or Codex settings. `brew info worktree-janitor` shows caveats with the plugin commands and, for Codex hooks that run the Homebrew copy:

```
$(brew --prefix)/opt/node/bin/node $(brew --prefix)/opt/worktree-janitor/libexec/scripts/install.mjs --codex --node $(brew --prefix)/opt/node/bin/node
```

Those hooks point at the `opt/` path, so they survive `brew upgrade`. Run the same command with `--uninstall` added before `brew uninstall`.

**Verify:** `worktree-janitor --help`; `brew test worktree-janitor`.

**Update:** `brew update && brew upgrade worktree-janitor`.

**Uninstall:** `brew uninstall worktree-janitor && brew untap erictheng93/worktree-janitor`.

### Release archives

Every release on the [releases page](https://github.com/erictheng93/worktree-janitor/releases) has:

| Asset | Content |
| --- | --- |
| `worktree-janitor-vX.Y.Z.tar.gz` | The runtime files (scripts, hooks, skills, plugin manifests, integrations, docs), under `worktree-janitor-vX.Y.Z/` |
| `worktree-janitor-vX.Y.Z.zip` | The same, for Windows |
| `install.sh`, `install.ps1` | The installers |
| `SHA256SUMS` | SHA-256 of each of the four files above |

Each asset also has a GitHub build provenance attestation. The release workflow builds the assets twice and requires byte-identical results before publishing.

Download with a browser or `gh release download v0.1.0 -R erictheng93/worktree-janitor`, then verify:

```
# Linux
grep ' worktree-janitor-v0.1.0.tar.gz$' SHA256SUMS | sha256sum -c -
# macOS
grep ' worktree-janitor-v0.1.0.tar.gz$' SHA256SUMS | shasum -a 256 -c -
# provenance, any OS (needs gh)
gh attestation verify worktree-janitor-v0.1.0.tar.gz -R erictheng93/worktree-janitor
```

```powershell
# Windows PowerShell 5.1 or 7: prints True when the hash matches
$f = 'worktree-janitor-v0.1.0.zip'
$want = ((Get-Content SHA256SUMS) | Where-Object { $_.EndsWith("  $f") }).Split(' ')[0]
(Get-FileHash $f -Algorithm SHA256).Hash -eq $want
Expand-Archive $f -DestinationPath .
```

Unpack it anywhere and run `node worktree-janitor-v0.1.0/scripts/janitor.mjs`, or set up hooks with its `scripts/install.mjs` (next section); the hooks then point at that directory, so keep it in place.

### From a git clone: scripts/install.mjs

The installer works from a clone (or an unpacked release archive) and points everything at **that directory's** `scripts/janitor.mjs`, so keep it where it is (moving it means reinstalling). `install.sh` and `install.ps1` run this same script from `<dir>/current`.

```
git clone https://github.com/erictheng93/worktree-janitor.git
cd worktree-janitor
node scripts/install.mjs --all --dry-run
```

| Flag | Effect |
| --- | --- |
| `--claude` | Claude Code: adds this directory as the local marketplace `worktree-janitor-marketplace` and installs the plugin at user scope, through the `claude` CLI. Only missing steps run. Skipped with a message when `claude` is not on `PATH` |
| `--codex` | Codex: hooks, skill and an `AGENTS.md` rule (below) |
| `--all` | Both `--claude` and `--codex` |
| `--uninstall` | Removes what the installer added, and nothing else |
| `--dry-run` | Prints every planned change and writes nothing |
| `--root <dir>` | The worktree-janitor directory the hooks and the marketplace point at (default: the one the script is in, as started, symlinks not resolved) |
| `--node <path>` | Absolute path of the node the Codex hooks try first (default: the node running the installer); node on `PATH` and the usual install locations are the fallbacks |
| `-h`, `--help` | Usage |

Without `--claude`, `--codex` or `--all` it prints usage and exits 2.

What `--codex` writes (`$CODEX_HOME` defaults to `~/.codex`):

| Target | Content |
| --- | --- |
| `$CODEX_HOME/hooks.json`, if that file already exists | The two hook groups, replaced in place if present, otherwise appended. Existing groups never move, because Codex trust keys are positional |
| `$CODEX_HOME/config.toml`, otherwise | The same hooks as `[[hooks.*]]` tables inside a `# >>> worktree-janitor >>>` ... `# <<< worktree-janitor <<<` block |
| `~/.agents/skills/clean-worktrees/SKILL.md` and `agents/openai.yaml` | The `$clean-worktrees` skill, explicit invocation only |
| `$CODEX_HOME/AGENTS.md` | A marked rule telling Codex never to run `git worktree remove` directly and to use the janitor instead |

Each hook has a `command` (macOS/Linux) and a `command_windows` that try the `--node` path first, then the same fallbacks as the [Codex plugin](#codex-plugin). Codex merges `hooks.json` with inline `[hooks]` tables but warns at every session start when one config layer uses both, so the installer keeps to the one you already have.

Behavior details:

- Idempotent: a second run reports `ok ... (already installed)` and rewrites nothing, so trusted hooks stay trusted.
- Before its first change to an existing file, it saves the original bytes as `<file>.worktree-janitor.bak` (once). Uninstall restores those exact bytes when nothing else changed in the file, deletes files it created, and removes the backups.
- Tables that Codex itself inserts inside the marked block (hook trust entries) are preserved on reinstall and on uninstall.
- It refuses, without writing, when `hooks.json` is not valid JSON, when `config.toml` already defines hooks as a static array (`SessionStart = [...]` or `hooks = {...}`; adding tables would make it invalid TOML), when a `clean-worktrees` skill exists that it did not install, or when the marked block was edited by hand.
- `--codex` warns when the worktree-janitor Codex plugin is also enabled: the hooks would run twice.
- `--claude` skips, changing nothing, when a marketplace named `worktree-janitor-marketplace` already comes from somewhere else (the GitHub marketplace or another directory); remove that one first if you want this directory instead. When the installed plugin's version differs from this directory's, it refreshes the marketplace and updates the plugin. `--claude --uninstall` likewise keeps a plugin that came from another source.
- On Windows the hook command quotes the path with double quotes, or with single quotes when the path contains `$`, a backtick, `"` or a typographic quote (Codex runs hook commands in PowerShell on Windows and in `sh` elsewhere).
- Exit code: 0 on success, 1 if any step failed, 2 for a usage error.

After `--codex`, start Codex and trust the two hooks (startup prompt or `/hooks`). A changed hook command, for example after reinstalling from another path or with another node, has to be trusted again.

### Manual Codex setup with the templates

`integrations/codex/` holds the exact hooks the installer writes, with the placeholder path `/path/to/worktree-janitor`:

- [`integrations/codex/config.toml`](../integrations/codex/config.toml): replace the placeholder with the absolute path of your clone (forward slashes also work on Windows) and append everything from the `# >>> worktree-janitor >>>` line on to `$CODEX_HOME/config.toml`. The markers let `node scripts/install.mjs --codex --uninstall` remove it later.
- [`integrations/codex/hooks.json`](../integrations/codex/hooks.json): use this instead if you already keep hooks in `$CODEX_HOME/hooks.json`; merge its two groups into yours.

Use one of the two files, not both, and then trust the hooks in Codex.

### Plain CLI

No installation is needed: clone the repository, unpack a release archive (or copy `scripts/janitor.mjs`, which has no dependencies) and run it with Node.js 18+ or Bun:

```
node scripts/janitor.mjs --repo /path/to/repo
bun scripts/janitor.mjs --repo /path/to/repo
```

The `worktree-janitor` command from install.sh, install.ps1 or Homebrew is the same script with the same arguments.

To wire it into another tool's hooks, call `node /path/to/janitor.mjs --hook session-start` or `--hook post-tool-use` and pass the payload described in [Hook modes](#hook-modes) on stdin.

## Command-line reference

```
node janitor.mjs [--apply] [--repo <path>] [--base <branch>] [--json]
                 [--hook session-start|post-tool-use] [--include-locked]
```

| Flag | Meaning |
| --- | --- |
| (none) | Dry run: print what would be removed or kept, and why |
| `--apply` | Remove worktrees and delete branches |
| `--repo <path>` | Repository to work on (default: current directory). Any worktree of the repository works; the janitor always operates from the main worktree |
| `--base <branch>` | Base branch. Default: see [Base branch detection](#base-branch-detection) |
| `--json` | Print the report as JSON instead of text |
| `--hook <kind>` | Hook mode, `session-start` or `post-tool-use`. Implies `--apply`, reads a JSON payload from stdin, is quiet and always exits 0 |
| `--include-locked` | Also remove worktrees locked by a live or unknown owner |
| `-h`, `--help` | Usage |

`--repo=<path>`, `--base=<branch>` and `--hook=<kind>` are accepted too. An unknown argument prints the usage to stderr and exits 1.

Examples:

```
# What would go? (changes no worktree or branch)
node scripts/janitor.mjs

# Another repository, from anywhere
node scripts/janitor.mjs --repo ~/src/my-app

# Act
node scripts/janitor.mjs --repo ~/src/my-app --apply

# The base branch is not main/master
node scripts/janitor.mjs --base origin/develop

# Also remove worktrees locked by a person or another tool
node scripts/janitor.mjs --apply --include-locked

# Machine-readable report
node scripts/janitor.mjs --json

# Simulate the post-merge hook
echo '{"tool_input":{"command":"gh pr merge 12 --squash"},"cwd":"/path/to/repo"}' | node scripts/janitor.mjs --hook post-tool-use
```

## Hook modes

| | `--hook session-start` | `--hook post-tool-use` |
| --- | --- | --- |
| When the agent runs it | At every session start | After every shell tool call (`Bash` or `PowerShell` in Claude Code, `Bash` in Codex) |
| Acts when | Always | The command matches `gh pr merge` (also `gh.exe`, any case, anywhere in the string, inside a `bash -lc` or `powershell -Command` wrapper) |
| stdin wait | Up to 1 s | Up to 3 s |

Common behavior:

- Implies `--apply`.
- The whole run is bounded to about 20 seconds; whatever is left when time runs out is kept with a `time budget exhausted` reason and handled next time. `gh` calls time out after 6 seconds (10 seconds outside hook mode).
- Output: nothing, or one line on stdout when something was removed or deleted, a removal stopped partway, or a safety check fired. For example: `worktree-janitor: removed 1 merged worktree(s) (wt-login); deleted 1 merged branch(es) (feature-login)`. Up to four names are listed, then `+N more`. With `--json` the full report is printed instead.
- Always exits 0, also for bad arguments, unparseable payloads, non-repositories and internal errors, so a hook can never fail your session.

### Payloads

The janitor reads only two fields: `cwd` (string) and, for `post-tool-use`, the command in `tool_input`. Everything else is ignored.

Claude Code `PostToolUse` (abridged):

```json
{
  "hook_event_name": "PostToolUse",
  "cwd": "/path/to/repo",
  "tool_name": "Bash",
  "tool_input": { "command": "gh pr merge 12 --squash --delete-branch" }
}
```

`tool_name` is `PowerShell` for the PowerShell tool; the shape is the same.

Codex CLI `PostToolUse` (captured from Codex 0.172 on Windows, ids redacted, abridged):

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

Codex sends `tool_name` `Bash` on Windows too, and `tool_input.command` is the command as the model wrote it, without the shell wrapper Codex runs it in.

`SessionStart` payloads (both agents) carry `cwd`, `hook_event_name` and session metadata; only `cwd` is used.

How the command is read, so that no payload shape can crash the hook:

- `tool_input.command` (or `tool_input.cmd`) as a string;
- an argv array such as `["bash", "-lc", "gh pr merge 5"]`, joined with spaces;
- `tool_input` itself as a string;
- anything else counts as no command, and `post-tool-use` exits silently.

A payload that is empty, not JSON, or not a JSON object is ignored: `post-tool-use` does nothing, and `session-start` runs from the current directory.

**BOM handling:** Windows PowerShell 5.1 prefixes piped stdin with a UTF-8 byte order mark (EF BB BF), which would make `JSON.parse` fail. The janitor strips it, and decodes stdin as UTF-8 only after all bytes arrived, so a multi-byte character split across chunks is read correctly.

**Working directory:** the payload's `cwd` selects the repository (unless `--repo` is given) and, like the janitor's own working directory, protects the worktree it is in from removal.

## Report format

### Text

Dry run of a small repository (paths shortened):

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

Errors follow the lists as `error: <message>` lines. In a dry run, the branch of a `would-remove` worktree is evaluated as if the worktree were already gone.

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

| Field | Meaning |
| --- | --- |
| `repo` | Path of the main worktree |
| `base` | Base ref used, for example `origin/main` |
| `applied` | `true` with `--apply` or in hook mode, `false` for a dry run |
| `worktrees[]` | One entry per registered worktree, main worktree included: `path`, `branch` (`null` when detached), `action`, `reason`, and `stoppedAt` for `partial` |
| `branches[]` | One entry per local branch: `name`, `action`, `reason` |
| `errors[]` | Messages of failures and safety stops. Messages starting with `SAFETY` mean a safety check fired |

Worktree actions:

| Action | Meaning |
| --- | --- |
| `kept` | Left alone; `reason` says why |
| `would-remove` | Dry run: would be removed with `--apply` |
| `removed` | Directory deleted and registration pruned. The reason may add `; unlinked N link(s), targets untouched`, `; stale Claude Code lock (pid not alive)` or `; lock overridden by --include-locked`. For a worktree whose directory was already missing: `directory missing; registration pruned` |
| `partial` | Deletion started but stopped partway. `stoppedAt` is the path where it stopped; nothing after that was deleted; the worktree is still registered |

Branch actions: `kept`, `would-delete` (dry run), `deleted` (`git branch -D` succeeded).

## Exit codes

| Command | Code | When |
| --- | --- | --- |
| `janitor.mjs` | 0 | Run finished without errors (including a dry run, and a run with nothing to do) |
| `janitor.mjs` | 1 | Unknown argument, not a git repository, base branch not found, current directory deleted without an absolute `--repo`, any entry in `errors`, or any `partial` worktree |
| `janitor.mjs --hook ...` | 0 | Always |
| `install.mjs` | 0 | Success (also with `--help`) |
| `install.mjs` | 1 | A step failed (the message says which) |
| `install.mjs` | 2 | Unknown argument, or none of `--claude`, `--codex`, `--all` |

## Keep reasons and what to do

Worktrees, in the order the checks run:

| Reason | Meaning | What to do |
| --- | --- | --- |
| `main worktree` | The repository's primary checkout | Nothing; never removed |
| `bare repository entry` | The bare repository itself | Nothing |
| `locked by a live Claude Code process (pid N)` | A running Claude Code session or subagent uses it | Let it finish; it is cleaned up after the process exits |
| `locked: <reason>` / `locked` | Locked by a person or another tool | `git worktree unlock <path>`, or run with `--include-locked` |
| `detached HEAD (externally managed)` | No branch checked out | Remove it yourself if it is no longer needed |
| `contains the main worktree` | The main worktree is nested inside it | Nothing; never removed |
| `current working directory is inside it` | The janitor (or the hook's session) runs inside it | Run from somewhere else, for example the main worktree |
| `dirty: N modified/untracked path(s)` | `git status` is not empty | Commit, stash or delete the changes, then rerun |
| `git status failed: ...` | git could not read the worktree | Run `git status` there to see why |
| `not merged: N commit(s) not in <base>` | Work not in the base | Merge it, or leave it. If it was squash-merged, install and authenticate `gh` |
| `... (gh unavailable for squash check)` | Same, and `gh` could not be asked | Install `gh`, run `gh auth login`, or check the network |
| `0 commits ahead of <base> (fresh branch, not treated as merged)` | No own commits; could be a new branch or a fast-forward merge | Delete it yourself if unused; with `gh`, fast-forward-merged PRs are detected |
| `could not compare with base` | `git rev-list` failed | Check that the base and the branch exist (`git fetch`) |
| `contains populated submodule <path> (git refuses to remove such worktrees)` | Deleting would lose submodule data | Deinitialize the submodule (`git submodule deinit`) or remove the worktree by hand |
| `has submodule git dirs in <dir> (git refuses to remove such worktrees)` | Submodule object stores live in the worktree's admin dir | Same as above |
| `could not locate the worktree git dir` / `git ls-files failed: ...` | git metadata unreadable | Check the worktree with `git worktree list` and `git status` |
| `contains mount point <path>; unmount it first` | A mount at or below the worktree (`(+N more)` when several) | Unmount it (`umount`, or remove the drive mount on Windows), then rerun |
| `cannot read /proc/self/mountinfo (...)` / `/proc/self/mountinfo lists no mounts` | Linux only: mounts cannot be ruled out | Run where `/proc` is mounted (some containers and sandboxes hide it) |
| `cannot read <dir>; cannot rule out mount points, not deleting` | A directory inside could not be listed | Fix its permissions, or remove it yourself |
| `time budget exhausted while scanning for links and mount points` / `time budget exhausted` | Hook mode ran out of its ~20 s budget | Nothing; the next run continues. For huge trees run the CLI by hand (no budget) |
| `skipped after a safety abort` | An earlier worktree hit a safety stop in this run | Read the `SAFETY` error first |
| `removal failed: ...` | Deletion did not start or deleted nothing; includes `no longer registered`, and mount checks repeated right before deletion | Read the message; rerun after fixing the cause |

Branches:

| Reason | What to do |
| --- | --- |
| `base branch` / `protected branch name` | Nothing; `main`, `master`, `develop`, `trunk` and the base are never deleted |
| `checked out in worktree <path>` | Deleted once that worktree is removed |
| any `not merged` / `0 commits ahead` reason | As for worktrees above |
| `delete failed: ...` | Read git's message (`git branch -D <name>`) |
| `skipped after a safety abort` / `time budget exhausted` | As for worktrees above |

### partial

A `partial` worktree means deletion started and then stopped, for example because a directory turned out to be on another device (a mount appeared), changed type, was replaced, or could not be deleted (on Windows, typically a file held open by another program). Everything after the stop point was left alone: the directory at `stoppedAt`, the rest of the tree, the worktree's `.git` file (deleted last on purpose) and its registration. Its branch is kept because it is still checked out.

What to do:

1. Read the reason and the `errors` entry. Look at `stoppedAt`: is it a mount point, a link, a file in use?
2. Fix the cause: unmount, close the program holding the file, fix permissions.
3. The worktree now shows the already-deleted tracked files as deletions, so it reads as `dirty`. Either restore them with `git -C <worktree> restore .` and rerun the janitor, or, once you are certain nothing under the worktree is mounted or linked elsewhere, delete the remaining directory yourself and run `git worktree prune`.

In hook mode the one-line summary always mentions a partial removal (`PARTIAL removal of <name>: ...`).

## Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `install.mjs`, `install.sh`, `install.ps1` | Codex configuration directory (default `~/.codex`) |
| `HTTPS_PROXY`, `https_proxy` | `install.sh`, `install.ps1` | Proxy for the downloads; never printed |
| `WORKTREE_JANITOR_BASE_URL` | `install.sh`, `install.ps1` | Where the release assets are, instead of the GitHub release (a mirror): an https URL, a `file://` URL or a local directory |
| `WORKTREE_JANITOR_API_URL` | `install.sh`, `install.ps1` | Latest-release endpoint, instead of the GitHub API |
| `WORKTREE_JANITOR_NO_USER_PATH` | `install.ps1` | `1`: do not add the launcher directory to the user `PATH` |
| `JANITOR_GH` | `janitor.mjs` | Command to run instead of `gh`, for a `gh` that is not on `PATH`. A path ending in `.js`, `.mjs` or `.cjs` is run with the current Node.js/Bun executable. The test suite points it at a fake `gh` |
| `JANITOR_CLAUDE` | `install.mjs` | Command to run instead of the `claude` found on `PATH` (`.js`/`.mjs`/`.cjs` run with Node.js). Used by tests |
| `JANITOR_RUNTIME` | test suite | Executable that runs `janitor.mjs` in the tests, for example `bun`. The test runner itself is always Node.js |
| `JANITOR_REQUIRE_MOUNT_TESTS` | test suite | When set, a test fails if the Linux mount tests would be skipped (CI sets it on Ubuntu) |
| `JANITOR_TEST_FOREIGN_DEV_AT` | `janitor.mjs`, tests only | Makes the given directory report a foreign device once deletion has emptied it, to test the mid-deletion stop without root. **Never set it in normal use**: it makes deletions stop partway |

The janitor runs git and gh with `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1` and `GCM_INTERACTIVE=never`, so no credential prompt can block a hook.

## Platform notes

### Supported platforms

Exercised in CI (GitHub-hosted runners and containers):

| Platform | Janitor test suite | Installers and plugins |
| --- | --- | --- |
| Windows Server 2022 (build 20348, Windows 10 21H2 kernel), x64 | Node.js 18, 20, 22; NTFS volume mount points | `install.ps1` under Windows PowerShell 5.1 and PowerShell 7 |
| Windows Server 2025 (build 26100, Windows 11 24H2 kernel), x64 | Node.js 18, 20, 22; NTFS volume mount points and Dev Drive | `install.ps1` under 5.1 and 7; Claude Code and Codex plugins (real CLIs) |
| Windows 11, arm64 | Node.js 20, 22 (no Node.js 18 build exists for it) | - |
| macOS 15 and macOS 26, arm64 | Node.js 18, 20, 22; APFS and HFS+ disk images | macOS 15: `install.sh`, Homebrew, Claude Code and Codex plugins |
| macOS 15, Intel | Node.js 18, 20, 22 | `install.sh` |
| Ubuntu 24.04 (runner) | Node.js 18, 20, 22, Bun; bind mounts and tmpfs | `install.sh`, Homebrew on Linux, Claude Code and Codex plugins |
| Debian 11 / 12, Ubuntu 20.04 / 22.04 / 24.04 (containers) | as root with the mount suite, and as a user without sudo | `install.sh` without sudo on Debian 12 |
| Rocky Linux 8 / 9, AlmaLinux 8, RHEL UBI 8 / 9, CentOS Stream 9 / 10 (containers) | as root with the mount suite, and as a user without sudo | `install.sh` without sudo on Rocky Linux 9 |
| CentOS 7 | unsupported: git 1.8.3 has no `git worktree`. A manual run exits 1 with `git 2.7 or newer is required`, a hook exits 0 silently, nothing is deleted | - |

Each container uses its distribution's own git (2.25.1 to 2.52), util-linux and, where it is 18 or newer, its own Node.js. The containers share the Ubuntu runner's kernel, so SELinux is not enforcing in any of them: the Red Hat images exercise RHEL userland, not RHEL's kernel or SELinux policy. The mount tests use real mounts and fail CI if they would be skipped: VHDX volumes mounted on a directory (Windows), `hdiutil` disk images (macOS), `mount --bind` and tmpfs (Linux), each checked to leave the mounted data intact.

### Windows

- **Junctions:** Node.js and Bun report NTFS junctions as symbolic links. A directory that still answers `readlink` is treated as a link too. Links are removed with unlink, then `rmdir` (without `/s`), then `cmd /c rmdir` as a last resort; each of these removes the link only.
- **Long paths:** all file operations use `\\?\` paths, so worktrees nested deeper than `MAX_PATH` (260 characters), common with `node_modules`, are deleted correctly.
- **Case:** paths are compared case-insensitively, after resolving them to their real path.
- **Mounted volumes:** a volume mounted into a folder (NTFS, ReFS or a Dev Drive) is not reported as a link by `lstat`, but its device ID differs from the worktree's, so the device-ID check keeps the worktree as `contains mount point`. Verified in CI with VHDX volumes on Windows Server 2022 and 2025.
- **Files in use:** Windows cannot delete a file another process holds open, or a directory that is some process's current directory; either stops the deletion (`partial`).
- **PowerShell 5.1** adds a BOM to piped stdin; it is stripped.
- **File symlinks** in a checkout need Developer Mode or admin rights, and git checks them out as plain text files when `core.symlinks=false`. Junctions need no privileges.
- Codex runs hook commands through `powershell.exe -NoProfile -Command`; the installer's quoting accounts for that.

### macOS

- `/var` and `/tmp` are symlinks into `/private`. git prints real paths, hook payloads may not, so every comparison resolves real paths first; a path that no longer exists is resolved through its nearest existing parent.
- APFS is case-insensitive by default but can be case-sensitive, so paths are compared exactly after resolving them, with a device and inode comparison as a second check. A false match only ever keeps a worktree.
- The device-ID check detects mounted volumes; there is no mountinfo. Verified in CI with APFS and HFS+ disk images attached inside a worktree.

### Linux

- Mount points are read from `/proc/self/mountinfo` (field 5, octal escapes such as `\040` decoded). If the file is unreadable or lists nothing, every candidate worktree is kept.
- Filesystems are treated as case-sensitive: `/src/Wt` and `/src/wt` are different directories.
- If the directory the janitor was started in has been deleted (a hook firing in a just-removed worktree), it still runs when given an absolute `--repo` (or an absolute `cwd` in the hook payload). Otherwise a manual run exits 1 with `current directory no longer exists; pass an absolute --repo`, and a hook exits 0 silently. (Windows cannot delete a process's working directory, so this does not arise there.)

### All platforms

- Text files are checked out with LF line endings (`.gitattributes`), so a clone made on Windows also runs on Linux and macOS.
- The script needs only the Node.js standard library; it runs the same under Bun.

## Uninstall

| Installed with | Remove with |
| --- | --- |
| Claude Code plugin | `claude plugin uninstall worktree-janitor@worktree-janitor-marketplace` then `claude plugin marketplace remove worktree-janitor-marketplace` |
| Codex plugin | `codex plugin remove worktree-janitor@worktree-janitor-marketplace` then `codex plugin marketplace remove worktree-janitor-marketplace` |
| `install.mjs --claude` | `node scripts/install.mjs --claude --uninstall` (from the same clone) |
| `install.mjs --codex` | `node scripts/install.mjs --codex --uninstall` (add `--dry-run` first to preview) |
| Manual Codex setup | `node scripts/install.mjs --codex --uninstall` if you used the `config.toml` template with its markers; otherwise delete the two hook groups by hand |
| `install.ps1` (Windows) | `& ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1))) -Uninstall` |
| `install.sh` (macOS, Linux) | `curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh \| sh -s -- --uninstall` |
| Homebrew | `brew uninstall worktree-janitor && brew untap erictheng93/worktree-janitor` (first remove Codex hooks you added from `brew info` with `--codex --uninstall`) |
| Plain CLI, release archive | Delete the clone or the unpacked directory |

The installers' uninstall leaves a `worktree-janitor-marketplace` that comes from somewhere else (the GitHub marketplace or another directory) untouched, and reports it.

## Troubleshooting

### The hooks do not run

- **Codex: hooks not trusted.** Open `/hooks` (desktop app: Settings > Hooks) and trust both worktree-janitor hooks. `codex exec` skips untrusted hooks silently. After every plugin update, and after reinstalling installer hooks from a different path or with a different node, they must be trusted again.
- **Plugin not enabled.** `claude plugin list` or `codex plugin list` should show it installed and enabled. Restart the agent after installing.
- **`node` not on `PATH` (Claude Code).** The Claude Code plugin's hooks run `node` by name. Check `node --version` in the environment the agent starts from: the desktop app launched from the Dock or the Start menu may not see your shell's `PATH` ([Claude Code plugin](#claude-code-plugin)). Codex hooks search the usual install locations as well, but nvm, asdf, mise and `n` installs only through `PATH`.
- **`post-tool-use` did nothing.** By design it acts only when the shell command contains `gh pr merge`. Merges made in the browser or another tool are picked up at the next session start.
- **Nothing printed.** The hooks are silent unless something was removed. Run `node scripts/janitor.mjs --repo <repo>` to see the full report.

### A worktree was kept

Run a dry run and read its reason, then see [Keep reasons and what to do](#keep-reasons-and-what-to-do):

```
node scripts/janitor.mjs --repo <repo>
```

Common cases: untracked files make a worktree `dirty`; a squash-merged branch needs `gh` (installed and authenticated); a branch whose PR head differs from the local tip is not treated as merged.

### A removal stopped partway

See [partial](#partial).

### Duplicate summaries

If each summary appears twice in Codex, both the plugin and installer hooks (from `install.sh`, `install.ps1`, `install.mjs` or Homebrew's `brew info` command) are active. Remove one of them ([Uninstall](#uninstall)).

## FAQ

**Does a dry run change anything?**
No worktree or branch. It runs `git fetch --prune origin`, which updates remote-tracking refs.

**Does it delete remote branches?**
No. Only local branches. Use `gh pr merge --delete-branch` or your hosting service for remote ones.

**Why not just call `git worktree remove`?**
Because its recursive delete follows NTFS junctions on Windows and crosses into mount points on every OS. The janitor does its own fail-closed deletion instead.

**Will it delete my `node_modules` junction target?**
No. The junction is unlinked and its target is checked to still exist afterwards; if the target vanished, that is a `SAFETY` error and the run stops.

**What if I use GitLab or Bitbucket?**
Everything except squash-merge detection works, because that needs `gh`. Squash-merged branches are kept; remove them yourself.

**Can I run it from cron or CI?**
Yes: `node scripts/janitor.mjs --repo <repo> --apply --json` and check the exit code.

**Does it need network access?**
No. Without it the fetch fails silently and the local base is used; `gh` is disabled for the run.

**Can a hook block or fail my session?**
No. Hooks always exit 0, stop after about 20 seconds (the hook timeout is 30), and never prompt for credentials.

## Known limitations

- **Physical machines:** every platform is verified through CI (GitHub-hosted runners and containers), not on physical hardware.
- **SELinux** in enforcing mode is not exercised; the RHEL-family containers run on the Ubuntu runner's kernel.
- **git older than 2.7** (CentOS 7 ships 1.8.3) is refused. The oldest git exercised is 2.25.1.
- **Claude Code plugin hooks need `node` on the Claude Code process's `PATH`**; a desktop app launched from the Dock or the Start menu may not have it. A `userConfig` option for the node path was rejected: Claude Code never applies a default for hooks, so every user would have to set it before the hooks work.
- **Codex hook fallbacks** cover `PATH`, Homebrew, Volta and fnm; nvm, asdf, mise and `n` only through `PATH` (installer hooks also try the absolute node recorded at install time). If neither PowerShell is present on Windows, Codex falls back to `cmd.exe /c`, which cannot run `command_windows`.
- **Codex plugin hooks must be re-trusted after every plugin update** (Codex hashes all plugin files); installer hooks only when the command text changes.
- **`install.sh --uninstall`** needs the script downloaded again; it is not part of the installed files.
- **Homebrew installs whatever release the formula points to**; there is no per-version formula. Use `brew pin` to stay on a release.
- **btrfs subvolumes, overlayfs and similar** can report a different device ID for directories on the same filesystem. Such a worktree is kept as `contains mount point`: a false positive, but a safe one.
- **Fast-forward merges** leave nothing in git history that distinguishes them from a fresh branch; they are detected only through `gh`.
- **Branches that contain their own merge commits** (for example after merging the base into the branch) may not be recognized by `git cherry`; they need `gh`.
- **Only `gh pr merge` triggers the post-tool hook.** Merges done elsewhere (web UI, another tool, a teammate) are caught at the next session start, or when you run the janitor by hand.
- Squash detection requires the PR's head commit to equal the local branch tip, looks at up to 30 merged PRs per branch, and only works for GitHub repositories.
- Hook runs are capped at about 20 seconds; very large worktrees may take several sessions, or a manual run.
- Only the remote named `origin` is fetched.

# Installation notes (facts for the README and manual)

Raw material for whoever writes the user-facing docs: exact commands, the
recommended channel for each audience, and every limitation found while
building and testing the channels. Versions below use `v0.1.0`; substitute
the release being documented. "Verified" means exercised by CI
(`.github/workflows/install-channels.yml`) or by hand with throwaway config
directories; anything else is marked.

## Which channel to recommend

| Audience | Recommended channel | Why |
| --- | --- | --- |
| Uses Claude Code (CLI or desktop app) | Claude Code plugin from the GitHub marketplace, pinned to a tag | No local files to manage; the plugin ships the hooks and `/worktree-janitor:clean-worktrees` |
| Uses Codex (CLI or desktop app) | Codex plugin from the GitHub marketplace, pinned with `--ref`, then trust its hooks | Same, for Codex; plugin hooks find `node` without PATH |
| Uses neither, macOS or Linux | Homebrew | Updates with `brew upgrade`; node comes as a dependency |
| Uses neither, Windows | `install.ps1` | No admin; puts `worktree-janitor` on the user PATH |
| Wants one verified copy for scripts, or uses both CLIs from one copy | `install.sh` / `install.ps1` with `--claude --codex` | sha256-verified release archive; hook paths survive upgrades |

Use one channel per tool. A Claude plugin from the GitHub marketplace and the
installer's local marketplace have the same marketplace name; the installers
leave a plugin from another channel alone (they say "skipped" and change
nothing). For Codex, the plugin and `install.mjs --codex` hooks together run
the janitor twice; `install.mjs` warns when it sees the plugin enabled.

## Prerequisites

The janitor needs Node.js 18+ and git 2.7+ (`gh` optional, for squash-merge
detection).

| OS | node + git |
| --- | --- |
| macOS | `brew install node git` (or the nodejs.org pkg; Xcode CLT provides git) |
| Debian / Ubuntu | `sudo apt-get install nodejs git` (Debian 12 and Ubuntu 24.04 ship Node 18; older releases need NodeSource or nodejs.org) |
| Fedora / RHEL / Rocky / Alma | `sudo dnf install nodejs git` (RHEL 8/9 family: `sudo dnf module install nodejs:20/common`) |
| Windows | `winget install OpenJS.NodeJS.LTS` and `winget install Git.Git` |

`install.sh` also needs `curl` or `wget`, `tar`, and one of `sha256sum`,
`shasum`, `openssl` (all present on stock macOS, Debian, Ubuntu, RHEL
family). `install.ps1` needs nothing beyond Windows PowerShell 5.1.

## Claude Code plugin (CLI and desktop app)

Claude Code's CLI and desktop app share `~/.claude`, so installing from a
terminal makes the plugin available in both (restart the app).

- Install (pinned to a tag):
  ```
  claude plugin marketplace add erictheng93/worktree-janitor@v0.1.0
  claude plugin install worktree-janitor@worktree-janitor-marketplace
  ```
  One-step form (Claude Code 2.1.292+):
  `claude plugin install worktree-janitor --marketplace erictheng93/worktree-janitor@v0.1.0`.
  `owner/repo#v0.1.0` is accepted too. Nothing prompts; the plugin has no
  `userConfig`.
- Verify: `claude plugin list` shows `worktree-janitor@worktree-janitor-marketplace`
  with version `0.1.0`; in a session, `/worktree-janitor:clean-worktrees`
  exists; `claude --debug-file <file>` logs
  `Hooks: SessionStart:startup [node .../scripts/janitor.mjs --hook session-start] ... finished with status 0`.
- Update to a new tag: `claude plugin marketplace update` stays on the pinned
  ref, so move the pin:
  ```
  claude plugin marketplace remove worktree-janitor-marketplace
  claude plugin install worktree-janitor --marketplace erictheng93/worktree-janitor@v0.2.0
  ```
  Claude Code only updates a plugin when its `version` changes, so every
  release must bump `.claude-plugin/plugin.json` (the release workflow
  refuses a tag that does not match the manifests). Restart sessions after
  updating.
- Uninstall:
  ```
  claude plugin uninstall worktree-janitor@worktree-janitor-marketplace
  claude plugin marketplace remove worktree-janitor-marketplace
  ```

Verified in CI on ubuntu, macos-15 and windows-2025 with the real `claude`
CLI and a throwaway `CLAUDE_CONFIG_DIR`, pinned to the branch under test
(`owner/repo@<branch>`): install, then `claude -p` in a repository with a
merged worktree removes it through the SessionStart hook (the hook runs
before the login check, so no account is needed for this test). Pinning to a
tag and the remove/re-add update could not be exercised: no tag exists yet.

### Node for the Claude plugin hooks

The hooks are exec form: `"command": "node"` with the script in `args`, so
Claude Code needs `node` on the PATH of its own process. A terminal session
has it. The desktop app started from the Dock / Start menu may not:
macOS apps launched by launchd get `/usr/bin:/bin:/usr/sbin:/sbin` unless
the app imports the login shell's environment (not verified for the Claude
desktop app). If the hooks do not run in the desktop app, put node where the
app's PATH finds it or start the app from a terminal.

`userConfig` was investigated and rejected. Claude Code substitutes
`${user_config.node_path}` into an exec-form `command`, but only once the
user has set a value: a `default` in the manifest is never used for hooks,
`claude plugin install` from a shell never prompts (it prints "1 userConfig
option not yet set"), and the hook then fails on every event with
`Plugin option "node_path" isn't set`. Values can be set with
`claude plugin install ... --config node_path=/abs/node` or
`claude plugin configure ... --values-stdin`, which would make a required
onboarding step. Tested with Claude Code 2.1.331 in a throwaway config dir.

## Codex plugin (CLI and desktop app)

Codex CLI and the desktop app share `CODEX_HOME` (default `~/.codex`).

- Install (pinned):
  ```
  codex plugin marketplace add erictheng93/worktree-janitor --ref v0.1.0
  codex plugin add worktree-janitor@worktree-janitor-marketplace
  ```
  (`owner/repo@v0.1.0` also works.) Then trust the two hooks: CLI `/hooks`
  (or the prompt at startup), desktop app Settings > Hooks. Untrusted hooks
  never run, and `codex exec` skips them silently.
- Verify: `codex plugin list` shows `worktree-janitor@worktree-janitor-marketplace`
  enabled with version `0.1.0`; `/hooks` lists a SessionStart and a
  PostToolUse (`Bash`) hook from the plugin; the skill is `$clean-worktrees`
  (explicit invocation only).
- Update to a new tag: re-adding with another `--ref` fails ("already added
  from a different source"), so:
  ```
  codex plugin remove worktree-janitor@worktree-janitor-marketplace
  codex plugin marketplace remove worktree-janitor-marketplace
  codex plugin marketplace add erictheng93/worktree-janitor --ref v0.2.0
  codex plugin add worktree-janitor@worktree-janitor-marketplace
  ```
  then trust the hooks again: Codex hashes every file of an installed plugin
  for hook trust, so any update needs a new approval. (Editing `ref` in
  `config.toml` and running `codex plugin marketplace upgrade` should also
  work; not tested.)
- Uninstall: the first two commands above. An empty
  `$CODEX_HOME/plugins/cache/worktree-janitor-marketplace` directory is left.

Plugin hook commands do not need `node` on PATH: on macOS/Linux they try
node on PATH, `/opt/homebrew/bin/node`, `/usr/local/bin/node`,
`~/.volta/bin/node`, fnm's default alias (`~/.local/share/fnm/...` and
`~/Library/Application Support/fnm/...`), and exit 0 silently when none
exists; on Windows (`commandWindows`, run by `pwsh` or `powershell
-NoProfile -Command`) node.exe on PATH, then `%ProgramFiles%\nodejs\node.exe`.
nvm, asdf, mise and `n` installs are found only through PATH.

Verified in CI on ubuntu, macos-15 and windows-2025 with the real `codex`
CLI (throwaway `CODEX_HOME`): plugin from a local marketplace and from GitHub
with `--ref <branch>`; `codex exec --dangerously-bypass-hook-trust` in a
repository with a merged worktree removes it through the plugin's
SessionStart hook. The trust UI itself was not exercised.

## install.sh (macOS, Linux)

- Install the latest release (after the first one exists):
  ```
  curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh
  ```
  Pinned, with options:
  ```
  curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.sh | sh -s -- --version v0.1.0 --codex
  ```
- Options: `--version vX.Y.Z` (default: latest via the GitHub API; clear
  error when there is no release), `--dir DIR` (default `~/.worktree-janitor`),
  `--bin-dir DIR` (default `~/.local/bin`), `--node PATH`, `--claude`,
  `--codex`, `--all`, `--none` (default: integrations for whichever of
  `claude` / `codex` is on PATH), `--uninstall`, `--dry-run`.
- What it creates: `~/.worktree-janitor/v0.1.0/` (the archive, after the
  sha256 matched SHA256SUMS), the symlink `~/.worktree-janitor/current`, and
  `~/.local/bin/worktree-janitor`, a launcher that runs the absolute node found
  at install time (falling back to node on PATH). With `--codex`: hooks in
  `$CODEX_HOME/hooks.json` if that file exists, else a marked block in
  `$CODEX_HOME/config.toml`, the skill in `~/.agents/skills/clean-worktrees`,
  a rule in `$CODEX_HOME/AGENTS.md`; the hooks point at
  `~/.worktree-janitor/current/scripts/janitor.mjs` and record the absolute
  node first. With `--claude`: a local marketplace at
  `~/.worktree-janitor/current` and the plugin (user scope).
- Verify: `worktree-janitor --help`; `readlink ~/.worktree-janitor/current`.
  `~/.local/bin` is not on PATH by default on macOS; the installer prints the
  line to add.
- Update: run it again (latest) or with `--version`. Same version: nothing is
  downloaded. New version: `current` moves, older versions it installed are
  deleted, Codex hook commands stay the same (no re-trust) unless the node
  path changed, and the Claude local plugin is read from `current` in place.
- Uninstall: `curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh -s -- --uninstall`
  (the script is not inside the archive; download it again). Removes the
  integrations (all, unless `--claude`, `--codex` or `--none` narrows it),
  the launcher, and only files it created; the install directory goes when
  empty. Empty `~/.agents/skills` directories stay.
- Environment: `HTTPS_PROXY` / `https_proxy` (curl, wget), never printed;
  `WORKTREE_JANITOR_BASE_URL` (mirror: https URL, `file://` URL or local
  directory) and `WORKTREE_JANITOR_API_URL`.
- No sudo, ever. A truncated download runs nothing (everything is inside
  functions called on the last line).

Verified in CI: ubuntu-latest, macos-15 (arm64), macos-15-intel, debian:12
and rockylinux:9 (as a user without sudo), each with install `--none`,
`worktree-janitor --help`, a dry run, the launcher without node on PATH,
idempotent reinstall, `--dry-run`, tampered archive rejected with nothing
changed, missing release error, truncated script, uninstall leaving no file;
then fake `claude`/`codex` CLIs: auto-detection, the installed SessionStart
hook run with `sh -c`, `bash -c`, `zsh -c`, `dash -c` (whichever exist)
without node on PATH removes a merged worktree, idempotent reinstall,
uninstall restoring `hooks.json` byte for byte. Downloads over https from a
real release are only exercised by the release workflow's smoke job.

## install.ps1 (Windows)

- Install the latest release:
  ```
  irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1 | iex
  ```
  With options (`iex` cannot pass any):
  ```
  & ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/download/v0.1.0/install.ps1))) -Version v0.1.0 -Codex
  ```
  From a downloaded file: `powershell -ExecutionPolicy Bypass -File install.ps1 -All`.
- Options: `-Version`, `-Dir` (default `%LOCALAPPDATA%\worktree-janitor`),
  `-Node`, `-Claude`, `-Codex`, `-All`, `-None`, `-Uninstall`, `-DryRun`.
- What it creates: `<Dir>\v0.1.0\`, the junction `<Dir>\current`,
  `<Dir>\bin\worktree-janitor.cmd` (plus `<Dir>\bin\worktree-janitor`, an sh
  launcher for Git Bash, where `.cmd` files are not found without the
  extension), and `<Dir>\bin` appended to the user PATH (HKCU, kept as
  REG_EXPAND_SZ). Open a new terminal afterwards. Integrations as for
  install.sh (Codex hooks get `command_windows`).
- Verify: new terminal, `worktree-janitor --help`.
- Update: run it again. Uninstall: the scriptblock form with `-Uninstall`;
  the user PATH entry is removed and the PATH string comes back exactly.
- Environment: `HTTPS_PROXY` (credentials in the URL are passed as a
  PSCredential, never printed), `WORKTREE_JANITOR_NO_USER_PATH=1` (do not
  touch the user PATH), `WORKTREE_JANITOR_BASE_URL`, `WORKTREE_JANITOR_API_URL`.
- No admin. Windows PowerShell 5.1 gets TLS 1.2 enabled for the download.

Verified in CI on windows-2022 and windows-2025, installer run under Windows
PowerShell 5.1 and under PowerShell 7: the same checks as install.sh, plus
the user PATH round trip, `worktree-janitor` through `cmd.exe`, and the
installed Codex hook run under both `powershell` and `pwsh -NoProfile
-Command` without node on PATH.

## Homebrew (macOS, Linux)

The formula lives in this repository (`Formula/worktree-janitor.rb`); there
is no separate tap repository, so the tap needs the explicit URL:

```
brew tap erictheng93/worktree-janitor https://github.com/erictheng93/worktree-janitor
brew trust erictheng93/worktree-janitor
brew install erictheng93/worktree-janitor/worktree-janitor
```

`brew trust` is required: current Homebrew (7.0.14 on the CI runners)
refuses to load a formula from a third-party tap until the tap is trusted,
with "Refusing to load formula erictheng93/worktree-janitor/worktree-janitor
from untrusted tap erictheng93/worktree-janitor. Run `brew trust --formula
erictheng93/worktree-janitor/worktree-janitor` or `brew trust
erictheng93/worktree-janitor` to trust it." (`--formula` trusts only that
one formula.) Older Homebrew has no `brew trust` command and needs no such
step (4.6.20, the `homebrew/brew` Docker image at the time, says "Unknown
command: brew trust"), so the docs should say "run `brew trust ...` if your
Homebrew asks for it" or give it as a separate step.

- Verify: `worktree-janitor --help`; `brew test worktree-janitor`.
- Update: `brew update && brew upgrade worktree-janitor` (picks up a release
  once its formula pull request is merged).
- Uninstall: `brew uninstall worktree-janitor && brew untap erictheng93/worktree-janitor`.
- The formula installs into `libexec`, depends on Homebrew's `node`, and its
  `bin/worktree-janitor` wrapper runs `$(brew --prefix)/opt/node/bin/node` by
  absolute path. It never writes Claude or Codex settings; `brew info`
  shows caveats with the plugin commands and, for Codex hooks that run the
  Homebrew copy:
  ```
  $(brew --prefix)/opt/node/bin/node $(brew --prefix)/opt/worktree-janitor/libexec/scripts/install.mjs --codex --node $(brew --prefix)/opt/node/bin/node
  ```
  Those hooks point at the `opt/` path, so they survive `brew upgrade`
  (verified across a reinstall); run the same command with `--uninstall`
  before `brew uninstall`.

Verified in CI on macos-15 and ubuntu-latest (Linuxbrew): `brew style` and
`brew audit --strict` of the committed formula through the real tap layout
(`brew tap <name> <repo>`), install from a throwaway tap whose url is a
`file://` tarball built from the commit, `brew test`, the wrapper without node
on PATH, caveats, Codex hooks on the `opt/` path across a reinstall,
uninstall. `brew audit --strict --new` additionally reports only "The
source URL ... is not reachable (HTTP status code 404)" until the release
exists (checked with Homebrew 4.6.20 in Docker), so CI runs `--strict`
without `--new`. The committed `sha256` is a placeholder until the first release:
`brew install` from the tap fails until the release workflow's formula pull
request is merged.

## Releasing (for maintainers)

1. Set the version in `package.json`, `.claude-plugin/plugin.json` and
   `.codex-plugin/plugin.json`, add a `## [X.Y.Z]` section to CHANGELOG.md.
2. Push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` tests, builds the assets twice
   (byte-identical), runs both installers on them, publishes the release
   (not a draft) with `worktree-janitor-vX.Y.Z.tar.gz`, `.zip`, `install.sh`,
   `install.ps1`, `SHA256SUMS` and build provenance attestations
   (`gh attestation verify worktree-janitor-vX.Y.Z.tar.gz -R erictheng93/worktree-janitor`),
   smoke-installs from the published release on Linux, macOS and Windows,
   and opens a pull request updating the formula.
4. Merge that pull request. It is opened with `GITHUB_TOKEN`, which does not
   trigger CI (close and reopen it to run checks), and needs "Allow GitHub
   Actions to create and approve pull requests" in the repository settings;
   otherwise the branch `formula/vX.Y.Z` is pushed and a warning says so.

`workflow_dispatch` on the release workflow (once it is on `main`) and pull
requests that touch the release files run the same pipeline as a dry run
that stops after uploading the assets as a workflow artifact.

## Limitations found

- Claude plugin hooks need `node` on the Claude process's PATH (see above);
  a desktop app launched from the Dock may not have it.
- Codex hook fallbacks cover PATH, Homebrew, Volta and fnm; nvm/asdf/mise
  only through PATH (the installers additionally record the absolute node).
  If neither PowerShell is present on Windows, Codex falls back to
  `cmd.exe /c`, which cannot run `commandWindows`.
- Codex plugin hooks must be re-trusted after every plugin update (content
  hash over all plugin files); hooks from `install.mjs` only when the command
  text changes (another install directory or node path).
- `install.sh` uninstall requires downloading the script again.
- The gzip/zip bytes are reproducible for a given Node.js (zlib) build; the
  release workflow pins Node.js 22.23.2. The uncompressed tar is identical
  everywhere.
- The installers' https download path and `releases/latest` resolution
  against a real release are untested until v0.1.0 exists (CI uses local
  assets and a local latest-release JSON).

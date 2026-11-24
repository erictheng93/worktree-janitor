# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-24

First release. worktree-janitor removes git worktrees and local branches whose work is already merged, without ever deleting through a link or into a mount. It runs automatically as a Claude Code or Codex plugin, or by hand as the `worktree-janitor` command. Installation for every channel: [README](https://github.com/erictheng93/worktree-janitor#installation).

### Added

- `scripts/janitor.mjs`: removes git worktrees whose branch is merged into the base branch (merge commit, rebase merge via `git cherry`, squash merge via `gh`) and deletes merged local branches plus Claude Code's `worktree-*` companion branches. Node.js 18+ standard library only; also runs under Bun.
- Dry run by default; `--apply`, `--repo`, `--base`, `--json`, `--include-locked`, and `--hook session-start|post-tool-use` (implies `--apply`, bounded to about 20 seconds, always exits 0).
- Keeps the main worktree, detached HEADs, dirty or untracked trees, worktrees locked by a live or unknown owner (Claude Code locks whose PID is gone count as stale), fresh 0-commit branches, and the worktree the current directory or the hook session is in. Every keep decision has a one-line reason.
- **Claude Code plugin**, installable from the GitHub marketplace pinned to a tag (`claude plugin marketplace add erictheng93/worktree-janitor@v0.1.0`): `SessionStart` and `PostToolUse` (`Bash|PowerShell`, acts only after `gh pr merge`) hooks in exec form, and the `/worktree-janitor:clean-worktrees` command (dry run, then apply after confirmation).
- **Codex plugin**, installable from the GitHub marketplace with `--ref v0.1.0`: `SessionStart` and `PostToolUse` hooks plus the `$clean-worktrees` skill (explicit invocation only). The hooks find `node` without `PATH` (Homebrew, Volta, fnm, `%ProgramFiles%\nodejs`), so they work in the desktop app too, and exit 0 quietly when there is no node.
- Codex `PostToolUse` payloads are accepted (`tool_name` `Bash` on every OS, command as a plain string, argv arrays, shell wrappers, `gh.exe`); a UTF-8 BOM on stdin (Windows PowerShell 5.1) is stripped.
- **`install.ps1`** for Windows PowerShell 5.1 and PowerShell 7: installs a release into `%LOCALAPPDATA%\worktree-janitor` and adds the `worktree-janitor` launcher to the user `PATH`, without admin rights. `-Version`, `-Dir`, `-Node`, `-Claude`, `-Codex`, `-All`, `-None`, `-Uninstall` (restores the user `PATH` exactly), `-DryRun`.
- **`install.sh`** for macOS and Linux (POSIX sh, never sudo): installs a release into `~/.worktree-janitor` with the launcher in `~/.local/bin`. `--version`, `--dir`, `--bin-dir`, `--node`, `--claude`, `--codex`, `--all`, `--none`, `--uninstall`, `--dry-run`. A truncated download runs nothing.
- Both installers download the release archive and `SHA256SUMS`, refuse to install on any checksum doubt, keep versions side by side behind a `current` link so hook paths (and Codex hook trust) survive upgrades, are idempotent, and set up the Claude Code / Codex integrations for the CLIs found on `PATH` unless told otherwise. `HTTPS_PROXY`, and `WORKTREE_JANITOR_BASE_URL` for mirrors, are supported.
- **Homebrew formula** in this repository (`brew tap erictheng93/worktree-janitor https://github.com/erictheng93/worktree-janitor`, then `brew trust` where Homebrew requires it): depends on Homebrew's node and runs it by absolute path; `brew info` shows the plugin commands and how to point Codex hooks at the Homebrew copy.
- `scripts/install.mjs` (`--claude`, `--codex`, `--all`, `--uninstall`, `--dry-run`, `--root`, `--node`): installs the Claude Code plugin from a local directory, or Codex hooks (in `hooks.json` if present, else a marked `config.toml` block), skill and `AGENTS.md` rule. Idempotent, keeps Codex hook trust, backs up files once and restores the original bytes on uninstall, warns when the Codex plugin is also enabled, and leaves a Claude Code plugin from another channel alone.
- `integrations/codex/`: `config.toml` and `hooks.json` templates for manual Codex setup, kept in sync with the installer by a test.
- Release assets: `worktree-janitor-vX.Y.Z.tar.gz` and `.zip`, `install.sh`, `install.ps1` and `SHA256SUMS`, each with a GitHub build provenance attestation (`gh attestation verify`). The release workflow builds them twice and requires identical bytes, runs both installers on them, smoke-installs from the published release on Linux, macOS and Windows, and opens the formula update.
- User manual and README in English and Traditional Chinese.

### Safety

- The janitor never calls `git worktree remove`. It deletes worktrees itself: links (symlinks, junctions) are unlinked, never followed, and their targets are checked intact; each directory is re-checked before descending and before removal (plain directory, same inode, same device as the worktree root); the first surprise stops deletion and is reported as action `partial` with `stoppedAt` (exit 1); the worktree's `.git` file is deleted last.
- Worktrees containing a mount point are kept (Linux: `/proc/self/mountinfo`, failing closed when unreadable; every OS: a device-ID change at any depth), checked before anything is deleted, dry run included, and again right before deletion. Nothing is ever unmounted.
- Worktrees with a populated submodule or submodule git dirs are kept, as `git worktree remove` would refuse them.
- Locks are also read from the worktree's admin directory, so git older than 2.31 (no `locked` line in `git worktree list --porcelain`) still keeps locked worktrees. A git without `git worktree list` (older than 2.7) is refused: exit 1 by hand, a silent exit 0 in hook mode, nothing deleted.
- Paths are compared by realpath and device+inode, with case folding only on Windows (macOS `/var` vs `/private/var`, case-sensitive APFS and Linux handled); Windows long paths use `\\?\`.
- Works when started in a deleted directory on POSIX (given an absolute `--repo`).
- Git and gh never prompt for credentials (`GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, `GCM_INTERACTIVE=never`), so a hook cannot hang.

### Quality

- `scripts/janitor.mjs` is type-checked with TypeScript in strict mode from JSDoc annotations (`npm run typecheck`, a CI job). There is no build step: the script runs as written and still has no runtime dependencies.
- CI runs the suite with Node.js 18, 20 and 22 on Ubuntu, macOS 15, macOS 26, macOS 15 Intel, Windows Server 2022, Windows Server 2025 and Windows 11 arm64 (Node.js 20 and 22 there), plus a Bun job.
- Real mount tests are required, so a skipped mount test fails CI: bind mounts and tmpfs on Linux, APFS and HFS+ disk images on macOS, NTFS VHDX volumes and Dev Drive mounted on a directory on Windows.
- A Linux distribution matrix runs the suite as root and as a user without sudo on Debian 11 and 12, Ubuntu 20.04, 22.04 and 24.04, Rocky Linux 8 and 9, AlmaLinux 8, RHEL UBI 8 and 9, and CentOS Stream 9 and 10, each with its own git; CentOS 7 (git 1.8.3) is checked to be refused cleanly.
- Every install channel is exercised in CI: `install.sh` on Ubuntu, macOS arm64 and Intel, Debian 12 and Rocky Linux 9 (without sudo); `install.ps1` under Windows PowerShell 5.1 and PowerShell 7 on Windows Server 2022 and 2025; Homebrew (`brew style`, `brew audit --strict`, install, `brew test`, uninstall) on macOS and Linux; the Claude Code and Codex plugins with the real CLIs on Ubuntu, macOS and Windows, each removing a merged worktree through its hook.
- Text files are checked out with LF on every platform.

# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-24

First release.

### Added

- `scripts/janitor.mjs`: removes git worktrees whose branch is merged into the base branch (merge commit, rebase merge via `git cherry`, squash merge via `gh`) and deletes merged local branches plus Claude Code's `worktree-*` companion branches. Node.js 18+ standard library only; also runs under Bun.
- Dry run by default; `--apply`, `--repo`, `--base`, `--json`, `--include-locked`, and `--hook session-start|post-tool-use` (implies `--apply`, bounded to about 20 seconds, always exits 0).
- Keeps the main worktree, detached HEADs, dirty or untracked trees, worktrees locked by a live or unknown owner (Claude Code locks whose PID is gone count as stale), fresh 0-commit branches, and the worktree the current directory or the hook session is in.
- Claude Code plugin: `SessionStart` and `PostToolUse` (`Bash|PowerShell`, acts only after `gh pr merge`) hooks in exec form, and the `/worktree-janitor:clean-worktrees` command (dry run, then apply after confirmation).
- Codex CLI plugin with a local marketplace (`.codex-plugin/`, `.agents/plugins/marketplace.json`): inline hooks run from `${PLUGIN_ROOT}`, plus the `$clean-worktrees` skill (explicit invocation only).
- Codex CLI `PostToolUse` payloads are accepted (`tool_name` `Bash` on every OS, command as a plain string, argv arrays, shell wrappers, `gh.exe`); a UTF-8 BOM on stdin (Windows PowerShell 5.1) is stripped.
- `scripts/install.mjs` (`--claude`, `--codex`, `--all`, `--uninstall`, `--dry-run`): installs the Claude Code plugin from a local clone, or Codex hooks (in `hooks.json` if present, else a marked `config.toml` block), skill and `AGENTS.md` rule. Idempotent, keeps Codex hook trust, backs up files once and restores the original bytes on uninstall.
- `integrations/codex/`: `config.toml` and `hooks.json` templates for manual Codex setup, kept in sync with the installer by a test.
- CI on Ubuntu, macOS and Windows with Node.js 18, 20 and 22, plus a Bun job. Real mount tests are required on Ubuntu (bind mounts and tmpfs via `sudo mount`) and on macOS (disk images attached with `hdiutil`), so a skipped mount test fails CI.

### Safety

- The janitor never calls `git worktree remove`. It deletes worktrees itself: links (symlinks, junctions) are unlinked, never followed, and their targets are checked intact; each directory is re-checked before descending and before removal (plain directory, same inode, same device as the worktree root); the first surprise stops deletion and is reported as action `partial` with `stoppedAt` (exit 1); the worktree's `.git` file is deleted last.
- Worktrees containing a mount point are kept (Linux: `/proc/self/mountinfo`, failing closed when unreadable; every OS: a device-ID change at any depth), checked before anything is deleted, dry run included, and again right before deletion. Nothing is ever unmounted.
- Worktrees with a populated submodule or submodule git dirs are kept, as `git worktree remove` would refuse them.
- Paths are compared by realpath and device+inode, with case folding only on Windows (macOS `/var` vs `/private/var`, case-sensitive APFS and Linux handled); Windows long paths use `\?\`.
- Works when started in a deleted directory on POSIX (given an absolute `--repo`).
- Text files are checked out with LF on every platform.

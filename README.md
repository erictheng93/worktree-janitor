English | [繁體中文](README.zh-TW.md)

# worktree-janitor

Removes git worktrees and local branches whose work is already merged, without ever deleting through a link or into a mount. Runs automatically as a Claude Code or Codex CLI plugin, or by hand from any terminal.

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

## Supported platforms and agents

| Requirement | Details |
| --- | --- |
| OS | Windows, macOS, Linux (CI runs all three) |
| Runtime | Node.js 18 or newer, or Bun |
| git | Required, on `PATH` |
| gh (GitHub CLI) | Optional. Needed only to recognize squash merges (and a few other cases, see the [manual](docs/manual.md#how-a-branch-counts-as-merged)) |

| Agent | How it integrates |
| --- | --- |
| Claude Code | Plugin: `SessionStart` + `PostToolUse` hooks and the `/worktree-janitor:clean-worktrees` command |
| Codex CLI | Plugin, or the installer script: `SessionStart` + `PostToolUse` hooks and the `$clean-worktrees` skill |
| Anything else | Run `node scripts/janitor.mjs` yourself, from a terminal, a script or another tool's hook |

## Quick start

`OWNER` in the commands below is the GitHub account or organization the repository is published under. Replace it with that name.

### Claude Code

```
claude plugin marketplace add OWNER/worktree-janitor
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

The install defaults to user scope, so it applies to every project. Restart Claude Code afterwards. Then run `/worktree-janitor:clean-worktrees` for an interactive dry run, or just keep working: the hooks clean up at the next session start and after every `gh pr merge`.

### Codex CLI

Pick **one** of the two methods. Never use both: each registers the same two hooks, so every hook would run twice.

**Option A: plugin**

```
codex plugin marketplace add OWNER/worktree-janitor
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

**Option B: installer** (hooks point at your own clone)

```
git clone https://github.com/OWNER/worktree-janitor.git
cd worktree-janitor
node scripts/install.mjs --codex --dry-run   # preview
node scripts/install.mjs --codex
```

Then start Codex and **trust the hooks**: Codex asks at startup, or open `/hooks`. Untrusted hooks never run. Invoke the skill explicitly with `$clean-worktrees`.

### Any other tool, or no agent

```
git clone https://github.com/OWNER/worktree-janitor.git
node worktree-janitor/scripts/janitor.mjs --repo /path/to/your/repo           # dry run
node worktree-janitor/scripts/janitor.mjs --repo /path/to/your/repo --apply   # act
```

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

- [User manual](docs/manual.md): concepts, every flag, hook payloads, report format, exit codes, platform notes, troubleshooting, FAQ, limitations
- [Changelog](CHANGELOG.md)

## Contributing

Issues and pull requests are welcome at `https://github.com/OWNER/worktree-janitor`.

```
npm test
```

The suite builds throwaway repositories under the system temp directory and needs only Node.js 18+ and git. On Linux the mount tests run only as root or with passwordless `sudo` and are skipped otherwise; set `JANITOR_REQUIRE_MOUNT_TESTS=1` to make a skip fail instead. `JANITOR_RUNTIME=bun npm test` runs every janitor invocation under Bun. Please keep the script dependency-free.

## License

[MIT](LICENSE)

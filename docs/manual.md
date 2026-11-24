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

### Claude Code plugin

From GitHub (shell; the default scope is `user`, which applies to every project):

```
claude plugin marketplace add erictheng93/worktree-janitor
claude plugin install worktree-janitor@worktree-janitor-marketplace
```

The marketplace source can also be written as a URL, `https://github.com/erictheng93/worktree-janitor`, or as the path of a local clone. One-step alternative:

```
claude plugin install worktree-janitor --marketplace erictheng93/worktree-janitor
```

Inside Claude Code, the same is available as `/plugin marketplace add erictheng93/worktree-janitor` and `/plugin install worktree-janitor@worktree-janitor-marketplace`.

Restart Claude Code after installing. The plugin provides:

| Component | Details |
| --- | --- |
| `SessionStart` hook | `node ${CLAUDE_PLUGIN_ROOT}/scripts/janitor.mjs --hook session-start`, 30 s timeout |
| `PostToolUse` hook | matcher `Bash\|PowerShell`, `node ... --hook post-tool-use`, 30 s timeout; acts only after `gh pr merge` |
| `/worktree-janitor:clean-worktrees` | Dry run, shows the report, asks you to confirm, then runs with `--apply`. Only you can invoke it; the model does not call it on its own |

The hooks use exec form (`"command": "node"` plus an `args` array), so no shell is involved and paths with spaces need no quoting. `node` must be on `PATH`.

Update later with:

```
claude plugin marketplace update worktree-janitor-marketplace
claude plugin update worktree-janitor@worktree-janitor-marketplace
```

### Codex CLI plugin

```
codex plugin marketplace add erictheng93/worktree-janitor
codex plugin add worktree-janitor@worktree-janitor-marketplace
```

`codex plugin marketplace add` also accepts `owner/repo@ref`, an HTTPS or SSH git URL, or a local path. Codex copies the plugin into `$CODEX_HOME/plugins/cache/` and enables it in `config.toml`.

| Component | Details |
| --- | --- |
| `SessionStart` hook | `node "${PLUGIN_ROOT}/scripts/janitor.mjs" --hook session-start`, 30 s timeout |
| `PostToolUse` hook | matcher `Bash`, `node "${PLUGIN_ROOT}/scripts/janitor.mjs" --hook post-tool-use`, 30 s timeout |
| `$clean-worktrees` skill | Same dry-run-then-confirm flow as the Claude Code command; explicit invocation only |

After installing, start Codex and trust the hooks: Codex asks at startup, or open `/hooks`. Untrusted hooks never run. Refresh a GitHub-installed marketplace with `codex plugin marketplace upgrade worktree-janitor-marketplace`.

Do not also run `install.mjs --codex`: both register the same hooks, so they would run twice. The installer prints a warning when it finds the plugin enabled.

### The installer: scripts/install.mjs

The installer works from a clone and points everything at **that clone's** `scripts/janitor.mjs`, so keep the clone where it is (moving it means reinstalling).

```
git clone https://github.com/erictheng93/worktree-janitor.git
cd worktree-janitor
node scripts/install.mjs --all --dry-run
```

| Flag | Effect |
| --- | --- |
| `--claude` | Claude Code: adds this clone as the local marketplace `worktree-janitor-marketplace` and installs the plugin at user scope, through the `claude` CLI. Only missing steps run. Skipped with a message when `claude` is not on `PATH` |
| `--codex` | Codex CLI: hooks, skill and an `AGENTS.md` rule (below) |
| `--all` | Both `--claude` and `--codex` |
| `--uninstall` | Removes what the installer added, and nothing else |
| `--dry-run` | Prints every planned change and writes nothing |
| `-h`, `--help` | Usage |

Without `--claude`, `--codex` or `--all` it prints usage and exits 2.

What `--codex` writes (`$CODEX_HOME` defaults to `~/.codex`):

| Target | Content |
| --- | --- |
| `$CODEX_HOME/hooks.json`, if that file already exists | The two hook groups, replaced in place if present, otherwise appended. Existing groups never move, because Codex trust keys are positional |
| `$CODEX_HOME/config.toml`, otherwise | The same hooks as `[[hooks.*]]` tables inside a `# >>> worktree-janitor >>>` ... `# <<< worktree-janitor <<<` block |
| `~/.agents/skills/clean-worktrees/SKILL.md` and `agents/openai.yaml` | The `$clean-worktrees` skill, explicit invocation only |
| `$CODEX_HOME/AGENTS.md` | A marked rule telling Codex never to run `git worktree remove` directly and to use the janitor instead |

Codex merges `hooks.json` with inline `[hooks]` tables but warns at every session start when one config layer uses both, so the installer keeps to the one you already have.

Behavior details:

- Idempotent: a second run reports `ok ... (already installed)` and rewrites nothing, so trusted hooks stay trusted.
- Before its first change to an existing file, it saves the original bytes as `<file>.worktree-janitor.bak` (once). Uninstall restores those exact bytes when nothing else changed in the file, deletes files it created, and removes the backups.
- Tables that Codex itself inserts inside the marked block (hook trust entries) are preserved on reinstall and on uninstall.
- It refuses, without writing, when `hooks.json` is not valid JSON, when `config.toml` already defines hooks as a static array (`SessionStart = [...]` or `hooks = {...}`; adding tables would make it invalid TOML), when a `clean-worktrees` skill exists that it did not install, or when the marked block was edited by hand.
- `--claude` refuses when a marketplace named `worktree-janitor-marketplace` already points at a different clone; run `--claude --uninstall` from that clone first.
- On Windows the hook command quotes the path with double quotes, or with single quotes when the path contains `$`, a backtick, `"` or a typographic quote (Codex runs hook commands in PowerShell on Windows and in `sh` elsewhere).
- Exit code: 0 on success, 1 if any step failed, 2 for a usage error.

After `--codex`, start Codex and trust the two hooks (startup prompt or `/hooks`). A changed hook command, for example after reinstalling from another path, has to be trusted again.

### Manual Codex setup with the templates

`integrations/codex/` holds the exact hooks the installer writes, with the placeholder path `/path/to/worktree-janitor`:

- [`integrations/codex/config.toml`](../integrations/codex/config.toml): replace the placeholder with the absolute path of your clone (forward slashes also work on Windows) and append everything from the `# >>> worktree-janitor >>>` line on to `$CODEX_HOME/config.toml`. The markers let `node scripts/install.mjs --codex --uninstall` remove it later.
- [`integrations/codex/hooks.json`](../integrations/codex/hooks.json): use this instead if you already keep hooks in `$CODEX_HOME/hooks.json`; merge its two groups into yours.

Use one of the two files, not both, and then trust the hooks in Codex.

### Plain CLI

No installation is needed: clone the repository (or copy `scripts/janitor.mjs`, which has no dependencies) and run it with Node.js 18+ or Bun:

```
node scripts/janitor.mjs --repo /path/to/repo
bun scripts/janitor.mjs --repo /path/to/repo
```

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
| `CODEX_HOME` | `install.mjs` | Codex configuration directory (default `~/.codex`) |
| `JANITOR_GH` | `janitor.mjs` | Command to run instead of `gh`, for a `gh` that is not on `PATH`. A path ending in `.js`, `.mjs` or `.cjs` is run with the current Node.js/Bun executable. The test suite points it at a fake `gh` |
| `JANITOR_CLAUDE` | `install.mjs` | Command to run instead of the `claude` found on `PATH` (`.js`/`.mjs`/`.cjs` run with Node.js). Used by tests |
| `JANITOR_RUNTIME` | test suite | Executable that runs `janitor.mjs` in the tests, for example `bun`. The test runner itself is always Node.js |
| `JANITOR_REQUIRE_MOUNT_TESTS` | test suite | When set, a test fails if the Linux mount tests would be skipped (CI sets it on Ubuntu) |
| `JANITOR_TEST_FOREIGN_DEV_AT` | `janitor.mjs`, tests only | Makes the given directory report a foreign device once deletion has emptied it, to test the mid-deletion stop without root. **Never set it in normal use**: it makes deletions stop partway |

The janitor runs git and gh with `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1` and `GCM_INTERACTIVE=never`, so no credential prompt can block a hook.

## Platform notes

### Windows

- **Junctions:** Node.js and Bun report NTFS junctions as symbolic links. A directory that still answers `readlink` is treated as a link too. Links are removed with unlink, then `rmdir` (without `/s`), then `cmd /c rmdir` as a last resort; each of these removes the link only.
- **Long paths:** all file operations use `\\?\` paths, so worktrees nested deeper than `MAX_PATH` (260 characters), common with `node_modules`, are deleted correctly.
- **Case:** paths are compared case-insensitively, after resolving them to their real path.
- **Mounted volumes:** a volume mounted into a folder is expected not to be reported as a link, so the device-ID check is what catches it (unverified, see [Known limitations](#known-limitations)).
- **Files in use:** Windows cannot delete a file another process holds open, or a directory that is some process's current directory; either stops the deletion (`partial`).
- **PowerShell 5.1** adds a BOM to piped stdin; it is stripped.
- **File symlinks** in a checkout need Developer Mode or admin rights, and git checks them out as plain text files when `core.symlinks=false`. Junctions need no privileges.
- Codex runs hook commands through `powershell.exe -NoProfile -Command`; the installer's quoting accounts for that.

### macOS

- `/var` and `/tmp` are symlinks into `/private`. git prints real paths, hook payloads may not, so every comparison resolves real paths first; a path that no longer exists is resolved through its nearest existing parent.
- APFS is case-insensitive by default but can be case-sensitive, so paths are compared exactly after resolving them, with a device and inode comparison as a second check. A false match only ever keeps a worktree.
- The device-ID check detects mounted volumes; there is no mountinfo.

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
| Plain CLI | Delete the clone |

The installer's uninstall leaves a `worktree-janitor-marketplace` that points at a different clone untouched, and reports it.

## Troubleshooting

### The hooks do not run

- **Codex: hooks not trusted.** Open `/hooks` and trust both worktree-janitor hooks. `codex exec` skips untrusted hooks silently. After reinstalling from a different path the command changed and must be trusted again.
- **Plugin not enabled.** `claude plugin list` or `codex plugin list` should show it installed and enabled. Restart the agent after installing.
- **`node` not on `PATH`.** The hooks run `node`. Check `node --version` in the environment the agent starts from (a GUI-launched agent may not see your shell's `PATH`).
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

If each summary appears twice in Codex, both the plugin and the installer are active. Remove one of them ([Uninstall](#uninstall)).

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

- **macOS** is verified only through CI (GitHub-hosted macOS runners), not on a physical machine.
- **Windows volume mount points** (a drive mounted into an NTFS folder) are expected to be caught by the device-ID check, but this has not been verified.
- **btrfs subvolumes, overlayfs and similar** can report a different device ID for directories on the same filesystem. Such a worktree is kept as `contains mount point`: a false positive, but a safe one.
- **Fast-forward merges** leave nothing in git history that distinguishes them from a fresh branch; they are detected only through `gh`.
- **Branches that contain their own merge commits** (for example after merging the base into the branch) may not be recognized by `git cherry`; they need `gh`.
- **Only `gh pr merge` triggers the post-tool hook.** Merges done elsewhere (web UI, another tool, a teammate) are caught at the next session start, or when you run the janitor by hand.
- Squash detection requires the PR's head commit to equal the local branch tip, looks at up to 30 merged PRs per branch, and only works for GitHub repositories.
- Hook runs are capped at about 20 seconds; very large worktrees may take several sessions, or a manual run.
- Only the remote named `origin` is fetched.

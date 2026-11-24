# worktree-janitor

A Claude Code plugin that cleans up git worktrees and local branches whose work is already merged. It only uses git (and optionally `gh`), so it works the same in any repository, whatever the language.

## What it does

- Removes git worktrees whose branch is merged into the base branch (clean tree, named branch, not locked), unlinking any junction/symlink inside first so removal never deletes through a link into another checkout.
- Deletes merged local branches and Claude's `worktree-*` companion branches.
- Default is a dry run; `--apply` acts.

## Safety rules

- Worktree removal only when: the branch is merged into the base, the working tree is clean, the worktree has a named branch (not detached), and it is not locked (override only with `--include-locked`).
- Any junction or symlink inside a worktree is unlinked before removal, so removal never follows a link into another checkout.
- Dry run by default; nothing changes without `--apply`.
- Hook modes never fail your session: they always exit 0.
- `--hook session-start` applies quietly, prints a one-line summary only when something was removed, and is bounded to about 20 seconds.
- `--hook post-tool-use` reads the hook JSON from stdin, acts only when `tool_input.command` matches `gh pr merge`, and otherwise exits silently.

## What runs automatically

| Event | Matcher | Action |
| --- | --- | --- |
| `SessionStart` | all | `janitor.mjs --hook session-start` |
| `PostToolUse` | `Bash\|PowerShell` | `janitor.mjs --hook post-tool-use` (acts only after `gh pr merge`) |

Both hooks have a 30 second timeout. They use exec form (`"command": "node"` with an `args` array), so no shell is involved: it behaves the same under Git Bash, PowerShell and POSIX shells, and `${CLAUDE_PLUGIN_ROOT}` needs no quoting even when the path contains spaces. `node` is resolved from PATH.

## Requirements

Node.js 18 or newer (or Bun), and git. `gh` is optional.

## Install (local marketplace, user scope)

From inside Claude Code:

```
/plugin marketplace add /path/to/worktree-janitor
/plugin install worktree-janitor@worktree-janitor-marketplace
```

Or from a shell, with user scope so it applies to every project:

```
claude plugin marketplace add /path/to/worktree-janitor
claude plugin install worktree-janitor@worktree-janitor-marketplace --scope user
```

Then restart Claude Code (or run `/reload-plugins`).

## Slash command

`/worktree-janitor:clean-worktrees` runs a dry run, shows the report, and runs with `--apply` only after you confirm.

## Uninstall

```
claude plugin uninstall worktree-janitor --scope user
claude plugin marketplace remove worktree-janitor-marketplace
```

## Use without Claude Code

```
node scripts/janitor.mjs --repo <path>            # dry run
node scripts/janitor.mjs --repo <path> --apply    # act
```

Options: `--apply`, `--repo <path>`, `--base <branch>`, `--json`, `--hook session-start|post-tool-use`, `--include-locked`.

## Projects in other languages (Rust, Python, ...)

Nothing per-project is needed. The plugin only operates on git worktrees and branches, so it works the same in a Rust, Python, Go or any other repository. Node is needed only to run the script itself.

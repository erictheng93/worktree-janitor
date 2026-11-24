---
name: clean-worktrees
description: Dry-run, then (after confirmation) remove merged git worktrees and merged local branches in the current repository.
disable-model-invocation: true
allowed-tools: Bash(node *janitor.mjs*)
---

# clean-worktrees

Clean up merged git worktrees and local branches in the current repository.

1. Run a dry run (changes nothing) and show the user the full report:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/janitor.mjs"
   ```

2. If the report lists nothing to remove, say so and stop.
3. Otherwise summarize what would be removed (worktrees and branches) and ask the user to confirm. Do not continue without an explicit yes.
4. Only after confirmation, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/janitor.mjs" --apply
   ```

   Show its output. Worktrees that are locked are skipped unless the user explicitly asks to include them, in which case add `--include-locked`.
5. Optional arguments from the user: `--repo <path>` to target another repository, `--base <branch>` to choose the base branch.

Never pass `--apply` before the user has seen the dry-run report and confirmed.

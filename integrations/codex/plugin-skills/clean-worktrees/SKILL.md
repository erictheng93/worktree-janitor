---
name: clean-worktrees
description: Dry-run, then (after confirmation) remove merged git worktrees and merged local branches in the current repository.
---

# clean-worktrees

Clean up merged git worktrees and local branches in the current repository.

The script is `scripts/janitor.mjs` in this plugin's root, four directories above
the directory holding this SKILL.md: `<this directory>/../../../../scripts/janitor.mjs`.
Resolve it to an absolute path and call it `JANITOR` below; quote it when you run it.

1. Run a dry run (changes nothing) and show the user the full report:

   ```
   node "JANITOR"
   ```

2. If the report lists nothing to remove, say so and stop.
3. Otherwise summarize what would be removed (worktrees and branches) and ask the user to confirm. Do not continue without an explicit yes.
4. Only after confirmation, run:

   ```
   node "JANITOR" --apply
   ```

   Show its output. Worktrees that are locked are skipped unless the user explicitly asks to include them, in which case add `--include-locked`.
5. Optional arguments from the user: `--repo <path>` to target another repository, `--base <branch>` to choose the base branch.

Never pass `--apply` before the user has seen the dry-run report and confirmed.
Never run `git worktree remove` directly: on Windows it deletes through NTFS junctions.

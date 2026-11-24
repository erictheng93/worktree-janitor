#!/bin/sh
# End-to-end test of install.sh against locally built release assets.
#
#   sh test/channels/install-sh.sh <dist-dir>
#
# <dist-dir> holds what scripts/build-release.mjs wrote. Everything happens
# under a throwaway HOME (CODEX_HOME, ~/.local/bin, ~/.worktree-janitor, fake
# claude/codex CLIs); the real ones are never touched. Exits non-zero on the
# first failed check.
set -eu

DIST=$(cd "$1" && pwd)
NODE=$(command -v node)
INSTALL=$DIST/install.sh
TARBALL=$(ls "$DIST"/worktree-janitor-v*.tar.gz)
VERSION=$(basename "$TARBALL" .tar.gz)
VERSION=${VERSION#worktree-janitor-}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"
mkdir -p "$HOME"
export CODEX_HOME="$HOME/.codex"
export WORKTREE_JANITOR_BASE_URL="$DIST"
printf '{\n  "url": "x",\n  "tag_name": "%s",\n  "name": "%s"\n}\n' "$VERSION" "$VERSION" >"$WORK/latest.json"
export WORKTREE_JANITOR_API_URL="$WORK/latest.json"
CLEAN_PATH=$PATH
export PATH="$HOME/.local/bin:$CLEAN_PATH"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
step() { echo "--- $*"; }
# Every file and link under HOME with its content hash or link target.
snapshot() {
  (cd "$HOME" && find . \( -type f -o -type l \) | LC_ALL=C sort | while read -r f; do
    if [ -L "$f" ]; then echo "$f -> $(readlink "$f")"; else echo "$f $(cksum <"$f")"; fi
  done)
}

# A repository with one merged worktree (and branch), one unmerged.
make_repo() {
  r=$1
  mkdir -p "$r"
  git init -q --bare "$r/origin.git"
  git init -q "$r/repo"
  (
    cd "$r/repo"
    git checkout -q -b main
    echo a >a && git add a && git commit -qm init
    git remote add origin ../origin.git && git push -q origin main
    git remote set-head origin main
    git worktree add -q -b merged ../wt-merged
    (cd ../wt-merged && echo b >b && git add b && git commit -qm b)
    git merge -q --no-ff -m merge merged && git push -q origin main
    git worktree add -q -b open ../wt-open
    (cd ../wt-open && echo c >c && git add c && git commit -qm c)
  )
}

step "install.sh $VERSION --none (version from the latest-release endpoint)"
sh "$INSTALL" --none
[ -L "$HOME/.worktree-janitor/current" ] || fail "current is not a symlink"
[ "$(readlink "$HOME/.worktree-janitor/current")" = "$VERSION" ] || fail "current does not point at $VERSION"
[ -x "$HOME/.local/bin/worktree-janitor" ] || fail "launcher missing"
grep -q "$NODE" "$HOME/.local/bin/worktree-janitor" || fail "launcher does not record $NODE"
[ ! -e "$CODEX_HOME" ] || fail "--none touched CODEX_HOME"

step "worktree-janitor --help and a dry run"
worktree-janitor --help | grep -q 'remove git worktrees' || fail "--help output"
make_repo "$WORK/r1"
(cd "$WORK/r1/repo" && worktree-janitor) >"$WORK/dry.txt"
cat "$WORK/dry.txt"
grep -q 'would-remove' "$WORK/dry.txt" || fail "dry run did not plan the merged worktree"
[ -d "$WORK/r1/wt-merged" ] || fail "dry run removed something"
# The launcher still works when node is not on PATH (absolute node recorded).
(cd "$WORK/r1/repo" && env PATH=/usr/bin:/bin "$HOME/.local/bin/worktree-janitor" --json) | grep -q '"worktrees"' || fail "launcher without node on PATH"

step "install again: idempotent"
before=$(snapshot)
sh "$INSTALL" --none --version "$VERSION" >"$WORK/again.txt"
cat "$WORK/again.txt"
grep -q 'already unpacked' "$WORK/again.txt" || fail "second install downloaded again"
[ "$(snapshot)" = "$before" ] || fail "second install changed files"

step "--dry-run changes nothing"
sh "$INSTALL" --none --dry-run >/dev/null
[ "$(snapshot)" = "$before" ] || fail "--dry-run changed files"

step "tampered archive: fails closed"
mkdir "$WORK/bad"
cp "$DIST"/* "$WORK/bad/"
printf 'x' >>"$WORK/bad/$(basename "$TARBALL")"
rm -rf "$HOME/.worktree-janitor/$VERSION/.worktree-janitor-sha256"
before=$(snapshot)
if WORKTREE_JANITOR_BASE_URL="$WORK/bad" sh "$INSTALL" --none 2>"$WORK/bad.txt"; then fail "tampered archive was accepted"; fi
grep -q 'sha256 mismatch' "$WORK/bad.txt" || fail "no mismatch message: $(cat "$WORK/bad.txt")"
[ "$(snapshot)" = "$before" ] || fail "a failed install changed files"
sh "$INSTALL" --none >/dev/null

step "no release published: clear error"
if WORKTREE_JANITOR_API_URL="$WORK/missing.json" sh "$INSTALL" --none 2>"$WORK/norel.txt"; then fail "succeeded without a release"; fi
grep -q 'Pass --version' "$WORK/norel.txt" || fail "unclear error: $(cat "$WORK/norel.txt")"

step "truncated installer runs nothing"
head -c 4000 "$INSTALL" >"$WORK/truncated.sh"
before=$(snapshot)
sh "$WORK/truncated.sh" --uninstall >/dev/null 2>&1 || true
[ "$(snapshot)" = "$before" ] || fail "a truncated installer changed files"

step "uninstall: nothing left"
sh "$INSTALL" --uninstall
left=$(snapshot)
[ -z "$left" ] || fail "left behind: $left"
[ ! -e "$HOME/.worktree-janitor" ] || fail "install dir left"

step "fake claude + codex on PATH: auto-detected, hooks run, uninstall restores"
mkdir -p "$WORK/fakebin" "$CODEX_HOME"
cat >"$WORK/fakebin/claude" <<EOF
#!$NODE
const fs = require('fs');
const f = '$WORK/claude-state.json';
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { markets: [], plugins: [], calls: [] };
const a = process.argv.slice(2), k = a.join(' ');
let out = '';
if (k === 'plugin marketplace list --json') out = JSON.stringify(s.markets);
else if (k === 'plugin list --json') out = JSON.stringify(s.plugins);
else {
  s.calls.push(k);
  if (a[1] === 'marketplace' && a[2] === 'add') s.markets.push({ name: 'worktree-janitor-marketplace', source: 'directory', path: a[3] });
  else if (a[1] === 'install') s.plugins.push({ id: a[2], scope: 'user', version: '0' });
  else if (a[1] === 'uninstall') s.plugins = [];
  else if (a[1] === 'marketplace' && a[2] === 'remove') s.markets = [];
  else if (a[1] !== 'update' && a[1] !== 'marketplace') process.exit(3);
}
fs.writeFileSync(f, JSON.stringify(s));
process.stdout.write(out);
EOF
printf '#!/bin/sh\necho "codex-cli 0.0.0-fake"\n' >"$WORK/fakebin/codex"
chmod +x "$WORK/fakebin/claude" "$WORK/fakebin/codex"
# A user hooks.json with a hook of their own: ours is added next to it.
printf '{\n  "hooks": {\n    "Stop": [ { "hooks": [ { "type": "command", "command": "true" } ] } ]\n  }\n}\n' >"$CODEX_HOME/hooks.json"
cp "$CODEX_HOME/hooks.json" "$WORK/hooks.orig.json"
PATH="$WORK/fakebin:$HOME/.local/bin:$CLEAN_PATH" sh "$INSTALL"
grep -q "plugin marketplace add $HOME/.worktree-janitor/current" "$WORK/claude-state.json" || fail "claude marketplace not added at current: $(cat "$WORK/claude-state.json")"
grep -q "$HOME/.worktree-janitor/current/scripts/janitor.mjs" "$CODEX_HOME/hooks.json" || fail "codex hooks do not point at current"
grep -q "$NODE" "$CODEX_HOME/hooks.json" || fail "codex hooks do not record $NODE"
[ -f "$HOME/.agents/skills/clean-worktrees/SKILL.md" ] || fail "codex skill missing"

# Run the installed SessionStart hook the way Codex does (sh -c, payload on
# stdin), with a PATH that has no node: the recorded node is used and the
# merged worktree goes.
cmd=$(node -e 'const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(h.hooks.SessionStart.at(-1).hooks[0].command)' "$CODEX_HOME/hooks.json")
ran=0
for sh_ in sh bash zsh dash; do
  sh_path=$(command -v "$sh_" 2>/dev/null) || continue
  echo "    SessionStart hook via $sh_ -c"
  make_repo "$WORK/r2-$sh_"
  printf '{"hook_event_name":"SessionStart","cwd":"%s","source":"startup"}' "$WORK/r2-$sh_/repo" |
    (cd "$WORK/r2-$sh_/repo" && env PATH=/usr/bin:/bin "$sh_path" -c "$cmd") >"$WORK/hook.txt" 2>&1 || fail "$sh_: hook exited non-zero: $(cat "$WORK/hook.txt")"
  cat "$WORK/hook.txt"
  [ ! -e "$WORK/r2-$sh_/wt-merged" ] || fail "$sh_: hook did not remove the merged worktree"
  [ -d "$WORK/r2-$sh_/wt-open" ] || fail "$sh_: hook removed the unmerged worktree"
  ran=$((ran + 1))
done
[ "$ran" -gt 0 ] || fail "no shell ran the hook"

step "install again with the integrations: idempotent"
before=$(snapshot)
PATH="$WORK/fakebin:$HOME/.local/bin:$CLEAN_PATH" sh "$INSTALL" >/dev/null
[ "$(snapshot)" = "$before" ] || fail "second install changed files"

step "uninstall with the integrations"
PATH="$WORK/fakebin:$HOME/.local/bin:$CLEAN_PATH" sh "$INSTALL" --uninstall
cmp "$CODEX_HOME/hooks.json" "$WORK/hooks.orig.json" || fail "hooks.json not restored"
node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (s.markets.length || s.plugins.length) process.exit(1)' "$WORK/claude-state.json" || fail "claude plugin left: $(cat "$WORK/claude-state.json")"
rm -f "$CODEX_HOME/hooks.json"
left=$(cd "$HOME" && find . -type f -o -type l)
[ -z "$left" ] || fail "left behind: $left"

echo "install.sh: all checks passed"

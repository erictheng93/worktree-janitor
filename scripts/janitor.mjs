#!/usr/bin/env node
// worktree-janitor: remove git worktrees (and their branches) whose work has
// landed in the base branch, without ever deleting through links.
//
// Language-agnostic: it only talks to git (and, optionally, gh).
// Node >= 18 stdlib only; also runs under bun.
//
// Usage:
//   node janitor.mjs [--apply] [--repo <path>] [--base <branch>] [--json]
//                    [--hook session-start|post-tool-use] [--include-locked]
//
// Default is a DRY RUN. See README / --help for the full contract.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
const HOOK_BUDGET_MS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 10_000;
const LINK_SCAN_DEPTH = 6;
const FIRST_PARENT_CAP = 50_000;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);
const PR_MERGE_RE = /\bgh\s+pr\s+merge\b/;

// Claude Code lock reasons. Claude Code locks the worktrees it creates for
// sessions (`claude --worktree`, EnterWorktree) and for isolated subagents with
//   git worktree lock --reason "claude <kind> <name> (pid <pid>[ start <procStart>])"
// e.g. "claude agent agent-a1b2c3 (pid 12345 start 133981...)" or
//      "claude session my-feature (pid 4242)".
// This regex is the one Claude Code itself uses to recognise its own locks.
// Claude Code treats such a lock as released when the PID is no longer alive,
// and so do we: a matching lock whose PID is dead is STALE and does not block
// removal (we `git worktree unlock` first). A live PID, or any lock reason we
// do not recognise (a human's `git worktree lock`, another tool), keeps the
// worktree unless --include-locked is passed. PID reuse can make a dead
// session look alive; that errs on the side of keeping, which is safe.
const CLAUDE_LOCK_RE = /^claude (?:agent|session) .{1,255} \(pid (\d{1,10})(?: start (.{1,255}))?\)$/;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = { apply: false, repo: null, base: null, json: false, hook: null, includeLocked: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true;
    else if (a === '--include-locked') o.includeLocked = true;
    else if (a === '--repo') o.repo = val();
    else if (a.startsWith('--repo=')) o.repo = a.slice(7);
    else if (a === '--base') o.base = val();
    else if (a.startsWith('--base=')) o.base = a.slice(7);
    else if (a === '--hook') o.hook = val();
    else if (a.startsWith('--hook=')) o.hook = a.slice(7);
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(`unknown argument: ${a}`);
  }
  if (o.hook !== null && o.hook !== 'session-start' && o.hook !== 'post-tool-use') {
    throw new UsageError(`--hook must be session-start or post-tool-use, got: ${o.hook}`);
  }
  if (o.hook) o.apply = true;
  return o;
}

class UsageError extends Error {}
class SafetyError extends Error {}

const HELP = `worktree-janitor: remove git worktrees and local branches already merged into base.

  node janitor.mjs [--apply] [--repo <path>] [--base <branch>] [--json]
                   [--hook session-start|post-tool-use] [--include-locked]

  (default)          dry run: print what would be removed/kept and why
  --apply            actually remove worktrees and delete branches
  --repo <path>      repository (default: cwd); always operates from the main worktree
  --base <branch>    base branch (default: origin/HEAD target, else origin/main,
                     origin/master, main, master)
  --json             machine-readable report
  --hook <kind>      Claude Code hook mode (implies --apply, quiet, always exits 0)
  --include-locked   also remove worktrees locked by a live or unknown owner
`;

// ---------------------------------------------------------------- process helpers

let DEADLINE = Infinity;
const remaining = () => DEADLINE - Date.now();

function run(cmd, args, { cwd, timeout = GIT_TIMEOUT_MS, input, env } = {}) {
  const left = remaining();
  if (left <= 250) return { ok: false, status: null, stdout: '', stderr: 'time budget exhausted', timedOut: true };
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: Math.max(250, Math.min(timeout, left)),
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GCM_INTERACTIVE: 'never', ...env },
  });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM';
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout || '',
    stderr: (r.stderr || '') + (r.error ? String(r.error.message || r.error) : ''),
    timedOut,
    spawnError: r.error ? r.error.code : null,
  };
}

function git(args, opts = {}) {
  return run('git', ['-c', 'core.quotepath=off', ...args], opts);
}

function gitOut(args, opts) {
  const r = git(args, opts);
  return r.ok ? r.stdout.trim() : null;
}

function ghCommand() {
  const override = process.env.JANITOR_GH;
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return [process.execPath, [override]];
    return [override, []];
  }
  return ['gh', []];
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// ---------------------------------------------------------------- path helpers

// Canonical form of a path for comparisons. git prints realpaths (on macOS
// /var/folders/... comes back as /private/var/folders/..., and /tmp as
// /private/tmp), while hook payloads, --repo and os.tmpdir() may not, so every
// comparison goes through the OS realpath. For a path that does not exist (a
// pruned worktree, a deleted cwd) the nearest existing ancestor is resolved
// and the rest re-appended, so the /private prefix is still applied.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// Case policy:
//   win32  - fold case. NTFS is case-insensitive by default; folding is what
//            made the original Windows behaviour correct.
//   linux  - exact. ext4/xfs/btrfs are case-sensitive: /a/Wt and /a/wt are two
//            different directories and must never be treated as one.
//   darwin - exact, after realpath. APFS/HFS+ are case-insensitive by default
//            but can be formatted case-sensitive, so folding would be wrong on
//            the latter. On the former, Darwin's realpath(3) is expected to
//            return each component's on-disk spelling, so two spellings of
//            one directory realpath to the same string; and if it does not,
//            the device+inode check in samePath/isInside still matches them.
function normKey(p) {
  const r = realish(p);
  return IS_WIN ? r.toLowerCase() : r;
}

// Identity of an existing path (device + inode). A second, independent check
// behind the string comparison: it holds however the path is spelled (case,
// symlinked prefixes such as /var vs /private/var), so the safety guards do
// not depend on realpath canonicalising case on darwin. Some filesystems
// report inode 0 (FAT, some network shares): no identity then.
function fileId(p) {
  try {
    const s = fs.statSync(p, { bigint: true });
    return s.ino ? `${s.dev}:${s.ino}` : null;
  } catch {
    return null;
  }
}

function samePath(a, b) {
  if (normKey(a) === normKey(b)) return true;
  const ia = fileId(a);
  return ia !== null && ia === fileId(b);
}

function isInside(child, parent) {
  const rel = path.relative(normKey(parent), normKey(child));
  if (rel === '') return true;
  // `..x` is a legitimate child name; only `..` as a whole segment escapes.
  if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return true;
  const pid = fileId(parent);
  if (pid === null) return false;
  for (let cur = realish(child); ; cur = path.dirname(cur)) {
    if (fileId(cur) === pid) return true;
    if (path.dirname(cur) === cur) return false;
  }
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isLink(p, st) {
  if (st.isSymbolicLink()) return true;
  // Belt and braces: Node and bun report NTFS junctions as symbolic links
  // (verified on Windows 11 with `mklink /J`), but if some reparse point is
  // ever reported as a plain directory, readlink succeeding still betrays it.
  if (IS_WIN && st.isDirectory()) {
    try {
      fs.readlinkSync(p);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

const nsPath = (p) => (IS_WIN ? path.toNamespacedPath(path.resolve(p)) : p);

// Walk `root` with lstat, never descending into links, skipping `.git`.
// Returns every link (symlink / junction / reparse point) found.
function scanLinks(root, maxDepth = LINK_SCAN_DEPTH) {
  const links = [];
  let truncated = false;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let names;
    try {
      names = fs.readdirSync(nsPath(dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === '.git') continue;
      const p = path.join(dir, name);
      const st = lstatOrNull(nsPath(p));
      if (!st) continue;
      if (isLink(nsPath(p), st)) links.push(p);
      else if (st.isDirectory()) {
        if (depth + 1 < maxDepth) stack.push([p, depth + 1]);
        else truncated = true;
      }
    }
  }
  return { links, truncated };
}

// Remove ONE link without touching what it points to, then prove it.
// POSIX: unlink(2) removes a symlink itself, whether it points to a file or a
// directory; rmdir(2) / rm -r are never used on a link. win32: junctions and
// directory symlinks may need RemoveDirectory, so rmdir (no /s) is tried too.
function removeLinkOnly(p) {
  const np = nsPath(p);
  const before = lstatOrNull(np);
  if (!before) return { link: p, target: null, targetExisted: false };
  // Re-check right before acting: if this is no longer a link (replaced by a
  // real directory since the scan), refuse rather than delete real content.
  if (!isLink(np, before)) throw new SafetyError(`SAFETY: ${p} is no longer a link; refusing to remove it`);
  let target = null;
  try {
    target = fs.realpathSync.native(p);
  } catch {
    target = null; // dangling link: nothing to protect
  }
  const targetExisted = target !== null && fs.existsSync(target);
  const attempts = IS_WIN ? [() => fs.unlinkSync(np), () => fs.rmdirSync(np)] : [() => fs.unlinkSync(np)];
  let done = false;
  for (const attempt of attempts) {
    try {
      attempt();
      done = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!done && IS_WIN) {
    // `rmdir` without /s removes a junction / directory symlink itself only.
    run('cmd', ['/d', '/c', 'rmdir', path.resolve(p)], { timeout: 5000 });
    done = !lstatOrNull(np);
  }
  if (!done || lstatOrNull(np)) throw new Error(`could not remove link ${p}`);
  if (targetExisted && !fs.existsSync(target)) {
    throw new SafetyError(`SAFETY: link target ${target} vanished after removing link ${p}`);
  }
  return { link: p, target, targetExisted };
}

// Recursive delete that never follows links: links are unlinked, files
// unlinked, directories emptied then rmdir'd. Used as the fallback when git
// cannot delete (long paths) or when links may exist below the scan depth.
function safeRemoveTree(p) {
  const np = nsPath(p);
  const st = lstatOrNull(np);
  if (!st) return;
  if (isLink(np, st)) {
    removeLinkOnly(p);
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(np)) safeRemoveTree(path.join(p, name));
    try {
      fs.rmdirSync(np);
    } catch (e) {
      fs.chmodSync(np, 0o777);
      fs.rmdirSync(np);
    }
    return;
  }
  try {
    fs.unlinkSync(np);
  } catch {
    fs.chmodSync(np, 0o666);
    fs.unlinkSync(np);
  }
}

// ---------------------------------------------------------------- git model

function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: path.resolve(line.slice(9)), head: null, branch: null, detached: false, bare: false, locked: false, lockReason: '', prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked') cur.locked = true;
    else if (line.startsWith('locked ')) {
      cur.locked = true;
      cur.lockReason = line.slice(7);
    } else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return out;
}

// Older git prints a bare `locked` without the reason; read it from the
// worktree's admin dir (<common-dir>/worktrees/<name>/locked).
function readLockReason(wt) {
  try {
    const dotgit = fs.readFileSync(path.join(wt.path, '.git'), 'utf8');
    const m = dotgit.match(/^gitdir:\s*(.+)$/m);
    if (!m) return '';
    return fs.readFileSync(path.join(path.resolve(wt.path, m[1].trim()), 'locked'), 'utf8').trim();
  } catch {
    return '';
  }
}

function resolveRepo(start) {
  if (!start || !fs.existsSync(start)) return null;
  const top = gitOut(['rev-parse', '--show-toplevel'], { cwd: start });
  if (!top) return null;
  const common = gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: start })
    || (() => {
      const c = gitOut(['rev-parse', '--git-common-dir'], { cwd: start });
      return c ? path.resolve(start, c) : null;
    })();
  // The first entry of `git worktree list` is always the main worktree.
  const list = gitOut(['worktree', 'list', '--porcelain'], { cwd: top });
  const first = list ? parseWorktrees(list)[0] : null;
  let main = first && !first.bare ? first.path : null;
  if (!main && common && path.basename(common) === '.git') main = path.dirname(common);
  if (!main) main = path.resolve(top);
  return { main, common };
}

function resolveBase(repo, requested) {
  const verify = (ref) => !!gitOut(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo });
  if (requested) return verify(requested) ? requested : null;
  const head = gitOut(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: repo });
  const candidates = [];
  if (head) candidates.push(head.replace(/^refs\/remotes\//, ''));
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  for (const c of candidates) if (verify(c)) return c;
  return null;
}

// ---------------------------------------------------------------- merge decision

class MergeOracle {
  constructor(repo, base, ghTimeout) {
    this.repo = repo;
    this.base = base;
    this.ghTimeout = ghTimeout;
    this.ghDisabled = false;
    this.cache = new Map();
    this.firstParent = null;
  }

  firstParentSet() {
    if (this.firstParent) return this.firstParent;
    const out = gitOut(['rev-list', '--first-parent', `--max-count=${FIRST_PARENT_CAP}`, this.base], { cwd: this.repo }) || '';
    const shas = out.split(/\r?\n/).filter(Boolean);
    this.firstParent = { set: new Set(shas), capped: shas.length >= FIRST_PARENT_CAP };
    return this.firstParent;
  }

  ghMergedPr(branch, tip) {
    if (this.ghDisabled) return null;
    const [cmd, pre] = ghCommand();
    const r = run(cmd, [...pre, 'pr', 'list', '--state', 'merged', '--head', branch, '--json', 'headRefOid,number', '--limit', '30'], {
      cwd: this.repo,
      timeout: this.ghTimeout,
    });
    if (!r.ok) {
      // Missing, unauthenticated, offline, not a GitHub repo: stop asking.
      this.ghDisabled = true;
      return null;
    }
    try {
      const prs = JSON.parse(r.stdout || '[]');
      return Array.isArray(prs) ? prs.find((p) => p && p.headRefOid === tip) || null : null;
    } catch {
      return null;
    }
  }

  // -> { merged: boolean, ahead: number, reason: string }
  check(branch, tip) {
    const key = `${branch}\0${tip}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const res = this._check(branch, tip);
    this.cache.set(key, res);
    return res;
  }

  _check(branch, tip) {
    const aheadOut = gitOut(['rev-list', '--count', `${this.base}..${tip}`], { cwd: this.repo });
    if (aheadOut === null) return { merged: false, ahead: -1, reason: 'could not compare with base' };
    const ahead = Number(aheadOut);
    if (ahead > 0) {
      const cherry = git(['cherry', this.base, tip], { cwd: this.repo });
      if (cherry.ok) {
        const plus = cherry.stdout.split(/\r?\n/).filter((l) => l.startsWith('+')).length;
        if (plus === 0) return { merged: true, ahead, reason: `merged: all ${ahead} commit(s) have equivalent patches in ${this.base} (rebase-merge)` };
      }
      const pr = this.ghMergedPr(branch, tip);
      if (pr) return { merged: true, ahead, reason: `merged: PR #${pr.number} merged with head == branch tip (squash-merge)` };
      return { merged: false, ahead, reason: `not merged: ${ahead} commit(s) not in ${this.base}${this.ghDisabled ? ' (gh unavailable for squash check)' : ''}` };
    }
    // 0 commits ahead: the tip is an ancestor of base. A freshly created
    // branch sits on base's first-parent chain; a branch merged with a merge
    // commit is reachable only through a merge's second parent.
    const fp = this.firstParentSet();
    if (!fp.set.has(tip) && !fp.capped) {
      return { merged: true, ahead: 0, reason: `merged: tip is reachable from ${this.base} through a merge commit` };
    }
    const pr = this.ghMergedPr(branch, tip);
    if (pr) return { merged: true, ahead: 0, reason: `merged: PR #${pr.number} merged with head == branch tip` };
    return { merged: false, ahead: 0, reason: `0 commits ahead of ${this.base} (fresh branch, not treated as merged)` };
  }
}

// ---------------------------------------------------------------- the janitor

function janitor(opts, ctx) {
  const report = { repo: null, base: null, applied: opts.apply, worktrees: [], branches: [], errors: [] };
  const repoInfo = resolveRepo(ctx.start);
  if (!repoInfo) {
    const e = new Error(`not a git repository: ${ctx.start}`);
    e.notRepo = true;
    throw e;
  }
  const repo = repoInfo.main;
  report.repo = repo;

  const remotes = (gitOut(['remote'], { cwd: repo }) || '').split(/\r?\n/);
  if (remotes.includes('origin')) git(['fetch', '--prune', '--quiet', 'origin'], { cwd: repo, timeout: FETCH_TIMEOUT_MS });

  const base = resolveBase(repo, opts.base);
  if (!base) throw new UsageError(opts.base ? `base branch not found: ${opts.base}` : 'could not determine a base branch (origin/HEAD, main, master)');
  report.base = base;
  const baseLocal = base.replace(/^(origin|upstream)\//, '');

  const oracle = new MergeOracle(repo, base, ctx.ghTimeout);
  const wtList = parseWorktrees(gitOut(['worktree', 'list', '--porcelain'], { cwd: repo }) || '');
  const branchTips = new Map();
  for (const line of (gitOut(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads'], { cwd: repo }) || '').split(/\r?\n/)) {
    const [ref, sha] = line.split('\0');
    if (ref && sha) branchTips.set(ref.replace(/^refs\/heads\//, ''), sha);
  }

  const checkedOut = new Map(); // branch -> worktree entry still holding it
  for (const wt of wtList) if (wt.branch) checkedOut.set(wt.branch, wt);

  const protectedBranch = (b) => b === baseLocal || PROTECTED_BRANCHES.has(b);
  const cwdGuards = ctx.cwdGuards.filter(Boolean);
  let safetyAbort = false;
  let pruneNeeded = false;

  const wtReport = (wt, action, reason) => report.worktrees.push({ path: wt.path, branch: wt.branch, action, reason });

  wtList.forEach((wt, idx) => {
    if (idx === 0) return wtReport(wt, 'kept', 'main worktree');
    if (wt.bare) return wtReport(wt, 'kept', 'bare repository entry');
    if (safetyAbort) return wtReport(wt, 'kept', 'skipped after a safety abort');
    if (remaining() <= 1000) return wtReport(wt, 'kept', 'time budget exhausted');

    let lockReason = wt.lockReason;
    if (wt.locked && !lockReason) lockReason = readLockReason(wt);
    let staleLock = false;
    if (wt.locked) {
      const m = lockReason.match(CLAUDE_LOCK_RE);
      const pid = m ? Number(m[1]) : null;
      if (m && !pidAlive(pid)) staleLock = true;
      else if (!opts.includeLocked) {
        return wtReport(wt, 'kept', m ? `locked by a live Claude Code process (pid ${pid})` : `locked${lockReason ? `: ${lockReason}` : ''}`);
      }
    }

    if (wt.prunable || !fs.existsSync(wt.path)) {
      if (wt.locked && !staleLock && !opts.includeLocked) return wtReport(wt, 'kept', 'directory missing but locked');
      if (!opts.apply) return wtReport(wt, 'would-remove', 'directory missing; registration would be pruned');
      if (wt.locked) git(['worktree', 'unlock', wt.path], { cwd: repo });
      pruneNeeded = true;
      checkedOut.delete(wt.branch);
      return wtReport(wt, 'removed', 'directory missing; registration pruned');
    }

    if (wt.detached || !wt.branch) return wtReport(wt, 'kept', 'detached HEAD (externally managed)');
    if (samePath(wt.path, repo) || isInside(repo, wt.path)) return wtReport(wt, 'kept', 'contains the main worktree');
    if (cwdGuards.some((c) => isInside(c, wt.path))) return wtReport(wt, 'kept', 'current working directory is inside it');

    const st = git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], { cwd: wt.path });
    if (!st.ok) return wtReport(wt, 'kept', `git status failed: ${firstLine(st.stderr)}`);
    if (st.stdout.trim()) {
      const n = st.stdout.split(/\r?\n/).filter(Boolean).length;
      return wtReport(wt, 'kept', `dirty: ${n} modified/untracked path(s)`);
    }

    const tip = wt.head || branchTips.get(wt.branch);
    const verdict = oracle.check(wt.branch, tip);
    if (!verdict.merged) return wtReport(wt, 'kept', verdict.reason);

    const lockNote = wt.locked ? (staleLock ? '; stale Claude Code lock (pid not alive)' : '; lock overridden by --include-locked') : '';
    const scan = scanLinks(wt.path);
    const linkNote = scan.links.length ? `; ${scan.links.length} link(s) to be unlinked first` : '';
    if (!opts.apply) return wtReport(wt, 'would-remove', verdict.reason + lockNote + linkNote);

    try {
      removeWorktree(repo, wt, scan);
      checkedOut.delete(wt.branch);
      wtReport(wt, 'removed', verdict.reason + lockNote + (scan.links.length ? `; unlinked ${scan.links.length} link(s) first` : ''));
    } catch (e) {
      if (e instanceof SafetyError) safetyAbort = true;
      report.errors.push(e.message);
      wtReport(wt, 'kept', `removal failed: ${firstLine(e.message)}`);
    }
  });

  if (pruneNeeded) git(['worktree', 'prune'], { cwd: repo });

  // Branches. In dry run, branches of would-remove worktrees count as freed.
  const freed = new Set(report.worktrees.filter((w) => w.action === 'would-remove' && w.branch).map((w) => w.branch));
  for (const [name, tip] of branchTips) {
    if (protectedBranch(name)) {
      report.branches.push({ name, action: 'kept', reason: name === baseLocal ? 'base branch' : 'protected branch name' });
      continue;
    }
    const holder = checkedOut.get(name);
    if (holder && !freed.has(name)) {
      report.branches.push({ name, action: 'kept', reason: `checked out in worktree ${holder.path}` });
      continue;
    }
    if (safetyAbort) {
      report.branches.push({ name, action: 'kept', reason: 'skipped after a safety abort' });
      continue;
    }
    if (remaining() <= 500) {
      report.branches.push({ name, action: 'kept', reason: 'time budget exhausted' });
      continue;
    }
    const v = oracle.check(name, tip);
    let reason = null;
    if (v.merged) reason = v.reason;
    else if (v.ahead === 0 && /^worktree-/.test(name)) reason = 'companion worktree-* branch with 0 commits ahead, not checked out';
    if (!reason) {
      report.branches.push({ name, action: 'kept', reason: v.reason });
      continue;
    }
    if (!opts.apply) {
      report.branches.push({ name, action: 'would-delete', reason });
      continue;
    }
    const d = git(['branch', '-D', name], { cwd: repo });
    if (d.ok) report.branches.push({ name, action: 'deleted', reason });
    else {
      report.errors.push(`git branch -D ${name}: ${firstLine(d.stderr)}`);
      report.branches.push({ name, action: 'kept', reason: `delete failed: ${firstLine(d.stderr)}` });
    }
  }
  return report;
}

function removeWorktree(repo, wt, scan) {
  // Re-check the registration right before acting: never delete a path git
  // did not register, never the main worktree, never one containing it.
  if (samePath(wt.path, repo) || isInside(repo, wt.path)) throw new SafetyError('SAFETY: refusing to remove the main worktree');
  const now = parseWorktrees(gitOut(['worktree', 'list', '--porcelain'], { cwd: repo }) || '');
  if (!now.slice(1).some((w) => samePath(w.path, wt.path))) throw new Error(`no longer registered: ${wt.path}`);

  // (a) Unlink every link inside the worktree BEFORE git touches it.
  // `git worktree remove` on Windows recurses THROUGH NTFS junctions (e.g. a
  // node_modules junction into the main checkout) and deletes their targets.
  const removedLinks = scan.links.map((l) => removeLinkOnly(l));
  const rescan = scanLinks(wt.path);
  if (rescan.links.length) throw new Error(`links remain after unlinking: ${rescan.links[0]}`);

  // If any removed link was a symlink tracked by git, the tree is now
  // "modified" by us; git would refuse without --force, so use the safe
  // deleter instead (the tree was verified clean before we touched it).
  let trackedLinkRemoved = false;
  if (removedLinks.length) {
    const ls = git(['ls-files', '-s', '-z'], { cwd: wt.path });
    const tracked = new Set();
    for (const rec of ls.stdout.split('\0')) if (rec.startsWith('120000 ')) tracked.add(normKey(path.join(wt.path, rec.split('\t')[1] || '')));
    trackedLinkRemoved = removedLinks.some((r) => tracked.has(normKey(path.resolve(r.link))));
  }

  if (wt.locked) {
    const u = git(['worktree', 'unlock', wt.path], { cwd: repo });
    if (!u.ok) throw new Error(`git worktree unlock failed: ${firstLine(u.stderr)}`);
  }

  // (b) git worktree remove (no --force). Fall back to the link-safe deleter
  // only for long-path failures (win32), links possibly below the scan depth, or
  // tracked links we removed ourselves.
  let useFallback = rescan.truncated || trackedLinkRemoved;
  if (!useFallback) {
    const r = git(['worktree', 'remove', wt.path], { cwd: repo });
    if (!r.ok) {
      // Long-path fallback is win32-only: there safeRemoveTree reaches past
      // MAX_PATH through \\?\ paths. POSIX has no such escape hatch, so the
      // fallback would only fail a second time; report git's error instead.
      if (IS_WIN && /filename too long|path too long|name too long/i.test(r.stderr)) useFallback = true;
      else throw new Error(`git worktree remove failed: ${firstLine(r.stderr)}`);
    }
  }
  if (useFallback && fs.existsSync(wt.path)) {
    safeRemoveTree(wt.path);
    if (lstatOrNull(nsPath(wt.path))) throw new Error(`could not delete ${wt.path}`);
  }
  git(['worktree', 'prune'], { cwd: repo });

  for (const r of removedLinks) {
    if (r.targetExisted && !fs.existsSync(r.target)) throw new SafetyError(`SAFETY: link target ${r.target} vanished during worktree removal`);
  }
}

function firstLine(s) {
  return String(s || '').trim().split(/\r?\n/)[0] || 'unknown error';
}

// ---------------------------------------------------------------- output

function printHuman(report, apply) {
  const lines = [];
  lines.push(`worktree-janitor${apply ? '' : ' (dry run)'}  repo: ${report.repo}  base: ${report.base}`);
  lines.push('Worktrees:');
  for (const w of report.worktrees) lines.push(`  ${w.action.padEnd(13)} ${w.path}${w.branch ? `  [${w.branch}]` : ''}\n                ${w.reason}`);
  lines.push('Branches:');
  if (!report.branches.length) lines.push('  (none)');
  for (const b of report.branches) lines.push(`  ${b.action.padEnd(13)} ${b.name}\n                ${b.reason}`);
  for (const e of report.errors) lines.push(`error: ${e}`);
  if (!apply) lines.push('Dry run: nothing was changed. Re-run with --apply to act.');
  process.stdout.write(lines.join('\n') + '\n');
}

function hookSummary(report) {
  const wts = report.worktrees.filter((w) => w.action === 'removed');
  const brs = report.branches.filter((b) => b.action === 'deleted');
  const parts = [];
  const list = (arr) => (arr.length > 4 ? `${arr.slice(0, 4).join(', ')}, +${arr.length - 4} more` : arr.join(', '));
  if (wts.length) parts.push(`removed ${wts.length} merged worktree(s) (${list(wts.map((w) => path.basename(w.path)))})`);
  if (brs.length) parts.push(`deleted ${brs.length} merged branch(es) (${list(brs.map((b) => b.name))})`);
  const safety = report.errors.find((e) => e.startsWith('SAFETY'));
  if (safety) parts.push(safety);
  return parts.length ? `worktree-janitor: ${parts.join('; ')}` : '';
}

// Windows PowerShell 5.1 prefixes piped stdin with a UTF-8 BOM (EF BB BF),
// which decodes to U+FEFF and makes JSON.parse throw.
const stripBom = (s) => s.replace(/^﻿/, '');

function readStdin(ms) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    // Collect raw bytes and decode once as UTF-8, so a multi-byte character
    // split across chunks decodes correctly.
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        process.stdin.pause();
      } catch {}
      resolve(stripBom(Buffer.concat(chunks).toString('utf8')));
    };
    const t = setTimeout(finish, ms);
    try {
      process.stdin.on('data', (d) => chunks.push(typeof d === 'string' ? Buffer.from(d, 'utf8') : d));
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
  });
}

// ---------------------------------------------------------------- main

async function main(argv) {
  let opts;
  const hookMode = argv.includes('--hook') || argv.some((a) => a.startsWith('--hook='));
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (hookMode) return 0;
    process.stderr.write(`worktree-janitor: ${e.message}\n${HELP}`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let hookCwd = null;
  if (opts.hook) {
    DEADLINE = Date.now() + HOOK_BUDGET_MS;
    const raw = await readStdin(opts.hook === 'post-tool-use' ? 3000 : 1000);
    let payload = null;
    try {
      const text = stripBom(raw).trim();
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (opts.hook === 'post-tool-use') {
      const cmd = payload && payload.tool_input && payload.tool_input.command;
      if (typeof cmd !== 'string' || !PR_MERGE_RE.test(cmd)) return 0;
    }
    if (payload && typeof payload.cwd === 'string' && payload.cwd) hookCwd = payload.cwd;
  }

  const start = path.resolve(opts.repo || hookCwd || process.cwd());
  const ctx = {
    start,
    cwdGuards: [process.cwd(), hookCwd],
    ghTimeout: opts.hook ? 6000 : GH_TIMEOUT_MS,
  };

  try {
    const report = janitor(opts, ctx);
    if (opts.hook) {
      const line = hookSummary(report);
      if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else if (line) process.stdout.write(line + '\n');
      return 0;
    }
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else printHuman(report, opts.apply);
    return report.errors.length ? 1 : 0;
  } catch (e) {
    if (opts.hook) return 0;
    process.stderr.write(`worktree-janitor: ${e.message}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => process.exit(process.argv.some((a) => a === '--hook' || a.startsWith('--hook=')) ? 0 : 1),
);

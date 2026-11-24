#!/usr/bin/env node
// @ts-check
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
const MOUNTINFO = '/proc/self/mountinfo';
const HOOK_BUDGET_MS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 10_000;
const FIRST_PARENT_CAP = 50_000;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);
// `gh pr merge`, also as `gh.exe` (Windows) and anywhere inside a wrapper
// such as `bash -lc "gh pr merge 5"` or `powershell.exe -Command '...'`.
const PR_MERGE_RE = /\bgh(?:\.exe)?\s+pr\s+merge\b/i;

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

// ---------------------------------------------------------------- types
//
// Type-checked with `tsc -p tsconfig.json` (JSDoc only, no build step).

/**
 * Parsed command line.
 * @typedef {object} Options
 * @property {boolean} apply          act instead of a dry run (implied by --hook)
 * @property {string | null} repo     --repo, unresolved
 * @property {string | null} base     --base
 * @property {boolean} json           machine-readable report
 * @property {string | null} hook     'session-start' | 'post-tool-use' once validated
 * @property {boolean} includeLocked  also remove worktrees with a live or unknown lock
 * @property {boolean} help
 */

/**
 * Where the janitor runs from, decided by main().
 * @typedef {object} Ctx
 * @property {string} start                 absolute path to resolve the repository from
 * @property {(string | null)[]} cwdGuards  directories whose enclosing worktrees are kept
 * @property {number} ghTimeout             ms per `gh` call
 */

/**
 * @typedef {object} RunOpts
 * @property {string} [cwd]
 * @property {number} [timeout]       ms, further capped by the time budget
 * @property {string} [input]         stdin for the child
 * @property {NodeJS.ProcessEnv} [env] merged over process.env
 */

/**
 * @typedef {object} RunResult
 * @property {boolean} ok              spawned and exited 0
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr           also carries the spawn error message, if any
 * @property {boolean} timedOut
 * @property {string | null} [spawnError] errno code when the spawn itself failed
 */

/**
 * One entry of `git worktree list --porcelain`.
 * @typedef {object} Worktree
 * @property {string} path
 * @property {string | null} head      HEAD sha
 * @property {string | null} branch    short branch name, null when detached
 * @property {boolean} detached
 * @property {boolean} bare
 * @property {boolean} locked
 * @property {string} lockReason       '' when none was given
 * @property {boolean} prunable
 */

/**
 * @typedef {object} RepoInfo
 * @property {string} main            path of the main worktree
 * @property {string | null} common   git common dir
 */

/**
 * @typedef {object} Verdict
 * @property {boolean} merged
 * @property {number} ahead   commits ahead of base, -1 when unknown
 * @property {string} reason
 */

/**
 * @typedef {object} MergedPr
 * @property {string} headRefOid
 * @property {number} number
 */

/**
 * @typedef {object} MountCheckResult
 * @property {string[]} mounts
 * @property {string | null} error   set when mounts could not be ruled out
 */

/**
 * @typedef {object} ScanResult
 * @property {string[]} links       symlinks / junctions / reparse points
 * @property {string[]} foreignDev  directories on another device (not descended)
 * @property {string[]} unreadable
 * @property {boolean} timedOut
 */

/**
 * @typedef {object} ScanOpts
 * @property {(p: string) => { dev: number, isDirectory(): boolean, isSymbolicLink(): boolean }} [lstat]
 * @property {() => number} [deadline]  ms left in the time budget
 */

/**
 * @typedef {object} MountCheckOpts
 * @property {NodeJS.Platform | string} [platform]
 * @property {() => string} [read]   returns the mountinfo text
 */

/**
 * A link removed by removeLinkOnly.
 * @typedef {object} LinkRemoval
 * @property {string} link
 * @property {string | null} target   realpath of the target, null when dangling
 * @property {boolean} targetExisted
 */

/**
 * @typedef {object} TreeRemoval
 * @property {number} removed       entries deleted
 * @property {LinkRemoval[]} links
 */

/**
 * @typedef {object} Problem
 * @property {string} msg
 * @property {boolean} safety
 */

/**
 * @typedef {object} WorktreeRemoval
 * @property {LinkRemoval[]} links
 * @property {boolean} registered   git still lists the worktree
 * @property {Problem[]} problems
 */

/** @typedef {'kept' | 'would-remove' | 'removed' | 'partial'} WorktreeAction */
/** @typedef {'kept' | 'would-delete' | 'deleted'} BranchAction */

/**
 * @typedef {object} WorktreeReport
 * @property {string} path
 * @property {string | null} branch
 * @property {WorktreeAction} action
 * @property {string} reason
 * @property {string} [stoppedAt]   where a 'partial' deletion stopped
 */

/**
 * @typedef {object} BranchReport
 * @property {string} name
 * @property {BranchAction} action
 * @property {string} reason
 */

/**
 * What the janitor did (or would do); printed as is with --json.
 * @typedef {object} Report
 * @property {string | null} repo
 * @property {string | null} base
 * @property {boolean} applied
 * @property {WorktreeReport[]} worktrees
 * @property {BranchReport[]} branches
 * @property {string[]} errors
 */

/**
 * The parts of a Claude Code / Codex hook payload (stdin JSON) that are read.
 * Every field is checked at runtime; the payload may have any shape.
 * @typedef {object} HookPayload
 * @property {unknown} [cwd]
 * @property {string | HookToolInput | null} [tool_input]
 */

/**
 * @typedef {object} HookToolInput
 * @property {unknown} [command]   string, or an argv array
 * @property {unknown} [cmd]       fallback name for command
 */

// ---------------------------------------------------------------- arguments

/**
 * @param {string[]} argv
 * @returns {Options}
 * @throws {UsageError}
 */
function parseArgs(argv) {
  /** @type {Options} */
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
  --hook <kind>      Claude Code / Codex hook mode (implies --apply, quiet, always exits 0)
  --include-locked   also remove worktrees locked by a live or unknown owner
`;

// ---------------------------------------------------------------- process helpers

/** Epoch ms after which no new child process is started (hook mode only). */
let DEADLINE = Infinity;
/** @returns {number} ms left in the time budget */
const remaining = () => DEADLINE - Date.now();

/**
 * Run a command synchronously, never prompting, within the time budget.
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOpts} [opts]
 * @returns {RunResult}
 */
function run(cmd, args, { cwd, timeout = GIT_TIMEOUT_MS, input, env } = {}) {
  const left = remaining();
  if (left <= 250) return { ok: false, status: null, stdout: '', stderr: 'time budget exhausted', timedOut: true };
  /** @type {import('node:child_process').SpawnSyncReturns<string> & { error?: NodeJS.ErrnoException }} */
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

/**
 * @param {string[]} args
 * @param {RunOpts} [opts]
 * @returns {RunResult}
 */
function git(args, opts = {}) {
  return run('git', ['-c', 'core.quotepath=off', ...args], opts);
}

/**
 * @param {string[]} args
 * @param {RunOpts} [opts]
 * @returns {string | null} trimmed stdout, or null when git failed
 */
function gitOut(args, opts) {
  const r = git(args, opts);
  return r.ok ? r.stdout.trim() : null;
}

/**
 * The gh executable and leading arguments ($JANITOR_GH overrides; a .js/.mjs/.cjs
 * override runs under the current runtime).
 * @returns {[string, string[]]}
 */
function ghCommand() {
  const override = process.env.JANITOR_GH;
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return [process.execPath, [override]];
    return [override, []];
  }
  return ['gh', []];
}

/**
 * @param {number} pid
 * @returns {boolean} true when the process exists (EPERM counts as alive)
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (/** @type {any} */ e) {
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
/**
 * @param {string} p
 * @returns {string}
 */
function realish(p) {
  let cur = path.resolve(p);
  /** @type {string[]} */
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
/**
 * @param {string} p
 * @returns {string}
 */
function normKey(p) {
  const r = realish(p);
  return IS_WIN ? r.toLowerCase() : r;
}

// Identity of an existing path (device + inode). A second, independent check
// behind the string comparison: it holds however the path is spelled (case,
// symlinked prefixes such as /var vs /private/var), so the safety guards do
// not depend on realpath canonicalising case on darwin. Some filesystems
// report inode 0 (FAT, some network shares): no identity then.
/**
 * @param {string} p
 * @returns {string | null} "dev:ino", or null when missing or without an inode
 */
function fileId(p) {
  try {
    const s = fs.statSync(p, { bigint: true });
    return s.ino ? `${s.dev}:${s.ino}` : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  if (normKey(a) === normKey(b)) return true;
  const ia = fileId(a);
  return ia !== null && ia === fileId(b);
}

/**
 * @param {string} child
 * @param {string} parent
 * @returns {boolean} true when child is parent itself or below it
 */
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

/**
 * @param {string} p
 * @returns {fs.Stats | null}
 */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * @param {string} p
 * @param {{ isSymbolicLink(): boolean, isDirectory(): boolean }} st  lstat of p
 * @returns {boolean}
 */
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

/** @type {(p: string) => string} long-path (\\?\) form on win32, p elsewhere */
const nsPath = (p) => (IS_WIN ? path.toNamespacedPath(path.resolve(p)) : p);

// ---------------------------------------------------------------- mount points
//
// A mount inside a worktree (a bind mount, a tmpfs, a mounted volume) holds
// data that does not belong to the worktree. Recursive deletion crosses into
// it: `git worktree remove` empties the mounted source and only then fails
// with "Device or resource busy" on the mount point itself. So any mount at or
// below a worktree keeps that worktree; the janitor never unmounts anything.
// Two independent detectors:
//   - Linux: /proc/self/mountinfo lists every mount point, including bind
//     mounts of the same filesystem, which st_dev cannot see.
//   - every OS: a directory whose st_dev differs from the worktree root's is
//     on another filesystem (see scanTree). On Windows a mounted volume is a
//     reparse point that Node does not report as a link, so this is what
//     catches it; junctions and symlinks are links and are only unlinked.

// One /proc/self/mountinfo line:
//   36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw
// Field 5 is the mount point. The kernel writes space, tab, newline and
// backslash in it as 3-digit octal escapes (\040 \011 \012 \134); every other
// byte, including non-ASCII UTF-8, is written raw.
/**
 * @param {unknown} text  mountinfo contents (coerced with String)
 * @returns {string[]} mount points
 */
export function parseMountinfo(text) {
  /** @type {string[]} */
  const out = [];
  for (const line of String(text).split('\n')) {
    const f = line.split(' ');
    if (f.length < 5 || !f[4].startsWith('/')) continue;
    out.push(f[4].replace(/\\([0-3][0-7]{2})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
  }
  return out;
}

// Mount points equal to or below `root` (a realpath), from mountinfo text.
/**
 * @param {string} mountinfoText
 * @param {string} root
 * @returns {string[]}
 */
export function mountPointsUnder(mountinfoText, root) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return parseMountinfo(mountinfoText).filter((mp) => mp === root || mp.startsWith(prefix));
}

// -> { mounts: string[], error: string | null }. On Linux an unreadable or
// empty mountinfo is an error: the caller must then keep the worktree.
/**
 * @param {string} root  realpath of the worktree
 * @param {MountCheckOpts} [opts]  injectable for tests
 * @returns {MountCheckResult}
 */
export function mountCheck(root, { platform = process.platform, read = () => fs.readFileSync(MOUNTINFO, 'utf8') } = {}) {
  if (platform !== 'linux') return { mounts: [], error: null };
  let text;
  try {
    text = read();
  } catch (/** @type {any} */ e) {
    return { mounts: [], error: `cannot read ${MOUNTINFO} (${(e && e.code) || (e && e.message) || e})` };
  }
  if (!parseMountinfo(text).length) return { mounts: [], error: `${MOUNTINFO} lists no mounts` };
  return { mounts: mountPointsUnder(text, root), error: null };
}

/** @type {(mounts: string[]) => string} */
const mountReason = (mounts) => `contains mount point ${mounts[0]}${mounts.length > 1 ? ` (+${mounts.length - 1} more)` : ''}; unmount it first`;

// Walk `root` with lstat to any depth, never descending into links, skipping
// the worktree's own `.git`. Returns every link (symlink / junction / reparse
// point), every directory on another device than `root` (not descended),
// every directory that could not be read, and whether the time budget ran out.
// `lstat` is injectable for tests.
/**
 * @param {string} root
 * @param {ScanOpts} [opts]
 * @returns {ScanResult}
 */
export function scanTree(root, { lstat = (p) => fs.lstatSync(p), deadline = () => remaining() } = {}) {
  /** @type {ScanResult} */
  const res = { links: [], foreignDev: [], unreadable: [], timedOut: false };
  let rootDev;
  try {
    rootDev = lstat(nsPath(root)).dev;
  } catch {
    res.unreadable.push(root);
    return res;
  }
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop()); // the loop condition guarantees an element
    let names;
    try {
      names = fs.readdirSync(nsPath(dir));
    } catch {
      res.unreadable.push(dir);
      continue;
    }
    for (const name of names) {
      if (dir === root && name === '.git') continue;
      if (++seen % 2048 === 0 && deadline() <= 1000) {
        res.timedOut = true;
        return res;
      }
      const p = path.join(dir, name);
      let st;
      try {
        st = lstat(nsPath(p));
      } catch {
        continue; // vanished
      }
      if (isLink(nsPath(p), st)) res.links.push(p);
      else if (st.isDirectory()) {
        if (st.dev !== rootDev) res.foreignDev.push(p);
        else stack.push(p);
      }
    }
  }
  return res;
}

// Why a worktree must be kept because of what is mounted in it (null = none).
/**
 * @param {string} wtPath
 * @param {ScanResult} scan
 * @returns {string | null}
 */
function mountKeepReason(wtPath, scan) {
  const m = mountCheck(realish(wtPath));
  if (m.error) return `${m.error}; cannot rule out mount points, not deleting`;
  if (m.mounts.length) return mountReason(m.mounts);
  if (scan.foreignDev.length) return mountReason(scan.foreignDev);
  if (scan.unreadable.length) return `cannot read ${scan.unreadable[0]}; cannot rule out mount points, not deleting`;
  if (scan.timedOut) return 'time budget exhausted while scanning for links and mount points';
  return null;
}

// Remove ONE link without touching what it points to, then prove it.
// POSIX: unlink(2) removes a symlink itself, whether it points to a file or a
// directory; rmdir(2) / rm -r are never used on a link. win32: junctions and
// directory symlinks may need RemoveDirectory, so rmdir (no /s) is tried too.
/**
 * @param {string} p
 * @returns {LinkRemoval}
 * @throws {SafetyError} when p stopped being a link or its target vanished
 */
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
  // targetExisted implies target !== null; tsc cannot follow that through a `let`.
  if (targetExisted && !fs.existsSync(/** @type {string} */ (target))) {
    throw new SafetyError(`SAFETY: link target ${target} vanished after removing link ${p}`);
  }
  return { link: p, target, targetExisted };
}

// Deletion stopped at `at`. `removed` entries were already deleted (0: none),
// `safety` marks a surprise (type change, foreign device) as opposed to a
// plain I/O failure.
class StopError extends Error {
  /**
   * @param {string} message
   * @param {string} at        path where deletion stopped
   * @param {boolean} safety
   */
  constructor(message, at, safety) {
    super(message);
    this.at = at;
    this.safety = safety;
    this.removed = 0;
    /** @type {LinkRemoval[]} */
    this.links = [];
  }
}

/**
 * @param {string} p
 * @returns {fs.BigIntStats | null}
 */
function lstatBigOrNull(p) {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch {
    return null;
  }
}

// Test hook, inert unless set: from its second lstat on, the directory at
// $JANITOR_TEST_FOREIGN_DEV_AT reports a foreign st_dev, i.e. it "becomes a
// mount point" after deletion has emptied it. Lets the test suite exercise
// the mid-deletion stop without root.
const TEST_FOREIGN_DEV_AT = process.env.JANITOR_TEST_FOREIGN_DEV_AT || null;

// Delete the worktree at `root` without git, failing closed. Never follows
// links (a link is unlinked, with its target checked intact afterwards).
// Before descending into a directory and again before removing it, re-lstat
// it and require: still a directory, not a link, same inode as when listed,
// and the root's st_dev. Any surprise or failure STOPS everything at once:
// nothing further is deleted, and the StopError says where. The root's
// `.git` file goes last, so a stopped deletion leaves a registered worktree.
// -> { removed, links }
/**
 * @param {string} root
 * @returns {TreeRemoval}
 * @throws {StopError}
 */
function removeTreeFailClosed(root) {
  const st0 = lstatBigOrNull(nsPath(root));
  if (!st0 || isLink(nsPath(root), st0) || !st0.isDirectory()) throw new StopError(`SAFETY: ${root} is not a plain directory`, root, true);
  const rootDev = st0.dev;
  const testKey = TEST_FOREIGN_DEV_AT ? normKey(TEST_FOREIGN_DEV_AT) : null;
  let testHits = 0;
  /** @type {TreeRemoval} */
  const state = { removed: 0, links: [] };

  /**
   * @param {string} dir
   * @param {fs.BigIntStats} expect  lstat from when dir was listed
   * @returns {fs.BigIntStats}
   */
  const checkDir = (dir, expect) => {
    const st = lstatBigOrNull(nsPath(dir));
    if (!st) throw new StopError(`SAFETY: ${dir} vanished during deletion`, dir, true);
    if (isLink(nsPath(dir), st) || !st.isDirectory()) throw new StopError(`SAFETY: ${dir} stopped being a plain directory during deletion`, dir, true);
    if (st.ino !== expect.ino) throw new StopError(`SAFETY: ${dir} was replaced during deletion`, dir, true);
    const foreign = testKey !== null && normKey(dir) === testKey && ++testHits >= 2;
    if (foreign || st.dev !== rootDev) throw new StopError(`SAFETY: ${dir} is on another device (a mount point?); stopped deleting`, dir, true);
    return st;
  };
  /**
   * Delete one entry; on failure chmod it to `mode` and try once more.
   * @param {string} p
   * @param {(np: string) => void} op
   * @param {number} mode
   */
  const retry = (p, op, mode) => {
    try {
      op(nsPath(p));
    } catch {
      try {
        fs.chmodSync(nsPath(p), mode);
        op(nsPath(p));
      } catch (/** @type {any} */ e) {
        throw new StopError(`could not delete ${p}: ${(e && e.code) || (e && e.message) || e}`, p, false);
      }
    }
    state.removed++;
  };
  /**
   * @param {string} dir
   * @param {fs.BigIntStats} expect
   * @param {boolean} isRoot
   */
  const removeDir = (dir, expect, isRoot) => {
    const st = checkDir(dir, expect);
    let names;
    try {
      names = fs.readdirSync(nsPath(dir));
    } catch (/** @type {any} */ e) {
      throw new StopError(`cannot read ${dir}: ${(e && e.code) || e}`, dir, false);
    }
    if (isRoot && names.includes('.git')) names = [...names.filter((n) => n !== '.git'), '.git'];
    for (const name of names) {
      const p = path.join(dir, name);
      const cst = lstatBigOrNull(nsPath(p));
      if (!cst) continue; // already gone: nothing to delete
      if (isLink(nsPath(p), cst)) {
        try {
          state.links.push(removeLinkOnly(p));
        } catch (/** @type {any} */ e) {
          throw new StopError(e.message, p, e instanceof SafetyError);
        }
        state.removed++;
      } else if (cst.isDirectory()) removeDir(p, cst, false);
      else retry(p, (np) => fs.unlinkSync(np), 0o666);
    }
    checkDir(dir, st);
    retry(dir, (np) => fs.rmdirSync(np), 0o777);
  };

  try {
    removeDir(root, st0, true);
  } catch (/** @type {any} */ e) {
    const stop = e instanceof StopError ? e : new StopError(`deletion failed: ${e && e.message}`, root, false);
    stop.removed = state.removed;
    stop.links = state.links;
    throw stop;
  }
  return state;
}

// `git worktree remove` (without --force) refuses a worktree with submodules:
// a populated gitlink in its index, or a modules/ directory in its admin dir
// (<common-dir>/worktrees/<id>/modules), which holds the submodules' object
// stores and would be deleted along with the registration. Same rule here.
// -> a reason to keep the worktree, or null.
/**
 * @param {string} wtPath
 * @returns {string | null}
 */
function submoduleKeepReason(wtPath) {
  const ls = git(['ls-files', '-s', '-z'], { cwd: wtPath });
  if (!ls.ok) return `git ls-files failed: ${firstLine(ls.stderr)}`;
  for (const rec of ls.stdout.split('\0')) {
    if (!rec.startsWith('160000 ')) continue;
    const sub = rec.slice(rec.indexOf('\t') + 1);
    if (sub && lstatOrNull(nsPath(path.join(wtPath, sub, '.git')))) return `contains populated submodule ${sub} (git refuses to remove such worktrees)`;
  }
  const gd = gitOut(['rev-parse', '--git-dir'], { cwd: wtPath });
  if (!gd) return 'could not locate the worktree git dir';
  const admin = path.resolve(wtPath, gd);
  const modules = lstatOrNull(nsPath(path.join(admin, 'modules')));
  if (modules && modules.isDirectory()) return `has submodule git dirs in ${path.join(admin, 'modules')} (git refuses to remove such worktrees)`;
  return null;
}

// ---------------------------------------------------------------- git model

/**
 * @param {string} text  `git worktree list --porcelain` output
 * @returns {Worktree[]}
 */
function parseWorktrees(text) {
  /** @type {Worktree[]} */
  const out = [];
  /** @type {Worktree | null} */
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

// git before 2.31 prints no `locked` (and no `prunable`) line at all in
// `worktree list --porcelain`, so locks are read from where git keeps them:
// the file <common-dir>/worktrees/<id>/locked, whose sibling <id>/gitdir names
// the worktree's .git file. This also works when the worktree directory is
// gone. -> Map(normKey(worktree path) -> lock reason, '' when none given).
/**
 * @param {string} repo
 * @returns {Map<string, string>}
 */
function adminLocks(repo) {
  /** @type {Map<string, string>} */
  const locks = new Map();
  const c = gitOut(['rev-parse', '--git-common-dir'], { cwd: repo });
  if (!c) return locks;
  const dir = path.join(path.resolve(repo, c), 'worktrees');
  let ids;
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return locks;
  }
  for (const id of ids) {
    if (!lstatOrNull(path.join(dir, id, 'locked'))) continue;
    let reason = '';
    try {
      reason = fs.readFileSync(path.join(dir, id, 'locked'), 'utf8').trim();
    } catch {
      /* locked all the same */
    }
    try {
      const gitdir = fs.readFileSync(path.join(dir, id, 'gitdir'), 'utf8').trim();
      if (gitdir) locks.set(normKey(path.dirname(path.resolve(dir, id, gitdir))), reason);
    } catch {
      /* no gitdir: git cannot map it to a worktree either */
    }
  }
  return locks;
}

/**
 * @param {string} start
 * @returns {RepoInfo | null} null when start is missing or not inside a repository
 */
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

/**
 * @param {string} repo
 * @param {string | null} requested  --base, or null to auto-detect
 * @returns {string | null}
 */
function resolveBase(repo, requested) {
  /** @type {(ref: string) => boolean} */
  const verify = (ref) => !!gitOut(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo });
  if (requested) return verify(requested) ? requested : null;
  const head = gitOut(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: repo });
  /** @type {string[]} */
  const candidates = [];
  if (head) candidates.push(head.replace(/^refs\/remotes\//, ''));
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  for (const c of candidates) if (verify(c)) return c;
  return null;
}

// ---------------------------------------------------------------- merge decision

class MergeOracle {
  /**
   * @param {string} repo
   * @param {string} base
   * @param {number} ghTimeout  ms per `gh` call
   */
  constructor(repo, base, ghTimeout) {
    this.repo = repo;
    this.base = base;
    this.ghTimeout = ghTimeout;
    this.ghDisabled = false;
    /** @type {Map<string, Verdict>} */
    this.cache = new Map();
    /** @type {{ set: Set<string>, capped: boolean } | null} */
    this.firstParent = null;
  }

  /** @returns {{ set: Set<string>, capped: boolean }} base's first-parent chain (capped) */
  firstParentSet() {
    if (this.firstParent) return this.firstParent;
    const out = gitOut(['rev-list', '--first-parent', `--max-count=${FIRST_PARENT_CAP}`, this.base], { cwd: this.repo }) || '';
    const shas = out.split(/\r?\n/).filter(Boolean);
    this.firstParent = { set: new Set(shas), capped: shas.length >= FIRST_PARENT_CAP };
    return this.firstParent;
  }

  /**
   * A merged PR whose head was exactly `tip`, via gh; null when none or gh is unusable.
   * @param {string} branch
   * @param {string} tip
   * @returns {MergedPr | null}
   */
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
      /** @type {unknown} */
      const prs = JSON.parse(r.stdout || '[]');
      return Array.isArray(prs) ? prs.find((p) => p && p.headRefOid === tip) || null : null;
    } catch {
      return null;
    }
  }

  // -> { merged: boolean, ahead: number, reason: string }
  /**
   * @param {string} branch
   * @param {string} tip  branch tip sha
   * @returns {Verdict}
   */
  check(branch, tip) {
    const key = `${branch}\0${tip}`;
    if (this.cache.has(key)) return /** @type {Verdict} */ (this.cache.get(key)); // has() just said so
    const res = this._check(branch, tip);
    this.cache.set(key, res);
    return res;
  }

  /**
   * @param {string} branch
   * @param {string} tip
   * @returns {Verdict}
   */
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

/**
 * Decide, and with opts.apply act, for every worktree and local branch.
 * @param {Options} opts
 * @param {Ctx} ctx
 * @returns {Report}
 * @throws {Error} notRepo / UsageError / git too old (main() reports these)
 */
function janitor(opts, ctx) {
  /** @type {Report} */
  const report = { repo: null, base: null, applied: opts.apply, worktrees: [], branches: [], errors: [] };
  const repoInfo = resolveRepo(ctx.start);
  if (!repoInfo) {
    /** @type {Error & { notRepo?: boolean }} */
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
  // Fail closed: without the worktree list nothing is known about which
  // branches are checked out (git before 2.7 has no `worktree list`).
  const listed = git(['worktree', 'list', '--porcelain'], { cwd: repo });
  if (!listed.ok) throw new Error(`git worktree list --porcelain failed (git 2.7 or newer is required): ${firstLine(listed.stderr)}`);
  const wtList = parseWorktrees(listed.stdout);
  const locks = adminLocks(repo);
  for (const wt of wtList) {
    const reason = locks.get(normKey(wt.path));
    if (reason === undefined) continue;
    wt.locked = true;
    if (!wt.lockReason) wt.lockReason = reason;
  }
  /** @type {Map<string, string>} branch -> tip sha */
  const branchTips = new Map();
  for (const line of (gitOut(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads'], { cwd: repo }) || '').split(/\r?\n/)) {
    const [ref, sha] = line.split('\0');
    if (ref && sha) branchTips.set(ref.replace(/^refs\/heads\//, ''), sha);
  }

  /** @type {Map<string | null, Worktree>} */
  const checkedOut = new Map(); // branch -> worktree entry still holding it
  for (const wt of wtList) if (wt.branch) checkedOut.set(wt.branch, wt);

  /** @type {(b: string) => boolean} */
  const protectedBranch = (b) => b === baseLocal || PROTECTED_BRANCHES.has(b);
  const cwdGuards = /** @type {string[]} */ (ctx.cwdGuards.filter(Boolean)); // filter(Boolean) drops the nulls
  let safetyAbort = false;
  let pruneNeeded = false;

  // Typed as returning void: callers `return wtReport(...)` only to stop.
  /** @type {(wt: Worktree, action: WorktreeAction, reason: string, extra?: { stoppedAt?: string }) => void} */
  const wtReport = (wt, action, reason, extra = {}) => report.worktrees.push({ path: wt.path, branch: wt.branch, action, reason, ...extra });

  wtList.forEach((wt, idx) => {
    if (idx === 0) return wtReport(wt, 'kept', 'main worktree');
    if (wt.bare) return wtReport(wt, 'kept', 'bare repository entry');
    if (safetyAbort) return wtReport(wt, 'kept', 'skipped after a safety abort');
    if (remaining() <= 1000) return wtReport(wt, 'kept', 'time budget exhausted');

    const lockReason = wt.lockReason;
    let staleLock = false;
    if (wt.locked) {
      const m = lockReason.match(CLAUDE_LOCK_RE);
      const pid = m ? Number(m[1]) : null;
      if (m && !pidAlive(/** @type {number} */ (pid))) staleLock = true; // m implies pid is a number
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

    // `worktree list --porcelain` prints a HEAD line for every non-bare
    // worktree (all zeros when it cannot be resolved), so tip is a string;
    // the branchTips fallback is defensive.
    const tip = /** @type {string} */ (wt.head || branchTips.get(wt.branch));
    const verdict = oracle.check(wt.branch, tip);
    if (!verdict.merged) return wtReport(wt, 'kept', verdict.reason);

    const lockNote = wt.locked ? (staleLock ? '; stale Claude Code lock (pid not alive)' : '; lock overridden by --include-locked') : '';
    const subKeep = submoduleKeepReason(wt.path);
    if (subKeep) return wtReport(wt, 'kept', subKeep);
    // Mount detection comes before anything is deleted (dry run included).
    const scan = scanTree(wt.path);
    const mountKeep = mountKeepReason(wt.path, scan);
    if (mountKeep) return wtReport(wt, 'kept', mountKeep);
    const linkNote = scan.links.length ? `; ${scan.links.length} link(s) to be unlinked first` : '';
    if (!opts.apply) return wtReport(wt, 'would-remove', verdict.reason + lockNote + linkNote);

    let res;
    try {
      res = removeWorktree(repo, wt);
    } catch (/** @type {any} */ e) {
      const stop = e instanceof StopError ? e : null;
      if (e instanceof SafetyError || (stop && stop.safety)) safetyAbort = true;
      report.errors.push(e.message);
      // Something was already deleted: say so, and exactly where it stopped.
      if (stop && stop.removed > 0) {
        const n = `${stop.removed} entr${stop.removed === 1 ? 'y' : 'ies'}`;
        return wtReport(wt, 'partial', `deletion stopped at ${stop.at} after deleting ${n}: ${firstLine(e.message)}; nothing further was deleted`, { stoppedAt: stop.at });
      }
      return wtReport(wt, 'kept', `removal failed: ${firstLine(e.message)}`);
    }
    for (const p of res.problems) {
      report.errors.push(p.msg);
      if (p.safety) safetyAbort = true;
    }
    if (!res.registered) checkedOut.delete(wt.branch);
    wtReport(wt, 'removed', verdict.reason + lockNote + (res.links.length ? `; unlinked ${res.links.length} link(s), targets untouched` : ''));
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

/**
 * @param {string} repo  main worktree
 * @param {Worktree} wt
 * @returns {WorktreeRemoval}
 * @throws {SafetyError | StopError | Error} nothing (or, for a StopError, only part) was deleted
 */
function removeWorktree(repo, wt) {
  // Re-check the registration right before acting: never delete a path git
  // did not register, never the main worktree, never one containing it.
  if (samePath(wt.path, repo) || isInside(repo, wt.path)) throw new SafetyError('SAFETY: refusing to remove the main worktree');
  const now = parseWorktrees(gitOut(['worktree', 'list', '--porcelain'], { cwd: repo }) || '');
  if (!now.slice(1).some((w) => samePath(w.path, wt.path))) throw new Error(`no longer registered: ${wt.path}`);

  // Mounts again, right before touching anything: the scan may be seconds old.
  const mountKeep = mountKeepReason(wt.path, scanTree(wt.path));
  if (mountKeep) throw new Error(mountKeep);

  // The janitor deletes the tree itself and never calls `git worktree remove`:
  // git's recursive delete follows NTFS junctions on Windows (deleting e.g. a
  // node_modules junction's target in the main checkout) and crosses into
  // mounts everywhere (deleting the mounted source, then failing with EBUSY).
  // removeTreeFailClosed unlinks links, stays on the root's device and stops
  // at the first surprise; it throws a StopError saying how far it got.
  const res = removeTreeFailClosed(wt.path);

  // Only once the tree is gone: unlock (a stopped deletion keeps the lock)
  // and drop the registration.
  /** @type {Problem[]} */
  const problems = [];
  if (wt.locked) {
    const u = git(['worktree', 'unlock', wt.path], { cwd: repo });
    if (!u.ok) problems.push({ msg: `git worktree unlock failed: ${firstLine(u.stderr)}`, safety: false });
  }
  git(['worktree', 'prune'], { cwd: repo });
  const after = parseWorktrees(gitOut(['worktree', 'list', '--porcelain'], { cwd: repo }) || '');
  const registered = after.slice(1).some((w) => samePath(w.path, wt.path));
  if (registered) problems.push({ msg: `directory deleted but git still lists ${wt.path}; run git worktree prune`, safety: false });

  for (const r of res.links) {
    // targetExisted implies target !== null (see removeLinkOnly).
    if (r.targetExisted && !isInside(/** @type {string} */ (r.target), wt.path) && !fs.existsSync(/** @type {string} */ (r.target))) {
      problems.push({ msg: `SAFETY: link target ${r.target} vanished during worktree removal`, safety: true });
    }
  }
  return { links: res.links, registered, problems };
}

/**
 * @param {unknown} s
 * @returns {string} first non-empty-trimmed line, or 'unknown error'
 */
function firstLine(s) {
  return String(s || '').trim().split(/\r?\n/)[0] || 'unknown error';
}

// ---------------------------------------------------------------- output

/**
 * @param {Report} report
 * @param {boolean} apply
 * @returns {void}
 */
function printHuman(report, apply) {
  /** @type {string[]} */
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

/**
 * @param {Report} report
 * @returns {string} one line for the hook's stdout, '' when nothing happened
 */
function hookSummary(report) {
  const wts = report.worktrees.filter((w) => w.action === 'removed');
  const brs = report.branches.filter((b) => b.action === 'deleted');
  /** @type {string[]} */
  const parts = [];
  /** @type {(arr: string[]) => string} */
  const list = (arr) => (arr.length > 4 ? `${arr.slice(0, 4).join(', ')}, +${arr.length - 4} more` : arr.join(', '));
  if (wts.length) parts.push(`removed ${wts.length} merged worktree(s) (${list(wts.map((w) => path.basename(w.path)))})`);
  if (brs.length) parts.push(`deleted ${brs.length} merged branch(es) (${list(brs.map((b) => b.name))})`);
  // A half-deleted worktree must never go unmentioned.
  const partial = report.worktrees.filter((w) => w.action === 'partial');
  for (const w of partial) parts.push(`PARTIAL removal of ${path.basename(w.path)}: ${w.reason}`);
  const safety = report.errors.find((e) => e.startsWith('SAFETY'));
  if (safety && !partial.length) parts.push(safety);
  return parts.length ? `worktree-janitor: ${parts.join('; ')}` : '';
}

// Windows PowerShell 5.1 prefixes piped stdin with a UTF-8 BOM (EF BB BF),
// which decodes to U+FEFF and makes JSON.parse throw.
/** @type {(s: string) => string} */
const stripBom = (s) => s.replace(/^﻿/, '');

// The shell command a PostToolUse payload ran, as one string ('' if none).
// Claude Code (Bash, PowerShell) and Codex CLI (tool_name "Bash", also on
// Windows) send tool_input.command as a string: the command exactly as the
// model wrote it, without the powershell/bash wrapper Codex runs it in. An
// argv array (["bash", "-lc", "gh pr merge 5"]) is accepted too and joined
// with spaces; PR_MERGE_RE is unanchored, so a merge inside a wrapper still
// matches. Never throws, whatever the shape.
/**
 * @param {HookPayload | null} payload
 * @returns {string}
 */
function hookCommandText(payload) {
  const input = payload && payload.tool_input;
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const cmd = input.command !== undefined ? input.command : input.cmd;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) return cmd.filter((x) => typeof x === 'string').join(' ');
  return '';
}

/**
 * All of stdin as UTF-8 without a BOM; whatever arrived after `ms` ms, or ''
 * for a TTY. Never rejects.
 * @param {number} ms
 * @returns {Promise<string>}
 */
function readStdin(ms) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    // Collect raw bytes and decode once as UTF-8, so a multi-byte character
    // split across chunks decodes correctly.
    /** @type {Buffer[]} */
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

// process.cwd() throws ENOENT on POSIX when the directory we were started in
// has been deleted (e.g. a hook firing in a just-removed worktree). Windows
// cannot delete a process's cwd, so this only bites on Linux/macOS.
/** @returns {string | null} */
function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code (always 0 in hook mode)
 */
async function main(argv) {
  let opts;
  const hookMode = argv.includes('--hook') || argv.some((a) => a.startsWith('--hook='));
  try {
    opts = parseArgs(argv);
  } catch (/** @type {any} */ e) {
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
    /** @type {HookPayload | null} */
    let payload = null;
    try {
      const text = stripBom(raw).trim();
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) payload = null;
    if (opts.hook === 'post-tool-use' && !PR_MERGE_RE.test(hookCommandText(payload))) return 0;
    if (payload && typeof payload.cwd === 'string' && payload.cwd) hookCwd = payload.cwd;
  }

  const cwd = safeCwd();
  const startRaw = opts.repo || hookCwd || cwd;
  if (!startRaw || (!path.isAbsolute(startRaw) && !cwd)) {
    if (opts.hook) return 0;
    process.stderr.write('worktree-janitor: current directory no longer exists; pass an absolute --repo\n');
    return 1;
  }
  const start = cwd ? path.resolve(cwd, startRaw) : path.resolve(startRaw);
  /** @type {Ctx} */
  const ctx = {
    start,
    cwdGuards: [cwd, hookCwd],
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
    return report.errors.length || report.worktrees.some((w) => w.action === 'partial') ? 1 : 0;
  } catch (/** @type {any} */ e) {
    if (opts.hook) return 0;
    process.stderr.write(`worktree-janitor: ${e.message}\n`);
    return 1;
  }
}

// Tests import this module for its pure helpers; they set this flag first.
if (!(/** @type {{ __WORKTREE_JANITOR_NO_MAIN__?: boolean }} */ (globalThis)).__WORKTREE_JANITOR_NO_MAIN__) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(process.argv.some((a) => a === '--hook' || a.startsWith('--hook=')) ? 0 : 1),
  );
}

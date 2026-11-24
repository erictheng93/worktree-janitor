// @ts-check
// Helpers shared by the real-CLI channel tests (claude-real.mjs, codex-real.mjs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';

/**
 * Run a command; npm-installed CLIs are .cmd files on Windows, which only run
 * through a shell, so `viaShell` quotes the arguments for cmd.exe.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string, viaShell?: boolean, allowFail?: boolean, timeout?: number }} [o]
 * @returns {{ code: number | null, out: string, err: string }}
 */
export function run(cmd, args, o = {}) {
  const shell = !!o.viaShell && IS_WIN;
  const q = (/** @type {string} */ a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const r = spawnSync(shell ? cmd : cmd, shell ? args.map(q) : args, {
    cwd: o.cwd,
    env: o.env,
    input: o.input,
    encoding: 'utf8',
    shell,
    windowsHide: true,
    timeout: o.timeout ?? 180_000,
  });
  const res = { code: r.status, out: r.stdout || '', err: (r.stderr || '') + (r.error ? String(r.error) : '') };
  if (!o.allowFail && res.code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.code}\n${res.out}\n${res.err}`);
  return res;
}

/** @param {string} prefix */
export const tempDir = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/**
 * A repository with a merged worktree `wt-merged` and an unmerged `wt-open`.
 * @param {string} root
 * @returns {string} the main worktree
 */
export function makeRepo(root) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  fs.mkdirSync(root, { recursive: true });
  const g = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => run('git', a, { cwd, env });
  g(root, 'init', '-q', '--bare', 'origin.git');
  g(root, 'init', '-q', 'repo');
  const repo = path.join(root, 'repo');
  g(repo, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), 'a\n');
  g(repo, 'add', 'a');
  g(repo, 'commit', '-q', '-m', 'init');
  g(repo, 'remote', 'add', 'origin', '../origin.git');
  g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'remote', 'set-head', 'origin', 'main');
  for (const [name, merge] of [['merged', true], ['open', false]]) {
    const wt = path.join(root, `wt-${name}`);
    g(repo, 'worktree', 'add', '-q', '-b', String(name), wt);
    fs.writeFileSync(path.join(wt, String(name)), 'x\n');
    g(wt, 'add', String(name));
    g(wt, 'commit', '-q', '-m', String(name));
    if (merge) {
      g(repo, 'merge', '-q', '--no-ff', '-m', 'merge', String(name));
      g(repo, 'push', '-q', 'origin', 'main');
    }
  }
  return repo;
}

/**
 * @param {boolean} ok
 * @param {string} msg
 * @returns {asserts ok}
 */
export function check(ok, msg) {
  if (!ok) throw new Error(`FAIL: ${msg}`);
  console.log(`ok: ${msg}`);
}

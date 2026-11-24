// End-to-end tests: throwaway repos under os.tmpdir() with a bare "origin".
// Run: node --test test/janitor.test.mjs
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IS_WIN = process.platform === 'win32';
const JANITOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'janitor.mjs');
// The pure helpers, imported in-process without running the CLI.
globalThis.__WORKTREE_JANITOR_NO_MAIN__ = true;
const lib = await import(pathToFileURL(JANITOR).href);
// Runtime that executes janitor.mjs (the test runner itself is always node).
// JANITOR_RUNTIME=bun runs every janitor invocation under bun instead.
const RUNTIME = process.env.JANITOR_RUNTIME || process.execPath;
// realpath: git prints realpaths, and os.tmpdir() is not one on macOS
// (/var -> /private/var) nor on Windows CI (8.3 short names like RUNNER~1).
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-janitor-')));
after(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
});

// Hermetic git config: no system config, and a private "global" config with
// an identity, main as default branch and no signing, whatever the host has.
const GIT_GLOBAL = path.join(ROOT, 'gitconfig');
fs.writeFileSync(
  GIT_GLOBAL,
  [
    '[user]',
    '\tname = Test',
    '\temail = test@example.invalid',
    '[init]',
    '\tdefaultBranch = main',
    '[commit]',
    '\tgpgsign = false',
    '[core]',
    '\tautocrlf = false',
    '',
  ].join('\n'),
);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: GIT_GLOBAL,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function sh(cmd, args, cwd, env = GIT_ENV) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, windowsHide: true, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} (in ${cwd}) failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}
const git = (cwd, ...args) => sh('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], cwd);

// Same canonicalisation the janitor uses: realpath of the nearest existing
// ancestor, case folded only on win32.
function canon(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const r = path.join(fs.realpathSync.native(cur), ...rest);
      return IS_WIN ? r.toLowerCase() : r;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// Directory link that needs no privileges: junction on win32, symlink elsewhere.
async function dirLink(target, link) {
  if (IS_WIN) await sh('cmd', ['/d', '/c', 'mklink', '/J', link, target], path.dirname(link));
  else fs.symlinkSync(target, link, 'dir');
}

// Is the filesystem under ROOT case-sensitive? (Linux: usually yes; macOS and
// Windows: usually no, but either can be configured the other way.)
fs.mkdirSync(path.join(ROOT, 'CaseProbe'));
const CASE_SENSITIVE_FS = !fs.existsSync(path.join(ROOT, 'caseprobe'));

// Fake gh: answers `gh pr list --state merged --head <b> --json ...` from a
// JSON map { branch: [{ number, headRefOid }] } at $FAKE_GH_DATA.
const FAKE_GH = path.join(ROOT, 'fake-gh.mjs');
fs.writeFileSync(
  FAKE_GH,
  `import fs from 'node:fs';
const a = process.argv.slice(2);
const i = a.indexOf('--head');
const data = process.env.FAKE_GH_DATA ? JSON.parse(fs.readFileSync(process.env.FAKE_GH_DATA, 'utf8')) : {};
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, a.join(' ') + '\\n');
process.stdout.write(JSON.stringify(i >= 0 ? data[a[i + 1]] || [] : []));
`,
);

let counter = 0;
async function makeRepo() {
  const dir = path.join(ROOT, `r${++counter}`);
  fs.mkdirSync(dir);
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  // `init` + `symbolic-ref` rather than `init -b` (git 2.28+): the suite also
  // runs on older git (ubuntu 20.04 has 2.25).
  await git(dir, 'init', '-q', '--bare', origin);
  await git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await git(dir, 'init', '-q', seed);
  await git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await git(seed, 'config', 'user.name', 'Test');
  await git(seed, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(seed, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules\n.claude/worktrees/\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'init');
  await git(seed, 'push', origin, 'main');
  const main = path.join(dir, 'main');
  await git(dir, 'clone', '-q', origin, main);
  await git(main, 'config', 'user.name', 'Test');
  await git(main, 'config', 'user.email', 'test@example.invalid');
  const ghData = path.join(dir, 'gh.json');
  fs.writeFileSync(ghData, '{}');
  return { dir, origin, main, ghData };
}

async function commitFile(cwd, name, content, msg = `edit ${name}`) {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
  await git(cwd, 'add', name);
  await git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function addWorktree(r, name, { branch = name, detach = false, at } = {}) {
  const wt = at || path.join(r.dir, `wt-${name}`);
  if (detach) await git(r.main, 'worktree', 'add', '-q', '--detach', wt);
  else await git(r.main, 'worktree', 'add', '-q', '-b', branch, wt);
  return wt;
}

const janitor = (args, opts) => spawnRuntime([JANITOR, ...args], opts);

function spawnRuntime(runtimeArgs, { cwd, input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(RUNTIME, runtimeArgs, {
      cwd,
      env: { ...GIT_ENV, JANITOR_GH: FAKE_GH, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* not json */
      }
      resolve({ code, stdout, stderr, json });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const runJson = (r, extra = [], env = {}) => janitor(['--json', ...extra], { cwd: r.main, env: { FAKE_GH_DATA: r.ghData, ...env } });
const wtEntry = (rep, wt) => rep.worktrees.find((w) => canon(w.path) === canon(wt));
const brEntry = (rep, name) => rep.branches.find((b) => b.name === name);
const branchExists = async (r, b) => (await git(r.main, 'branch', '--list', b)).length > 0;

async function mergedFeature(r, name, how) {
  const wt = await addWorktree(r, name);
  await commitFile(wt, `${name}-1.txt`, 'one\n');
  const tip = await commitFile(wt, `${name}-2.txt`, 'two\n');
  // Base moves on first so rebased SHAs differ.
  await commitFile(r.main, `base-${name}.txt`, 'base\n');
  if (how === 'merge') await git(r.main, 'merge', '-q', '--no-ff', '-m', `Merge ${name}`, name);
  else if (how === 'rebase') await git(r.main, 'cherry-pick', `main..${name}`);
  else if (how === 'squash') {
    await git(r.main, 'merge', '-q', '--squash', name);
    await git(r.main, 'commit', '-q', '-m', `${name} (squash)`);
  }
  await git(r.main, 'push', '-q', 'origin', 'main');
  return { wt, tip };
}

describe('worktree-janitor', { concurrency: 6 }, () => {
  test('normal merge: worktree removed and branch deleted', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'feat', 'merge');
    const { json, code } = await runJson(r, ['--apply']);
    assert.equal(code, 0);
    assert.equal(wtEntry(json, wt).action, 'removed', wtEntry(json, wt).reason);
    assert.equal(brEntry(json, 'feat').action, 'deleted');
    assert.equal(fs.existsSync(wt), false);
    assert.equal(await branchExists(r, 'feat'), false);
    assert.equal(json.base, 'origin/main');
  });

  test('rebase merge (different SHAs): removed via git cherry', async () => {
    const r = await makeRepo();
    const { wt, tip } = await mergedFeature(r, 'reb', 'rebase');
    assert.notEqual(await git(r.main, 'merge-base', '--is-ancestor', tip, 'main').catch(() => 'not-ancestor'), '');
    const { json } = await runJson(r, ['--apply']);
    assert.equal(wtEntry(json, wt).action, 'removed', wtEntry(json, wt).reason);
    assert.match(wtEntry(json, wt).reason, /rebase/);
    assert.equal(await branchExists(r, 'reb'), false);
  });

  test('squash merge: kept without gh, removed when gh reports merged PR with same head', async () => {
    const r = await makeRepo();
    const { wt, tip } = await mergedFeature(r, 'sq', 'squash');
    let res = await runJson(r, ['--apply'], { FAKE_GH_DATA: '' });
    assert.equal(wtEntry(res.json, wt).action, 'kept');
    res = await runJson(r, ['--apply'], { JANITOR_GH: path.join(r.dir, 'no-such-gh.exe') });
    assert.equal(wtEntry(res.json, wt).action, 'kept');
    // Merged PR whose head is an OLDER commit must not count.
    fs.writeFileSync(r.ghData, JSON.stringify({ sq: [{ number: 7, headRefOid: '0'.repeat(40) }] }));
    res = await runJson(r, ['--apply']);
    assert.equal(wtEntry(res.json, wt).action, 'kept');
    fs.writeFileSync(r.ghData, JSON.stringify({ sq: [{ number: 7, headRefOid: tip }] }));
    res = await runJson(r, ['--apply']);
    assert.equal(wtEntry(res.json, wt).action, 'removed', wtEntry(res.json, wt).reason);
    assert.match(wtEntry(res.json, wt).reason, /PR #7/);
    assert.equal(await branchExists(r, 'sq'), false);
  });

  test('dirty tracked change and untracked file: kept even though merged', async () => {
    const r = await makeRepo();
    const a = await mergedFeature(r, 'dirty', 'merge');
    const b = await mergedFeature(r, 'untr', 'merge');
    fs.writeFileSync(path.join(a.wt, 'dirty-1.txt'), 'changed\n');
    fs.writeFileSync(path.join(b.wt, 'new-file.txt'), 'new\n');
    const { json } = await runJson(r, ['--apply']);
    assert.equal(wtEntry(json, a.wt).action, 'kept');
    assert.match(wtEntry(json, a.wt).reason, /dirty/);
    assert.equal(wtEntry(json, b.wt).action, 'kept');
    assert.match(wtEntry(json, b.wt).reason, /dirty/);
    assert.ok(fs.existsSync(path.join(a.wt, 'dirty-1.txt')));
    assert.ok(fs.existsSync(path.join(b.wt, 'new-file.txt')));
    assert.equal(brEntry(json, 'dirty').action, 'kept');
  });

  test('ignored files do not make a worktree dirty', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'ign', 'merge');
    fs.mkdirSync(path.join(wt, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'x', 'i.js'), '1');
    const { json } = await runJson(r, ['--apply']);
    assert.equal(wtEntry(json, wt).action, 'removed', wtEntry(json, wt).reason);
  });

  test('detached HEAD kept; fresh 0-commit branch kept; unmerged branch kept', async () => {
    const r = await makeRepo();
    const det = await addWorktree(r, 'det', { detach: true });
    const fresh = await addWorktree(r, 'fresh');
    const un = await addWorktree(r, 'unmerged');
    await commitFile(un, 'u.txt', 'u\n');
    await git(r.main, 'branch', 'fresh-loose'); // not checked out, 0 ahead
    await commitFile(r.main, 'm.txt', 'moves base\n');
    await git(r.main, 'push', '-q', 'origin', 'main');
    const { json } = await runJson(r, ['--apply']);
    assert.equal(wtEntry(json, det).action, 'kept');
    assert.match(wtEntry(json, det).reason, /detached/);
    assert.equal(wtEntry(json, fresh).action, 'kept');
    assert.match(wtEntry(json, fresh).reason, /0 commits ahead/);
    assert.equal(wtEntry(json, un).action, 'kept');
    assert.match(wtEntry(json, un).reason, /not merged/);
    assert.equal(brEntry(json, 'fresh-loose').action, 'kept');
    assert.equal(brEntry(json, 'main').action, 'kept');
    for (const p of [det, fresh, un]) assert.ok(fs.existsSync(p));
  });

  test('locked worktree kept; --include-locked removes it', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'lk', 'merge');
    await git(r.main, 'worktree', 'lock', '--reason', 'on a USB stick', wt);
    let res = await runJson(r, ['--apply']);
    assert.equal(wtEntry(res.json, wt).action, 'kept');
    assert.match(wtEntry(res.json, wt).reason, /locked: on a USB stick/);
    assert.equal(brEntry(res.json, 'lk').action, 'kept');
    res = await runJson(r, ['--apply', '--include-locked']);
    assert.equal(wtEntry(res.json, wt).action, 'removed', wtEntry(res.json, wt).reason);
    assert.equal(fs.existsSync(wt), false);
    assert.equal(await branchExists(r, 'lk'), false);
  });

  test('Claude Code lock: live PID kept, dead PID treated as stale and removed', async () => {
    const r = await makeRepo();
    const live = await mergedFeature(r, 'live', 'merge');
    const dead = await mergedFeature(r, 'dead', 'merge');
    // A PID that cannot exist anywhere: odd (Windows PIDs are multiples of 4) and above the
    // Linux (2^22) and macOS (99999) maxima. Reusing an exited child's PID was flaky on
    // Windows, which recycles PIDs fast enough for the janitor's own git processes to get it.
    const deadPid = 2147483645;
    assert.throws(() => process.kill(deadPid, 0), (e) => e.code === 'ESRCH');
    await git(r.main, 'worktree', 'lock', '--reason', `claude agent agent-a1b2c3 (pid ${process.pid} start 1)`, live.wt);
    await git(r.main, 'worktree', 'lock', '--reason', `claude session dead (pid ${deadPid})`, dead.wt);
    const { json } = await runJson(r, ['--apply']);
    assert.equal(wtEntry(json, live.wt).action, 'kept');
    assert.match(wtEntry(json, live.wt).reason, /live Claude Code process/);
    assert.equal(wtEntry(json, dead.wt).action, 'removed', wtEntry(json, dead.wt).reason);
    assert.match(wtEntry(json, dead.wt).reason, /stale/);
    assert.equal(fs.existsSync(dead.wt), false);
  });

  test('worktree-* companion branch with 0 commits ahead is deleted; others with 0 ahead kept', async () => {
    const r = await makeRepo();
    await git(r.main, 'branch', 'worktree-agent-abc123');
    await git(r.main, 'branch', 'scratch');
    // Claude-style nested worktree on a worktree-* branch: 0 ahead -> kept.
    const nested = await addWorktree(r, 'agent-def', { branch: 'worktree-agent-def', at: path.join(r.main, '.claude', 'worktrees', 'agent-def') });
    const { json } = await runJson(r, ['--apply']);
    assert.equal(brEntry(json, 'worktree-agent-abc123').action, 'deleted');
    assert.equal(brEntry(json, 'scratch').action, 'kept');
    assert.equal(brEntry(json, 'worktree-agent-def').action, 'kept');
    assert.equal(wtEntry(json, nested).action, 'kept');
    assert.equal(await branchExists(r, 'worktree-agent-abc123'), false);
  });

  test('link into the main checkout: worktree removed, link target and its files survive', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'lnk', 'merge');
    const shared = path.join(r.main, 'node_modules');
    fs.mkdirSync(path.join(shared, 'pkg', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'pkg', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(shared, 'pkg', 'deep', 'd.txt'), 'deep\n');
    const nestedDir = path.join(wt, 'packages', 'app');
    fs.mkdirSync(nestedDir, { recursive: true });
    const links = [path.join(wt, 'node_modules'), path.join(nestedDir, 'node_modules')];
    for (const l of links) {
      await dirLink(shared, l);
      assert.ok(fs.lstatSync(l).isSymbolicLink(), 'junction/symlink must be reported as a link');
    }
    // packages/app is an empty dir apart from the ignored link -> still clean.
    const dry = await runJson(r);
    assert.equal(wtEntry(dry.json, wt).action, 'would-remove', wtEntry(dry.json, wt).reason);
    assert.match(wtEntry(dry.json, wt).reason, /2 link\(s\)/);
    const { json } = await runJson(r, ['--apply']);
    assert.equal(wtEntry(json, wt).action, 'removed', wtEntry(json, wt).reason);
    assert.equal(fs.existsSync(wt), false);
    assert.equal(fs.readFileSync(path.join(shared, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(fs.readFileSync(path.join(shared, 'pkg', 'deep', 'd.txt'), 'utf8'), 'deep\n');
  });

  test('dry run changes nothing', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'dry', 'merge');
    await git(r.main, 'branch', 'worktree-agent-zzz');
    const res = await janitor([], { cwd: r.main, env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /dry run/);
    assert.match(res.stdout, /would-remove/);
    const { json } = await runJson(r);
    assert.equal(wtEntry(json, wt).action, 'would-remove');
    assert.equal(brEntry(json, 'dry').action, 'would-delete');
    assert.equal(brEntry(json, 'worktree-agent-zzz').action, 'would-delete');
    assert.ok(fs.existsSync(wt));
    assert.ok(await branchExists(r, 'dry'));
    assert.ok(await branchExists(r, 'worktree-agent-zzz'));
  });

  test('--repo from inside a worktree operates from the main worktree', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'inner', 'merge');
    const other = await mergedFeature(r, 'other', 'merge');
    const res = await janitor(['--json', '--apply', '--repo', other.wt], { cwd: r.dir, env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(canon(res.json.repo), canon(r.main));
    assert.equal(wtEntry(res.json, wt).action, 'removed');
    assert.equal(wtEntry(res.json, other.wt).action, 'removed');
  });

  test('cwd inside a worktree protects that worktree', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'here', 'merge');
    const res = await janitor(['--json', '--apply'], { cwd: wt, env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(wtEntry(res.json, wt).action, 'kept');
    assert.match(wtEntry(res.json, wt).reason, /current working directory/);
  });

  test('--hook post-tool-use: non-matching stdin does nothing; gh pr merge acts', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'hk', 'merge');
    const env = { FAKE_GH_DATA: r.ghData };
    for (const input of ['', 'not json', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr view 12' }, cwd: r.main })]) {
      const res = await janitor(['--hook', 'post-tool-use'], { cwd: r.main, input, env });
      assert.equal(res.code, 0);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, '');
      assert.ok(fs.existsSync(wt));
    }
    const hookInput = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 12 --rebase --delete-branch' }, cwd: r.main });
    const res = await janitor(['--hook', 'post-tool-use'], { cwd: r.dir, input: hookInput, env });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /^worktree-janitor: removed 1 merged worktree\(s\) \(wt-hk\); deleted 1 merged branch\(es\) \(hk\)\n$/);
    assert.equal(fs.existsSync(wt), false);
    // Nothing left to do -> silent.
    const again = await janitor(['--hook', 'post-tool-use'], { cwd: r.dir, input: hookInput, env });
    assert.equal(again.code, 0);
    assert.equal(again.stdout, '');
  });

  test('--hook post-tool-use: stdin with a UTF-8 BOM (Windows PowerShell 5.1) still acts', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'bom', 'merge');
    const body = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 3 --merge' }, cwd: r.main });
    const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
    const res = await janitor(['--hook', 'post-tool-use'], { cwd: r.dir, input, env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /removed 1 merged worktree\(s\) \(wt-bom\)/);
    assert.equal(fs.existsSync(wt), false);
    assert.equal(await branchExists(r, 'bom'), false);
  });

  test('--hook post-tool-use: PowerShell tool payload acts', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'pwsh', 'merge');
    const input = JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'gh pr merge 1 --rebase' }, cwd: r.main });
    const res = await janitor(['--hook', 'post-tool-use'], { cwd: r.dir, input, env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /removed 1 merged worktree\(s\) \(wt-pwsh\)/);
    assert.equal(fs.existsSync(wt), false);
  });

  test('--hook post-tool-use: Codex payload shapes (captured fixture, argv array, wrappers) act', async () => {
    const r = await makeRepo();
    const env = { FAKE_GH_DATA: r.ghData };
    const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(JANITOR), '..', 'test', 'fixtures', 'codex-0.172-windows.json'), 'utf8'));
    const withCommand = (command) => JSON.stringify({ ...fixture.postToolUse, cwd: r.main, tool_input: { command } });
    // The captured payload itself ran `git status`: nothing happens.
    const { wt: idle } = await mergedFeature(r, 'cx0', 'merge');
    let res = await janitor(['--hook', 'post-tool-use'], { cwd: r.dir, input: JSON.stringify({ ...fixture.postToolUse, cwd: r.main }), env });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
    assert.ok(fs.existsSync(idle));
    const shapes = [
      ['plain string (Codex 0.172)', 'gh pr merge 7 --squash --delete-branch'],
      ['argv array', ['bash', '-lc', 'gh pr merge 5 --merge']],
      ['bash -lc wrapper string', 'bash -lc "gh pr merge 5 --rebase"'],
      ['powershell wrapper string', `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'gh pr merge 5'`],
      ['gh.exe', 'gh.exe pr merge 9'],
    ];
    for (const [label, command] of shapes) {
      // Each shape gets a fresh merged worktree; the first run also removes cx0.
      const { wt } = await mergedFeature(r, `cx${shapes.findIndex((s) => s[0] === label) + 1}`, 'merge');
      res = await janitor(['--hook', 'post-tool-use'], { cwd: r.dir, input: withCommand(command), env });
      assert.equal(res.code, 0, label);
      assert.match(res.stdout, /removed \d merged worktree/, label);
      assert.equal(fs.existsSync(wt), false, label);
    }
  });

  test('--hook post-tool-use: odd payload shapes never throw and do nothing', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'odd', 'merge');
    const odd = [
      'null',
      '42',
      '"gh pr merge 1"',
      JSON.stringify(['gh pr merge 1']),
      JSON.stringify({ tool_input: null, cwd: r.main }),
      JSON.stringify({ tool_input: 7, cwd: r.main }),
      JSON.stringify({ tool_input: { command: { nested: 'gh pr merge 1' } }, cwd: r.main }),
      JSON.stringify({ tool_input: { command: [1, null, { a: 'gh pr merge' }] }, cwd: r.main }),
      JSON.stringify({ tool_input: { command: 'gh pr view 1' }, tool_response: { stdout: 'gh pr merge' }, cwd: r.main }),
      JSON.stringify({ tool_input: { command: 'echo ghpr merge' }, cwd: 12 }),
    ];
    for (const input of odd) {
      const res = await janitor(['--hook', 'post-tool-use'], { cwd: r.main, input, env: { FAKE_GH_DATA: r.ghData } });
      assert.equal(res.code, 0, input);
      assert.equal(res.stdout, '', input);
      assert.equal(res.stderr, '', input);
      assert.ok(fs.existsSync(wt), input);
    }
  });

  test('--hook session-start: Codex SessionStart payload (captured fixture) acts', async () => {
    const r = await makeRepo();
    const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(JANITOR), '..', 'test', 'fixtures', 'codex-0.172-windows.json'), 'utf8'));
    const { wt } = await mergedFeature(r, 'cxss', 'merge');
    const res = await janitor(['--hook', 'session-start'], { cwd: r.dir, input: JSON.stringify({ ...fixture.sessionStart, cwd: r.main }), env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /removed 1 merged worktree\(s\) \(wt-cxss\)/);
    assert.equal(fs.existsSync(wt), false);
  });

  test('--hook session-start acts and is silent when nothing to remove', async () => {
    const r = await makeRepo();
    let res = await janitor(['--hook', 'session-start'], { cwd: r.main, input: '', env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
    const { wt } = await mergedFeature(r, 'ss', 'merge');
    res = await janitor(['--hook', 'session-start'], { cwd: r.main, input: JSON.stringify({ cwd: r.main }), env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /removed 1 merged worktree/);
    assert.equal(fs.existsSync(wt), false);
  });

  test('not a git repo: hook exits 0 silently, manual exits 1', async () => {
    const dir = path.join(ROOT, `norepo-${++counter}`);
    fs.mkdirSync(dir);
    const env = { GIT_CEILING_DIRECTORIES: ROOT };
    for (const hook of ['session-start', 'post-tool-use']) {
      const input = JSON.stringify({ tool_input: { command: 'gh pr merge 1' }, cwd: dir });
      const res = await janitor(['--hook', hook], { cwd: dir, input, env });
      assert.equal(res.code, 0);
      assert.equal(res.stdout + res.stderr, '');
    }
    const res = await janitor([], { cwd: dir, env });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /not a git repository/);
  });

  test('offline / no origin: falls back to local main', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'off', 'merge');
    await git(r.main, 'remote', 'remove', 'origin');
    const { json } = await runJson(r, ['--apply']);
    assert.equal(json.base, 'main');
    assert.equal(wtEntry(json, wt).action, 'removed');
  });

  test('worktree with a populated submodule is kept, as git worktree remove would refuse it', async () => {
    const r = await makeRepo();
    const wt = await addWorktree(r, 'withsub');
    await git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', r.origin, 'sub');
    await git(wt, 'commit', '-q', '-m', 'add submodule');
    await commitFile(r.main, 'base-withsub.txt', 'base\n');
    await git(r.main, 'merge', '-q', '--no-ff', '-m', 'Merge withsub', 'withsub');
    await git(r.main, 'push', '-q', 'origin', 'main');
    assert.equal(await git(wt, 'status', '--porcelain'), '');
    const { json } = await runJson(r, ['--apply']);
    assert.equal(wtEntry(json, wt).action, 'kept', wtEntry(json, wt).reason);
    assert.match(wtEntry(json, wt).reason, /populated submodule sub/);
    assert.ok(fs.existsSync(path.join(wt, 'sub', 'README.md')));
    // Deinit empties the checkout but its object store stays in the admin dir.
    await git(wt, 'submodule', 'deinit', '-q', '-f', 'sub');
    const again = await runJson(r, ['--apply']);
    assert.equal(wtEntry(again.json, wt).action, 'kept', wtEntry(again.json, wt).reason);
    assert.match(wtEntry(again.json, wt).reason, /submodule git dirs/);
  });

  test('a device change detected mid-deletion stops at once: action partial, exit 1, hook summary says so', async () => {
    const setup = async (name) => {
      const r = await makeRepo();
      const { wt } = await mergedFeature(r, name, 'merge');
      // The test hook makes this directory report a foreign st_dev once the
      // deleter has emptied it, as if something got mounted there meanwhile.
      const mnt = path.join(wt, 'node_modules', 'mnt');
      fs.mkdirSync(path.join(mnt, 'x'), { recursive: true });
      fs.writeFileSync(path.join(mnt, 'x', 'f.txt'), '1\n');
      return { r, wt, mnt, env: { FAKE_GH_DATA: r.ghData, JANITOR_TEST_FOREIGN_DEV_AT: mnt } };
    };
    const assertStopped = async ({ r, wt, mnt }, name) => {
      assert.ok(fs.existsSync(mnt), 'the directory it stopped at was not removed');
      assert.ok(fs.existsSync(path.join(wt, '.git')), '.git is deleted last, so it is still there');
      assert.ok((await git(r.main, 'worktree', 'list', '--porcelain')).split('\n').some((l) => l.startsWith('worktree ') && canon(l.slice(9)) === canon(wt)), 'still registered');
      assert.ok(await branchExists(r, name), 'branch kept: still checked out');
    };

    const a = await setup('part');
    const res = await janitor(['--json', '--apply'], { cwd: a.r.main, env: a.env });
    assert.equal(res.code, 1);
    const e = wtEntry(res.json, a.wt);
    assert.equal(e.action, 'partial', e.reason);
    assert.equal(canon(e.stoppedAt), canon(a.mnt));
    assert.match(e.reason, /^deletion stopped at .*mnt after deleting \d+ entr(y|ies): SAFETY: .* is on another device \(a mount point\?\); stopped deleting; nothing further was deleted$/);
    assert.ok(res.json.errors.some((m) => m.startsWith('SAFETY')));
    assert.equal(brEntry(res.json, 'part').action, 'kept');
    await assertStopped(a, 'part');

    const b = await setup('parth');
    const hook = await janitor(['--hook', 'session-start'], { cwd: b.r.main, input: JSON.stringify({ cwd: b.r.main }), env: b.env });
    assert.equal(hook.code, 0);
    assert.match(hook.stdout, /^worktree-janitor: PARTIAL removal of wt-parth: deletion stopped at .*mnt after deleting/);
    await assertStopped(b, 'parth');
  });

  test('POSIX symlinks: tracked file symlink, ignored file/dir symlinks and a dangling one are unlinked; targets intact', { skip: IS_WIN && 'file symlinks need privileges on Windows and git checks them out as text (core.symlinks=false)' }, async () => {
    const r = await makeRepo();
    const outside = path.join(r.dir, 'outside');
    fs.mkdirSync(path.join(outside, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(outside, 'lib', 'x.js'), 'x\n');
    const wt = await addWorktree(r, 'sym');
    fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(wt, 'tracked-link'), 'file');
    await git(wt, 'add', 'tracked-link');
    await git(wt, 'commit', '-q', '-m', 'add tracked symlink');
    await commitFile(r.main, 'base-sym.txt', 'base\n');
    await git(r.main, 'merge', '-q', '--no-ff', '-m', 'Merge sym', 'sym');
    await git(r.main, 'push', '-q', 'origin', 'main');
    // Ignored (node_modules) links: to a directory, to a file, and dangling.
    fs.mkdirSync(path.join(wt, 'a'));
    fs.mkdirSync(path.join(wt, 'b'));
    fs.symlinkSync(path.join(outside, 'lib'), path.join(wt, 'node_modules'), 'dir');
    fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(wt, 'a', 'node_modules'), 'file');
    fs.symlinkSync(path.join(outside, 'no-such-target'), path.join(wt, 'b', 'node_modules'));
    const dry = await runJson(r);
    assert.equal(wtEntry(dry.json, wt).action, 'would-remove', wtEntry(dry.json, wt).reason);
    assert.match(wtEntry(dry.json, wt).reason, /4 link\(s\)/);
    const { json } = await runJson(r, ['--apply']);
    assert.equal(wtEntry(json, wt).action, 'removed', wtEntry(json, wt).reason);
    assert.match(wtEntry(json, wt).reason, /unlinked 4 link\(s\)/);
    assert.equal(fs.existsSync(wt), false);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep\n');
    assert.equal(fs.readFileSync(path.join(outside, 'lib', 'x.js'), 'utf8'), 'x\n');
    assert.ok(fs.lstatSync(path.join(r.main, 'tracked-link')).isSymbolicLink(), 'main checkout copy of the tracked link untouched');
    assert.equal(await branchExists(r, 'sym'), false);
  });

  test('case-sensitive FS: a cwd differing only in case is a different directory', { skip: !CASE_SENSITIVE_FS && 'filesystem is case-insensitive' }, async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'Cased', 'merge');
    const twin = path.join(path.dirname(wt), path.basename(wt).toLowerCase());
    assert.notEqual(twin, wt);
    fs.mkdirSync(twin);
    const res = await janitor(['--json', '--apply', '--repo', r.main], { cwd: twin, env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(wtEntry(res.json, wt).action, 'removed', wtEntry(res.json, wt).reason);
    assert.equal(fs.existsSync(wt), false);
    assert.ok(fs.existsSync(twin), 'the case twin is untouched');
  });

  test('case-insensitive FS: a hook cwd spelled in another case still protects the worktree', { skip: CASE_SENSITIVE_FS && 'filesystem is case-sensitive' }, async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'upper', 'merge');
    const variant = path.join(path.dirname(wt), path.basename(wt).toUpperCase());
    const res = await janitor(['--hook', 'session-start', '--json'], { cwd: r.dir, input: JSON.stringify({ cwd: variant }), env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0);
    assert.equal(wtEntry(res.json, wt).action, 'kept', wtEntry(res.json, wt).reason);
    assert.match(wtEntry(res.json, wt).reason, /current working directory/);
    assert.ok(fs.existsSync(wt));
  });

  test('hook cwd reached through a directory link (like macOS /var -> /private/var) still protects the worktree', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'alias', 'merge');
    const alias = path.join(ROOT, `alias-${++counter}`);
    await dirLink(r.dir, alias);
    const viaAlias = path.join(alias, path.basename(wt));
    assert.notEqual(fs.realpathSync.native(viaAlias), viaAlias, 'alias path is not its own realpath');
    assert.equal(canon(viaAlias), canon(wt), 'alias resolves to the worktree');
    const res = await janitor(['--hook', 'session-start', '--json'], { cwd: r.dir, input: JSON.stringify({ cwd: viaAlias }), env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0);
    assert.equal(canon(res.json.repo), canon(r.main));
    assert.equal(wtEntry(res.json, wt).action, 'kept', wtEntry(res.json, wt).reason);
    assert.match(wtEntry(res.json, wt).reason, /current working directory/);
    assert.ok(fs.existsSync(wt));
  });

  test('started in a deleted directory (POSIX): still works with an absolute --repo', { skip: IS_WIN && 'Windows cannot delete a process cwd' }, async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'gonecwd', 'merge');
    const gone = path.join(r.dir, 'gone');
    fs.mkdirSync(gone);
    const J = JSON.stringify;
    const code = [
      `const fs = require('fs');`,
      `process.chdir(${J(gone)});`,
      `fs.rmdirSync(${J(gone)});`,
      `process.argv = [process.argv[0], ${J(JANITOR)}, '--json', '--apply', '--repo', ${J(r.main)}];`,
      `import(${J(pathToFileURL(JANITOR).href)});`,
    ].join('\n');
    const res = await spawnRuntime(['-e', code], { cwd: r.dir, env: { FAKE_GH_DATA: r.ghData } });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(wtEntry(res.json, wt).action, 'removed', wtEntry(res.json, wt).reason);
    assert.equal(fs.existsSync(wt), false);
  });
});

// ---------------------------------------------------------------- mount points

describe('mount detection helpers (no privileges needed)', () => {
  const FIXTURE = [
    '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
    '25 22 0:22 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw',
    '40 22 8:1 /srv/precious /home/u/wt/node_modules rw,relatime shared:1 - ext4 /dev/sda1 rw',
    '41 22 0:40 / /home/u/wt/my\\040cache rw - tmpfs tmpfs rw',
    '42 22 0:41 / /home/u/wt/back\\134slash\\011tab rw - tmpfs tmpfs rw',
    '43 22 0:42 / /home/u/wt2 rw - tmpfs tmpfs rw',
    '44 22 0:43 / /home/u/wt/\u00fcber rw - tmpfs tmpfs rw',
    '',
  ].join('\n');

  test('parseMountinfo returns field 5 with octal escapes decoded', () => {
    assert.deepEqual(lib.parseMountinfo(FIXTURE), [
      '/',
      '/proc',
      '/home/u/wt/node_modules',
      '/home/u/wt/my cache',
      '/home/u/wt/back\\slash\ttab',
      '/home/u/wt2',
      '/home/u/wt/\u00fcber',
    ]);
  });

  test('mountPointsUnder matches the root and paths below it, not siblings sharing a prefix', () => {
    assert.deepEqual(lib.mountPointsUnder(FIXTURE, '/home/u/wt'), [
      '/home/u/wt/node_modules',
      '/home/u/wt/my cache',
      '/home/u/wt/back\\slash\ttab',
      '/home/u/wt/\u00fcber',
    ]);
    assert.deepEqual(lib.mountPointsUnder(FIXTURE, '/home/u/wt2'), ['/home/u/wt2']);
    assert.deepEqual(lib.mountPointsUnder(FIXTURE, '/home/u/w'), []);
    assert.deepEqual(lib.mountPointsUnder('40 22 8:1 / /x/wt rw - ext4 /dev/sda1 rw\n', '/x/wt'), ['/x/wt']);
  });

  test('mountCheck fails closed on Linux when mountinfo is unreadable or empty; no-op elsewhere', () => {
    const enoent = () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    };
    assert.match(lib.mountCheck('/home/u/wt', { platform: 'linux', read: enoent }).error, /cannot read \/proc\/self\/mountinfo \(ENOENT\)/);
    assert.match(lib.mountCheck('/home/u/wt', { platform: 'linux', read: () => '' }).error, /lists no mounts/);
    assert.equal(lib.mountCheck('/home/u/wt', { platform: 'linux', read: () => FIXTURE }).mounts.length, 4);
    assert.deepEqual(lib.mountCheck('/home/u/wt', { platform: 'darwin', read: enoent }), { mounts: [], error: null });
    assert.deepEqual(lib.mountCheck('C:\\wt', { platform: 'win32', read: enoent }), { mounts: [], error: null });
  });

  test('scanTree reports a directory on another device at any depth and does not descend into it', async () => {
    const root = path.join(ROOT, `scan-${++counter}`);
    const deep = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'mnt');
    fs.mkdirSync(path.join(deep, 'inner'), { recursive: true });
    await dirLink(ROOT, path.join(deep, 'inner', 'link-below-mount'));
    await dirLink(ROOT, path.join(root, 'a', 'b', 'link'));
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: nowhere\n');
    const foreign = canon(deep);
    const lstat = (p) => {
      const st = fs.lstatSync(p);
      if (canon(p) !== foreign) return st;
      const fake = Object.create(Object.getPrototypeOf(st));
      return Object.assign(fake, st, { dev: st.dev + 1 });
    };
    const res = lib.scanTree(root, { lstat, deadline: () => Infinity });
    assert.deepEqual(res.foreignDev.map(canon), [foreign]);
    assert.deepEqual(res.links.map(canon), [canon(path.join(root, 'a', 'b', 'link'))]);
    assert.deepEqual(res.unreadable, []);
    assert.equal(res.timedOut, false);
    // Without the fake device the deep link is found too: there is no depth limit.
    assert.equal(lib.scanTree(root, { deadline: () => Infinity }).links.length, 2);
  });
});

// Dry run, --apply and the session-start hook all keep the worktree.
async function assertKept(r, wt, branch, reasonRe) {
  for (const args of [[], ['--apply']]) {
    const { json, code } = await runJson(r, args);
    const e = wtEntry(json, wt);
    assert.equal(e.action, 'kept', `${args.join(' ') || 'dry run'}: ${e.reason}`);
    assert.match(e.reason, reasonRe);
    assert.equal(code, 0);
  }
  const hook = await janitor(['--hook', 'session-start'], { cwd: r.main, input: JSON.stringify({ cwd: r.main }), env: { FAKE_GH_DATA: r.ghData } });
  assert.equal(hook.code, 0);
  assert.doesNotMatch(hook.stdout, /removed \d+ merged worktree/);
  assert.ok(fs.existsSync(path.join(wt, '.git')), 'worktree still there');
  assert.ok(await branchExists(r, branch), 'branch kept');
}

// Mounting needs root (or CAP_SYS_ADMIN), or passwordless sudo (GitHub's
// ubuntu runners have it). Otherwise these tests are skipped.
const MOUNT = (() => {
  if (process.platform !== 'linux') return { skip: 'mount tests are Linux-only' };
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!asRoot && spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status !== 0) {
    return { skip: 'mount tests need root or passwordless sudo (sudo -n true failed)' };
  }
  const run = (...args) => {
    const argv = asRoot ? args : ['sudo', '-n', ...args];
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${argv.join(' ')} failed: ${(r.stderr || String(r.error || '')).trim()}`);
  };
  const probe = path.join(ROOT, 'mount-probe');
  fs.mkdirSync(probe);
  try {
    run('mount', '-t', 'tmpfs', 'tmpfs', probe);
    run('umount', probe);
  } catch (e) {
    return { skip: `mount does not work here (${e.message.split('\n')[0]})` };
  }
  return { skip: false, run };
})();

describe('mount points inside a worktree', { skip: MOUNT.skip, concurrency: 4 }, () => {
  // Mount, run `body`, always unmount (so the suite's cleanup never recurses
  // into a mount either).
  async function withMount(mountArgs, mp, body) {
    fs.mkdirSync(mp, { recursive: true });
    MOUNT.run('mount', ...mountArgs, mp);
    try {
      await body();
    } finally {
      MOUNT.run('umount', mp);
    }
  }

  test('same-filesystem bind mount at a gitignored path: kept, mounted source intact', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'bind', 'merge');
    const src = path.join(r.dir, 'precious');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'data.txt'), 'do-not-delete\n');
    fs.writeFileSync(path.join(src, 'sub', 'more.txt'), 'more\n');
    const mp = path.join(wt, 'node_modules');
    await withMount(['--bind', src], mp, async () => {
      assert.equal(await git(wt, 'status', '--porcelain'), '', 'ignored mount leaves the tree clean');
      await assertKept(r, wt, 'bind', /contains mount point .*node_modules; unmount it first/);
    });
    assert.equal(fs.readFileSync(path.join(src, 'data.txt'), 'utf8'), 'do-not-delete\n');
    assert.equal(fs.readFileSync(path.join(src, 'sub', 'more.txt'), 'utf8'), 'more\n');
  });

  test('tmpfs at a gitignored path: kept, its files intact', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'tmpfs', 'merge');
    const mp = path.join(wt, 'node_modules');
    await withMount(['-t', 'tmpfs', 'tmpfs'], mp, async () => {
      fs.writeFileSync(path.join(mp, 'data.txt'), 'do-not-delete\n');
      await assertKept(r, wt, 'tmpfs', /contains mount point .*node_modules; unmount it first/);
      assert.equal(fs.readFileSync(path.join(mp, 'data.txt'), 'utf8'), 'do-not-delete\n');
    });
  });

  test('bind mount nested 9 levels deep: kept, source intact', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'deep', 'merge');
    const src = path.join(r.dir, 'precious');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'data.txt'), 'do-not-delete\n');
    const mp = path.join(wt, 'node_modules', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'mnt');
    await withMount(['--bind', src], mp, async () => {
      await assertKept(r, wt, 'deep', /contains mount point .*node_modules\/a\/b\/c\/d\/e\/f\/g\/mnt; unmount it first/);
    });
    assert.equal(fs.readFileSync(path.join(src, 'data.txt'), 'utf8'), 'do-not-delete\n');
  });

  test('mount at a non-ignored path: kept as dirty, source intact', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'visible', 'merge');
    const src = path.join(r.dir, 'precious');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'data.txt'), 'do-not-delete\n');
    await withMount(['--bind', src], path.join(wt, 'data'), async () => {
      await assertKept(r, wt, 'visible', /dirty/);
    });
    assert.equal(fs.readFileSync(path.join(src, 'data.txt'), 'utf8'), 'do-not-delete\n');
  });
});

// macOS has no bind mounts or tmpfs, and no /proc/self/mountinfo: the janitor
// sees a mount there only through st_dev (scanTree). A disk image attached
// with hdiutil is a separate device, i.e. a real mount, needing no root on a
// normal user session; passwordless sudo (GitHub's macOS runners have it) is
// the fallback. Otherwise these tests are skipped.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const HDI = (() => {
  if (process.platform !== 'darwin') return { skip: 'hdiutil mount tests are macOS-only' };
  if (spawnSync('hdiutil', ['help'], { stdio: 'ignore' }).error) return { skip: 'hdiutil not found' };
  const canSudo = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
  const exec = (sudo, args) => {
    const argv = sudo ? ['sudo', '-n', 'hdiutil', ...args] : ['hdiutil', ...args];
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${argv.join(' ')} failed: ${(r.stderr || r.stdout || String(r.error || '')).trim()}`);
  };
  // hdiutil now and then fails transiently ("Resource temporarily
  // unavailable", "resource busy"): retry a few times before giving up.
  const retry = (fn, tries = 5) => {
    for (let i = 1; ; i++) {
      try {
        return fn();
      } catch (e) {
        if (i >= tries) throw e;
        sleepSync(500 * i);
      }
    }
  };
  let n = 0;
  const create = () => {
    const dmg = path.join(ROOT, `jt-${++n}.dmg`);
    retry(() => exec(false, ['create', '-quiet', '-size', '8m', '-fs', 'HFS+', '-volname', `jt${n}`, '-type', 'UDIF', dmg]));
    return dmg;
  };
  let sudo = false;
  const attach = (dmg, mp) => {
    fs.mkdirSync(mp, { recursive: true });
    retry(() => exec(sudo, ['attach', '-quiet', '-nobrowse', '-noautoopen', '-noverify', '-mountpoint', mp, dmg]));
  };
  const detach = (mp) => retry(() => exec(sudo, ['detach', '-quiet', '-force', mp]));

  // Probe: attach without sudo, then with `sudo -n`; the volume must be
  // writable and on its own device.
  const probe = path.join(ROOT, 'hdi-probe');
  let dmg;
  try {
    dmg = create();
  } catch (e) {
    return { skip: `hdiutil create does not work here (${e.message.split('\n')[0]})` };
  }
  const errors = [];
  for (const withSudo of canSudo ? [false, true] : [false]) {
    sudo = withSudo;
    try {
      attach(dmg, probe);
    } catch (e) {
      errors.push(e.message.split('\n')[0]);
      continue;
    }
    try {
      fs.writeFileSync(path.join(probe, 'probe.txt'), 'x');
      if (fs.lstatSync(probe).dev === fs.lstatSync(ROOT).dev) throw new Error('attached volume has the same st_dev as its parent');
    } catch (e) {
      errors.push(`${withSudo ? 'sudo ' : ''}attach: ${e.message}`);
      detach(probe);
      continue;
    }
    detach(probe);
    return { skip: false, sudo, create, attach, detach };
  }
  return { skip: `hdiutil attach does not work here (${errors.join('; ')})` };
})();

// CI sets JANITOR_REQUIRE_MOUNT_TESTS on ubuntu (passwordless sudo) and macOS
// (hdiutil), so the mount tests cannot silently turn into skips there.
test('mount tests are runnable where CI requires them', { skip: !process.env.JANITOR_REQUIRE_MOUNT_TESTS && 'JANITOR_REQUIRE_MOUNT_TESTS not set' }, () => {
  const skip = process.platform === 'darwin' ? HDI.skip : MOUNT.skip;
  assert.equal(skip, false, `mount tests would be skipped: ${skip}`);
});

describe('macOS disk image (hdiutil) mounted inside a worktree', { skip: HDI.skip, concurrency: 1 }, () => {
  // A fresh image with `files` on it, attached at `mp` for `body`, always
  // detached afterwards (so the suite's cleanup never recurses into it).
  async function withImage(mp, files, body) {
    const dmg = HDI.create();
    HDI.attach(dmg, mp);
    try {
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(mp, name)), { recursive: true });
        fs.writeFileSync(path.join(mp, name), content);
      }
      await body();
    } finally {
      HDI.detach(mp);
    }
    return dmg;
  }

  // The image still holds `files` after the janitor ran: re-attach it elsewhere.
  function assertImageHolds(dmg, files) {
    const mp = path.join(ROOT, `verify-${path.basename(dmg, '.dmg')}`);
    HDI.attach(dmg, mp);
    try {
      for (const [name, content] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(mp, name), 'utf8'), content, name);
    } finally {
      HDI.detach(mp);
    }
  }

  const PRECIOUS = { 'data.txt': 'do-not-delete\n', 'sub/more.txt': 'more\n' };

  test(`image attached at a gitignored path (${HDI.sudo ? 'sudo ' : ''}hdiutil): st_dev differs from the worktree root's`, async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'hdidev', 'merge');
    const mp = path.join(wt, 'node_modules');
    await withImage(mp, PRECIOUS, async () => {
      // This is the only signal the janitor has on macOS.
      const rootDev = fs.lstatSync(wt).dev;
      assert.notEqual(fs.lstatSync(mp).dev, rootDev, 'mount point is on another device');
      assert.equal(fs.lstatSync(path.join(mp, 'sub')).dev, fs.lstatSync(mp).dev, 'inside the image: same device as its root');
      assert.equal(fs.lstatSync(path.join(wt, 'README.md')).dev, rootDev);
      assert.deepEqual(lib.scanTree(wt, { deadline: () => Infinity }).foreignDev.map(canon), [canon(mp)]);
      // No mountinfo on macOS: the st_dev walk is all there is.
      assert.deepEqual(lib.mountCheck(wt), { mounts: [], error: null });
    });
  });

  test('image attached at a gitignored path: kept, data on the image intact', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'hdi', 'merge');
    const mp = path.join(wt, 'node_modules');
    const dmg = await withImage(mp, PRECIOUS, async () => {
      assert.equal(await git(wt, 'status', '--porcelain'), '', 'ignored mount leaves the tree clean');
      await assertKept(r, wt, 'hdi', /contains mount point .*node_modules; unmount it first/);
      assert.equal(fs.readFileSync(path.join(mp, 'data.txt'), 'utf8'), 'do-not-delete\n');
    });
    assertImageHolds(dmg, PRECIOUS);
  });

  test('image attached 9 levels deep: kept, data on the image intact', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'hdideep', 'merge');
    const mp = path.join(wt, 'node_modules', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'mnt');
    const dmg = await withImage(mp, PRECIOUS, async () => {
      await assertKept(r, wt, 'hdideep', /contains mount point .*node_modules\/a\/b\/c\/d\/e\/f\/g\/mnt; unmount it first/);
    });
    assertImageHolds(dmg, PRECIOUS);
  });

  test('image attached at a non-ignored path: kept as dirty, data on the image intact', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'hdivisible', 'merge');
    const dmg = await withImage(path.join(wt, 'data'), PRECIOUS, async () => {
      await assertKept(r, wt, 'hdivisible', /dirty/);
    });
    assertImageHolds(dmg, PRECIOUS);
  });

  test('dry run (human output) reports the worktree kept with the mount reason and changes nothing', async () => {
    const r = await makeRepo();
    const { wt } = await mergedFeature(r, 'hdidry', 'merge');
    const mp = path.join(wt, 'node_modules');
    const before = await git(r.main, 'worktree', 'list', '--porcelain');
    const dmg = await withImage(mp, PRECIOUS, async () => {
      const res = await janitor([], { cwd: r.main, env: { FAKE_GH_DATA: r.ghData } });
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /\(dry run\)/);
      const lines = res.stdout.split('\n');
      const i = lines.findIndex((l) => l.includes(wt));
      assert.ok(i >= 0, `worktree listed:\n${res.stdout}`);
      assert.match(lines[i], /^\s+kept\s/);
      assert.match(lines[i + 1], /contains mount point .*node_modules; unmount it first/);
      assert.match(res.stdout, /Dry run: nothing was changed/);
    });
    assert.equal(await git(r.main, 'worktree', 'list', '--porcelain'), before);
    assert.ok(await branchExists(r, 'hdidry'));
    assertImageHolds(dmg, PRECIOUS);
  });
});

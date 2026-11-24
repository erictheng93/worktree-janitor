// @ts-check
// The Claude Code channels with the real `claude` CLI, in a throwaway
// CLAUDE_CONFIG_DIR / HOME (the real ~/.claude is never used):
//
//   node test/channels/claude-real.mjs <dist-dir> <owner/repo> <git-ref>
//
// 1. install.sh / install.ps1 --claude from <dist-dir>: local marketplace at
//    <dir>/current, plugin installed; uninstall removes both.
// 2. The GitHub marketplace pinned to <git-ref> (`owner/repo@ref`).
// Each time a SessionStart hook must actually run: `claude -p` starts a
// session (and then fails, not logged in), and the merged worktree of a test
// repository must be gone while the unmerged one stays.
import fs from 'node:fs';
import path from 'node:path';
import { IS_WIN, run, tempDir, makeRepo, check } from './lib.mjs';

const [distArg, slug, ref] = process.argv.slice(2);
const dist = path.resolve(distArg);
const work = tempDir('wj-claude-');
const home = path.join(work, 'home');
fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: path.join(work, 'claude-config'),
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  CODEX_HOME: path.join(home, '.codex'),
  WORKTREE_JANITOR_BASE_URL: dist,
  WORKTREE_JANITOR_NO_USER_PATH: '1',
};
delete env.ANTHROPIC_API_KEY;
const version = fs.readdirSync(dist).find((f) => /^worktree-janitor-v.*\.tar\.gz$/.test(f))?.replace(/^worktree-janitor-|\.tar\.gz$/g, '') || '';
const PLUGIN = 'worktree-janitor@worktree-janitor-marketplace';
const claude = (/** @type {string[]} */ ...a) => run('claude', a, { env, viaShell: true });
const listed = () => JSON.parse(claude('plugin', 'list', '--json').out).filter((/** @type {{id: string}} */ p) => p.id === PLUGIN);

/** @param {string[]} args */
function installer(args) {
  if (IS_WIN) {
    const ps = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dist, 'install.ps1'), '-Version', version];
    const map = /** @type {Record<string, string>} */ ({ '--claude': '-Claude', '--uninstall': '-Uninstall' });
    return run('powershell.exe', [...ps, ...args.map((a) => map[a] || a)], { env });
  }
  return run('sh', [path.join(dist, 'install.sh'), '--version', version, ...args], { env });
}

/** @param {string} label */
function sessionStartCleans(label) {
  const warm = path.join(work, `warm-${label}`);
  fs.mkdirSync(warm);
  run('claude', ['-p', 'hi'], { env, cwd: warm, viaShell: true, allowFail: true, timeout: 120_000 });
  const repo = makeRepo(path.join(work, `repo-${label}`));
  const root = path.dirname(repo);
  for (let i = 1; i <= 3 && fs.existsSync(path.join(root, 'wt-merged')); i++) {
    const dbg = path.join(work, `debug-${label}-${i}.txt`);
    const r = run('claude', ['-p', 'hi', '--debug-file', dbg], { env, cwd: repo, viaShell: true, allowFail: true, timeout: 120_000 });
    console.log(`claude -p (attempt ${i}) exited ${r.code}: ${(r.out + r.err).trim().split('\n').slice(-2).join(' | ')}`);
    if (fs.existsSync(dbg)) for (const l of fs.readFileSync(dbg, 'utf8').split('\n')) if (/worktree-janitor|SessionStart/.test(l)) console.log(`  ${l.slice(0, 300)}`);
  }
  check(!fs.existsSync(path.join(root, 'wt-merged')), `${label}: SessionStart hook removed the merged worktree`);
  check(fs.existsSync(path.join(root, 'wt-open')), `${label}: the unmerged worktree is kept`);
}

try {
  console.log(`claude ${claude('--version').out.trim()} | release ${version} | ${slug}@${ref}`);

  // 1. installer, local marketplace
  installer(['--claude']);
  check(listed().length === 1, 'installer: plugin installed (user scope)');
  const markets = JSON.parse(claude('plugin', 'marketplace', 'list', '--json').out);
  const m = markets.find((/** @type {{name: string}} */ x) => x.name === 'worktree-janitor-marketplace');
  check(!!m && /current$/.test(String(m.path || m.installLocation)), `installer: marketplace points at <dir>/current (${m && (m.path || m.installLocation)})`);
  installer(['--claude']);
  check(listed().length === 1, 'installer: second run keeps one plugin');
  sessionStartCleans('installer');
  installer(['--uninstall', '--claude']);
  check(listed().length === 0, 'installer: uninstall removed the plugin');
  check(!JSON.parse(claude('plugin', 'marketplace', 'list', '--json').out).some((/** @type {{name: string}} */ x) => x.name === 'worktree-janitor-marketplace'), 'installer: uninstall removed the marketplace');

  // 2. GitHub marketplace pinned to a ref
  claude('plugin', 'marketplace', 'add', `${slug}@${ref}`);
  claude('plugin', 'install', PLUGIN, '--scope', 'user');
  const p = listed();
  check(p.length === 1, `github@${ref}: plugin installed (version ${p[0] && p[0].version})`);
  // The installer must leave a plugin from another channel alone.
  installer(['--claude']);
  check(listed().length === 1 && listed()[0].installPath === p[0].installPath, 'installer: a GitHub-marketplace plugin is left as it is');
  claude('plugin', 'marketplace', 'update', 'worktree-janitor-marketplace');
  sessionStartCleans('github');
  claude('plugin', 'uninstall', PLUGIN, '--scope', 'user');
  claude('plugin', 'marketplace', 'remove', 'worktree-janitor-marketplace');
  check(listed().length === 0, 'github: removed');
  console.log('claude channels: all checks passed');
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}

// @ts-check
// The Codex channels with the real `codex` CLI, in a throwaway CODEX_HOME /
// HOME (the real ~/.codex and ~/.agents are never used):
//
//   node test/channels/codex-real.mjs <checkout> <owner/repo> <git-ref>
//
// 1. Codex plugin from the local marketplace (<checkout>).
// 2. Codex plugin from GitHub pinned with --ref <git-ref>.
// 3. Hooks written by scripts/install.mjs --codex (config.toml).
// Each time a real `codex exec` session must run the SessionStart hook and
// remove the merged worktree of a test repository. Hook trust is bypassed
// with --dangerously-bypass-hook-trust (users trust them in /hooks or
// Settings > Hooks); there is no login, so the model call fails afterwards,
// which does not matter: SessionStart runs first.
import fs from 'node:fs';
import path from 'node:path';
import { run, tempDir, makeRepo, check } from './lib.mjs';

const [checkoutArg, slug, ref] = process.argv.slice(2);
const checkout = path.resolve(checkoutArg);
const work = tempDir('wj-codex-');
const home = path.join(work, 'home');
fs.mkdirSync(home, { recursive: true });
/** @type {NodeJS.ProcessEnv} */
const env = { ...process.env, CODEX_HOME: path.join(work, 'codex-home'), HOME: home, USERPROFILE: home };
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
fs.mkdirSync(String(env.CODEX_HOME), { recursive: true });
const PLUGIN = 'worktree-janitor@worktree-janitor-marketplace';
const codex = (/** @type {string[]} */ ...a) => run('codex', a, { env, viaShell: true });
const installed = () => {
  const j = JSON.parse(codex('plugin', 'list', '--json').out);
  return (j.installed || []).filter((/** @type {{pluginId: string}} */ p) => p.pluginId === PLUGIN);
};

/** @param {string} label */
function sessionStartCleans(label) {
  const repo = makeRepo(path.join(work, `repo-${label}`));
  const root = path.dirname(repo);
  const r = run('codex', ['exec', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', 'hi'], { env, cwd: repo, viaShell: true, allowFail: true, timeout: 240_000 });
  const lines = (r.out + r.err).split('\n').filter((l) => /hook|janitor/i.test(l));
  console.log(`codex exec exited ${r.code}${lines.length ? `\n  ${lines.slice(0, 10).join('\n  ')}` : ''}`);
  check(!fs.existsSync(path.join(root, 'wt-merged')), `${label}: SessionStart hook removed the merged worktree`);
  check(fs.existsSync(path.join(root, 'wt-open')), `${label}: the unmerged worktree is kept`);
}

function removePlugin() {
  codex('plugin', 'remove', PLUGIN);
  codex('plugin', 'marketplace', 'remove', 'worktree-janitor-marketplace');
  check(installed().length === 0, 'plugin and marketplace removed');
}

try {
  console.log(`${codex('--version').out.trim()} | ${slug} --ref ${ref}`);

  // 1. local marketplace
  codex('plugin', 'marketplace', 'add', checkout);
  codex('plugin', 'add', PLUGIN);
  check(installed().length === 1, 'local: plugin installed and enabled');
  sessionStartCleans('local-plugin');
  removePlugin();

  // 2. GitHub, pinned with --ref
  codex('plugin', 'marketplace', 'add', slug, '--ref', ref);
  codex('plugin', 'add', PLUGIN);
  const p = installed();
  check(p.length === 1, `github --ref ${ref}: plugin installed (version ${p[0] && p[0].version})`);
  sessionStartCleans('github-plugin');
  removePlugin();

  // 3. install.mjs-written hooks
  run(process.execPath, [path.join(checkout, 'scripts', 'install.mjs'), '--codex'], { env });
  sessionStartCleans('install-mjs');
  run(process.execPath, [path.join(checkout, 'scripts', 'install.mjs'), '--codex', '--uninstall'], { env });
  const cfg = path.join(String(env.CODEX_HOME), 'config.toml');
  check(!fs.existsSync(cfg) || !fs.readFileSync(cfg, 'utf8').includes('worktree-janitor >>>'), 'install.mjs: uninstall removed the hooks block');
  console.log('codex channels: all checks passed');
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}

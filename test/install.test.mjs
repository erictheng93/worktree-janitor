// Installer tests. Every run uses a throwaway HOME / USERPROFILE / CODEX_HOME
// under os.tmpdir() and a fake `claude` CLI; the real ones are never touched.
// Run: node --test test/install.test.mjs
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdQuote, shellQuote, hookCommand, codexHooksObject, codexTomlBlock } from '../scripts/install.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(REPO, 'scripts', 'install.mjs');
const JANITOR = path.join(REPO, 'scripts', 'janitor.mjs').split(path.sep).join('/');
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-install-')));
after(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
});

let counter = 0;
function sandbox() {
  const dir = path.join(ROOT, `s${++counter}`);
  const home = path.join(dir, 'home');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  return {
    dir,
    home,
    codexHome,
    config: path.join(codexHome, 'config.toml'),
    hooksJson: path.join(codexHome, 'hooks.json'),
    agentsMd: path.join(codexHome, 'AGENTS.md'),
    skillDir: path.join(home, '.agents', 'skills', 'clean-worktrees'),
  };
}

function install(sb, args, env = {}) {
  const r = spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, CODEX_HOME: sb.codexHome, JANITOR_CLAUDE: '', ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Every file under the sandbox, path -> bytes (hex), for exact comparisons.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p).toString('hex');
    }
  };
  walk(dir);
  return out;
}

const read = (p) => fs.readFileSync(p, 'utf8');

// The user's existing setup, shaped like a real one: notify, an inline
// SessionStart hook between someone else's markers, trust state, CRLF or LF.
const userConfig = (eol) =>
  [
    'model = "gpt-5"',
    'notify = ["notifier.exe", "turn-ended"]',
    '',
    '[hooks.state]',
    '',
    "[hooks.state.'C:\\Users\\u\\.codex\\config.toml:session_start:0:0']",
    'trusted_hash = "sha256:abc"',
    '',
    '# >>> other-tool SessionStart >>>',
    '[[hooks.SessionStart]]',
    'matcher = "startup|resume|clear|compact"',
    '',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    'command = \'echo "hello"\'',
    '# <<< other-tool SessionStart <<<',
    '',
  ].join(eol);

const userAgents = (eol) => ['# Global Codex Instructions', '', '<!-- other:start -->', 'Prefer the graph tools.', '<!-- other:end -->', ''].join(eol);

describe('install.mjs', { concurrency: 4 }, () => {
  test('codex, config.toml (CRLF) with an inline hook: idempotent, user hook first, uninstall restores bytes', () => {
    const sb = sandbox();
    fs.writeFileSync(sb.config, userConfig('\r\n'));
    fs.writeFileSync(sb.agentsMd, userAgents('\r\n'));
    const before = snapshot(sb.dir);

    let r = install(sb, ['--codex']);
    assert.equal(r.code, 0, r.stderr);
    const cfg = read(sb.config);
    assert.ok(cfg.startsWith(userConfig('\r\n')), 'existing content untouched, block appended');
    assert.ok(!/[^\r]\n/.test(cfg), 'CRLF kept throughout');
    assert.ok(cfg.indexOf('echo "hello"') < cfg.indexOf('janitor.mjs'), 'user hook stays SessionStart group 0');
    assert.ok(cfg.includes(`command = ${JSON.stringify(hookCommand('session-start', JANITOR))}`));
    assert.ok(cfg.includes('matcher = "Bash"'));
    assert.match(read(sb.agentsMd), /<!-- >>> worktree-janitor >>> -->[\s\S]*git worktree remove[\s\S]*<!-- <<< worktree-janitor <<< -->\r\n$/);
    assert.ok(read(sb.agentsMd).startsWith(userAgents('\r\n')));
    const skill = read(path.join(sb.skillDir, 'SKILL.md'));
    assert.match(skill, /^---\nname: clean-worktrees\ndescription: [^\n]+\n---\n/);
    assert.ok(skill.includes(JANITOR), 'absolute janitor path filled in');
    assert.equal(read(path.join(sb.skillDir, 'agents', 'openai.yaml')), 'policy:\n  allow_implicit_invocation: false\n');

    const once = snapshot(sb.dir);
    r = install(sb, ['--codex']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(snapshot(sb.dir), once, 'second install changes nothing');
    assert.match(r.stdout, /already installed/);

    r = install(sb, ['--codex', '--uninstall']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(snapshot(sb.dir), before, 'uninstall restores the original bytes and removes backups');
    assert.equal(fs.existsSync(sb.skillDir), false);
  });

  test('codex, hooks.json present: hooks go there, config.toml untouched, uninstall restores bytes', () => {
    const sb = sandbox();
    fs.writeFileSync(sb.config, userConfig('\n'));
    const userHooks = '{\n    "hooks": {\n        "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "mine.sh" } ] } ]\n    }\n}\n';
    fs.writeFileSync(sb.hooksJson, userHooks);
    const before = snapshot(sb.dir);

    let r = install(sb, ['--codex']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(sb.config), userConfig('\n'), 'config.toml untouched');
    const obj = JSON.parse(read(sb.hooksJson));
    assert.equal(obj.hooks.PostToolUse[0].hooks[0].command, 'mine.sh', 'user group keeps index 0');
    assert.deepEqual(obj.hooks.PostToolUse[1], codexHooksObject(JANITOR).PostToolUse[0]);
    assert.deepEqual(obj.hooks.SessionStart, codexHooksObject(JANITOR).SessionStart);

    const once = snapshot(sb.dir);
    r = install(sb, ['--codex']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(snapshot(sb.dir), once, 'second install changes nothing');

    r = install(sb, ['--codex', '--uninstall']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(snapshot(sb.dir), before);
  });

  test('codex, nothing there yet: creates config.toml and AGENTS.md, uninstall deletes them', () => {
    const sb = sandbox();
    let r = install(sb, ['--codex']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(read(sb.config).startsWith('# >>> worktree-janitor >>>\n'));
    assert.ok(fs.existsSync(sb.agentsMd));
    r = install(sb, ['--codex', '--uninstall']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(snapshot(sb.dir), {});
  });

  test('codex: tables Codex inserts inside our block (hook trust) survive reinstall and uninstall', () => {
    const sb = sandbox();
    fs.writeFileSync(sb.config, 'model = "gpt-5"\n');
    assert.equal(install(sb, ['--codex']).code, 0);
    // What Codex's config writer did on /hooks trust when there was no
    // [hooks.state] yet: new tables land before the end-marker comment.
    const trust = "\n[hooks.state]\n\n[hooks.state.'x:session_start:0:0']\ntrusted_hash = \"sha256:1\"\n";
    // (Observed with Codex 0.172: a blank line, then the tables, then our end marker.)
    const cfg = read(sb.config).replace('# <<< worktree-janitor <<<', trust + '# <<< worktree-janitor <<<');
    fs.writeFileSync(sb.config, cfg);
    let r = install(sb, ['--codex']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(sb.config), cfg, 'reinstall with the same content is a no-op (trust stays valid)');
    r = install(sb, ['--codex', '--uninstall']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(sb.config), 'model = "gpt-5"\n' + trust);
  });

  test('codex: --dry-run writes nothing, for install and uninstall', () => {
    const sb = sandbox();
    fs.writeFileSync(sb.config, userConfig('\n'));
    const before = snapshot(sb.dir);
    let r = install(sb, ['--codex', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would update .*config\.toml/);
    assert.match(r.stdout, /would create .*SKILL\.md/);
    assert.deepEqual(snapshot(sb.dir), before);
    assert.equal(install(sb, ['--codex']).code, 0);
    const installed = snapshot(sb.dir);
    r = install(sb, ['--codex', '--uninstall', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would delete .*SKILL\.md/);
    assert.deepEqual(snapshot(sb.dir), installed);
  });

  test('codex: refuses a config.toml with static hook arrays and a foreign skill of the same name', () => {
    const sb = sandbox();
    const cfg = 'model = "gpt-5"\n\n[hooks]\nSessionStart = []\n';
    fs.writeFileSync(sb.config, cfg);
    let r = install(sb, ['--codex']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /static array/);
    assert.equal(read(sb.config), cfg);

    const sb2 = sandbox();
    fs.mkdirSync(sb2.skillDir, { recursive: true });
    fs.writeFileSync(path.join(sb2.skillDir, 'SKILL.md'), '---\nname: clean-worktrees\ndescription: mine\n---\n');
    r = install(sb2, ['--codex']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not installed by worktree-janitor/);
    assert.equal(read(path.join(sb2.skillDir, 'SKILL.md')), '---\nname: clean-worktrees\ndescription: mine\n---\n');
    r = install(sb2, ['--codex', '--uninstall']);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(sb2.skillDir, 'SKILL.md')), 'uninstall leaves a foreign skill alone');
  });

  test('codex: respects CODEX_HOME outside HOME', () => {
    const sb = sandbox();
    const elsewhere = path.join(sb.dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const r = install(sb, ['--codex'], { CODEX_HOME: elsewhere });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(elsewhere, 'config.toml')));
    assert.equal(fs.existsSync(sb.config), false);
  });

  test('claude: fake CLI, install twice is idempotent, uninstall reverses; missing CLI is skipped', () => {
    const sb = sandbox();
    const state = path.join(sb.dir, 'claude-state.json');
    const fake = path.join(sb.dir, 'fake-claude.mjs');
    fs.writeFileSync(
      fake,
      `import fs from 'node:fs';
const f = ${JSON.stringify(state)};
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { markets: [], plugins: [], calls: [] };
const a = process.argv.slice(2);
const k = a.join(' ');
let out = '';
if (k === 'plugin marketplace list --json') out = JSON.stringify(s.markets);
else if (k === 'plugin list --json') out = JSON.stringify(s.plugins);
else {
  s.calls.push(k);
  if (a[1] === 'marketplace' && a[2] === 'add') s.markets.push({ name: 'worktree-janitor-marketplace', source: 'directory', path: a[3] });
  else if (a[1] === 'install') s.plugins.push({ id: a[2], scope: 'user' });
  else if (a[1] === 'uninstall') s.plugins = s.plugins.filter((p) => p.id !== a[2]);
  else if (a[1] === 'marketplace' && a[2] === 'remove') s.markets = s.markets.filter((m) => m.name !== a[3]);
  else process.exit(3);
}
fs.writeFileSync(f, JSON.stringify(s));
process.stdout.write(out);
`,
    );
    const env = { JANITOR_CLAUDE: fake };
    let r = install(sb, ['--claude'], env);
    assert.equal(r.code, 0, r.stderr);
    r = install(sb, ['--claude'], env);
    assert.equal(r.code, 0, r.stderr);
    let s = JSON.parse(read(state));
    assert.deepEqual(s.calls, [`plugin marketplace add ${REPO}`, 'plugin install worktree-janitor@worktree-janitor-marketplace --scope user']);
    r = install(sb, ['--claude', '--uninstall'], env);
    assert.equal(r.code, 0, r.stderr);
    s = JSON.parse(read(state));
    assert.deepEqual(s.calls.slice(2), ['plugin uninstall worktree-janitor@worktree-janitor-marketplace --scope user', 'plugin marketplace remove worktree-janitor-marketplace']);
    assert.deepEqual([s.markets, s.plugins], [[], []]);

    const empty = path.join(sb.dir, 'empty-path');
    fs.mkdirSync(empty);
    r = install(sb, ['--claude'], { PATH: empty, Path: empty });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skipped: `claude` is not on PATH/);
  });

  test('quoting: double quotes by default, single quotes when the path needs them', () => {
    assert.equal(shellQuote('C:/Program Files/x/janitor.mjs', true), '"C:/Program Files/x/janitor.mjs"');
    assert.equal(shellQuote("C:/Users/O'Brien/janitor.mjs", true), `"C:/Users/O'Brien/janitor.mjs"`);
    assert.equal(shellQuote('C:/a$b/janitor.mjs', true), "'C:/a$b/janitor.mjs'");
    assert.equal(shellQuote("C:/it's $x/j.mjs", true), "'C:/it''s $x/j.mjs'");
    assert.equal(shellQuote('/home/me/my repo/janitor.mjs', false), '"/home/me/my repo/janitor.mjs"');
    assert.equal(shellQuote("/home/o'b/$x/j.mjs", false), `'/home/o'\\''b/$x/j.mjs'`);
    assert.equal(hookCommand('session-start', '/a b/janitor.mjs', false), 'node "/a b/janitor.mjs" --hook session-start');
  });

  test('checked-in Codex templates match what the installer writes', () => {
    const J = '/path/to/worktree-janitor/scripts/janitor.mjs';
    const I = '/path/to/worktree-janitor/scripts/install.mjs';
    const json = JSON.parse(read(path.join(REPO, 'integrations', 'codex', 'hooks.json')));
    assert.deepEqual(json, { hooks: codexHooksObject(J, false) });
    const toml = read(path.join(REPO, 'integrations', 'codex', 'config.toml'));
    const block = ['# >>> worktree-janitor >>>', ...codexTomlBlock(J, false, I), '# <<< worktree-janitor <<<', ''].join('\n');
    assert.ok(toml.endsWith(block), 'config.toml template ends with the installer block');
  });
});

describe('cmdQuote (cmd.exe argument quoting for claude.cmd)', () => {
  test('quotes an argument that contains whitespace', () => {
    assert.equal(cmdQuote('C:\\Users\\John Doe\\repo'), '"C:\\Users\\John Doe\\repo"');
  });
  test('does not quote a plain argument that merely contains the letter s', () => {
    assert.equal(cmdQuote('C:\\Users\\sam\\plugins'), 'C:\\Users\\sam\\plugins');
    assert.equal(cmdQuote('settings'), 'settings');
  });
  test('quotes an argument with a cmd metacharacter such as &', () => {
    assert.equal(cmdQuote('a&b'), '"a&b"');
  });
  test('doubles embedded double quotes', () => {
    assert.equal(cmdQuote('say "hi"'), '"say ""hi"""');
  });
});

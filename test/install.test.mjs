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
import { cmdQuote, shellQuote, hookCommand, posixHookCommand, windowsHookCommand, codexHooksObject, codexTomlBlock } from '../scripts/install.mjs';

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
    assert.ok(cfg.includes(`command = ${JSON.stringify(posixHookCommand('session-start', JANITOR, process.execPath))}`));
    assert.ok(cfg.includes(`command_windows = ${JSON.stringify(windowsHookCommand('session-start', JANITOR, process.execPath))}`));
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

  // A fake `claude` CLI keeping its state in a JSON file; `initial` seeds it.
  const fakeClaude = (sb, initial = { markets: [], plugins: [], calls: [] }) => {
    const state = path.join(sb.dir, 'claude-state.json');
    const fake = path.join(sb.dir, 'fake-claude.mjs');
    fs.writeFileSync(
      fake,
      `import fs from 'node:fs';
const f = ${JSON.stringify(state)};
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const a = process.argv.slice(2);
const k = a.join(' ');
let out = '';
if (k === 'plugin marketplace list --json') out = JSON.stringify(s.markets);
else if (k === 'plugin list --json') out = JSON.stringify(s.plugins);
else {
  s.calls.push(k);
  if (a[1] === 'marketplace' && a[2] === 'add') s.markets.push({ name: 'worktree-janitor-marketplace', source: 'directory', path: a[3] });
  else if (a[1] === 'install') s.plugins.push({ id: a[2], scope: 'user' });
  else if (a[1] === 'update') s.plugins.forEach((p) => { if (p.id === a[2]) p.version = 'updated'; });
  else if (a[1] === 'marketplace' && a[2] === 'update') {}
  else if (a[1] === 'uninstall') s.plugins = s.plugins.filter((p) => p.id !== a[2]);
  else if (a[1] === 'marketplace' && a[2] === 'remove') s.markets = s.markets.filter((m) => m.name !== a[3]);
  else process.exit(3);
}
fs.writeFileSync(f, JSON.stringify(s));
process.stdout.write(out);
`,
    );
    fs.writeFileSync(state, JSON.stringify(initial));
    return { state, env: { JANITOR_CLAUDE: fake } };
  };

  test('claude: fake CLI, install twice is idempotent, uninstall reverses; missing CLI is skipped', () => {
    const sb = sandbox();
    const { state, env } = fakeClaude(sb);
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

  test('claude: a marketplace from another channel (GitHub) is left alone on install and uninstall', () => {
    const sb = sandbox();
    const github = { name: 'worktree-janitor-marketplace', source: 'github', repo: 'erictheng93/worktree-janitor', installLocation: path.join(sb.home, 'm') };
    const { state, env } = fakeClaude(sb, { markets: [github], plugins: [{ id: 'worktree-janitor@worktree-janitor-marketplace', scope: 'user', version: '0.0.1' }], calls: [] });
    let r = install(sb, ['--claude'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skipped: marketplace worktree-janitor-marketplace already comes from erictheng93\/worktree-janitor/);
    r = install(sb, ['--claude', '--uninstall'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /kept worktree-janitor@worktree-janitor-marketplace/);
    assert.deepEqual(JSON.parse(read(state)).calls, [], 'no claude command that changes anything');
  });

  test('claude: an older plugin version from this directory is updated', () => {
    const sb = sandbox();
    const local = { name: 'worktree-janitor-marketplace', source: 'directory', path: REPO };
    const { state, env } = fakeClaude(sb, { markets: [local], plugins: [{ id: 'worktree-janitor@worktree-janitor-marketplace', scope: 'user', version: '0.0.1' }], calls: [] });
    const r = install(sb, ['--claude'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(read(state)).calls, ['plugin marketplace update worktree-janitor-marketplace', 'plugin update worktree-janitor@worktree-janitor-marketplace --scope user']);
  });

  test('quoting: double quotes by default, single quotes when the path needs them', () => {
    assert.equal(shellQuote('C:/Program Files/x/janitor.mjs', true), '"C:/Program Files/x/janitor.mjs"');
    assert.equal(shellQuote("C:/Users/O'Brien/janitor.mjs", true), `"C:/Users/O'Brien/janitor.mjs"`);
    assert.equal(shellQuote('C:/a$b/janitor.mjs', true), "'C:/a$b/janitor.mjs'");
    assert.equal(shellQuote("C:/it's $x/j.mjs", true), "'C:/it''s $x/j.mjs'");
    assert.equal(shellQuote('/home/me/my repo/janitor.mjs', false), '"/home/me/my repo/janitor.mjs"');
    assert.equal(shellQuote("/home/o'b/$x/j.mjs", false), `'/home/o'\\''b/$x/j.mjs'`);
    assert.equal(hookCommand('session-start', '/a b/janitor.mjs', false, '/usr/bin/node'), posixHookCommand('session-start', '/a b/janitor.mjs', '/usr/bin/node'));
    const posix = posixHookCommand('session-start', '/a b/janitor.mjs', '/usr/bin/node');
    assert.ok(posix.startsWith('for n in "/usr/bin/node" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node '), posix);
    assert.ok(posix.endsWith('; do if [ -f "$n" ] && [ -x "$n" ]; then exec "$n" "/a b/janitor.mjs" --hook session-start; fi; done; exit 0'), posix);
    assert.ok(!posixHookCommand('session-start', '/a/j.mjs', null).includes('/usr/bin/node'), 'no recorded node: fallbacks only');
    const win = windowsHookCommand('post-tool-use', "C:/it's/j.mjs", 'C:\\n\\node.exe');
    assert.ok(!win.includes('"'), 'no double quotes in the PowerShell command');
    assert.ok(win.startsWith("$n = @('C:\\n\\node.exe', (Get-Command node.exe "), win);
    assert.ok(win.includes("{ & $n 'C:/it''s/j.mjs' --hook post-tool-use; exit $LASTEXITCODE }; exit 0"), win);
  });

  test('checked-in Codex templates match what the installer writes', () => {
    const J = '/path/to/worktree-janitor/scripts/janitor.mjs';
    const I = '/path/to/worktree-janitor/scripts/install.mjs';
    const json = JSON.parse(read(path.join(REPO, 'integrations', 'codex', 'hooks.json')));
    assert.deepEqual(json, { hooks: codexHooksObject(J, null) });
    const toml = read(path.join(REPO, 'integrations', 'codex', 'config.toml'));
    const block = ['# >>> worktree-janitor >>>', ...codexTomlBlock(J, false, I, null), '# <<< worktree-janitor <<<', ''].join('\n');
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

// The hook commands as the shells Codex uses actually run them: `<sh|bash|zsh>
// -c` on POSIX, `powershell|pwsh -NoProfile -Command` on Windows, payload on
// stdin. A fake janitor records its argv and stdin.
describe('Codex hook commands under real shells', () => {
  const dir = path.join(ROOT, 'shells');
  fs.mkdirSync(dir, { recursive: true });
  const fake = path.join(dir, "fake it's janitor.mjs").split(path.sep).join('/');
  fs.writeFileSync(fake, "import fs from 'node:fs';\nfs.writeFileSync(process.env.WJ_OUT, JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));\n");
  const emptyPath = path.join(dir, 'no-node-here');
  fs.mkdirSync(emptyPath, { recursive: true });
  // Absolute shell paths: the tests below replace PATH for the child.
  const which = (exe) => {
    for (const d of (process.env.PATH || process.env.Path || '').split(path.delimiter)) if (d && fs.existsSync(path.join(d, exe))) return path.join(d, exe);
    return null;
  };
  const shells = (process.platform === 'win32'
    ? [['powershell.exe', ['-NoProfile', '-Command']], ['pwsh.exe', ['-NoProfile', '-Command']]]
    : [['sh', ['-c']], ['bash', ['-c']], ['zsh', ['-c']]]
  ).map(([s, a]) => [which(s), a, s]).filter(([p]) => p);
  const payload = '{"hook_event_name":"PostToolUse","cwd":"/tmp/x","tool_input":{"command":"gh pr merge 1"},"note":"caf\u00e9"}';
  let n = 0;
  const run = (shell, args, cmd, env) => {
    const out = path.join(dir, `out${++n}.json`);
    // One PATH variable only: Windows environments may carry PATH and Path.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(env.PATH !== undefined && k.toUpperCase() === 'PATH')));
    const r = spawnSync(shell, [...args, cmd], { input: payload, encoding: 'utf8', windowsHide: true, env: { ...base, WJ_OUT: out, ...env } });
    return { code: r.status, stderr: r.stderr, got: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
  };
  const command = (node) => (process.platform === 'win32' ? windowsHookCommand('post-tool-use', fake, node) : posixHookCommand('post-tool-use', fake, node));
  const pathVar = 'PATH';
  const sysPath = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32') + path.delimiter + emptyPath : `${emptyPath}:/usr/bin:/bin`;

  test('at least one shell is available', () => assert.ok(shells.length > 0));
  for (const [shell, args, name] of shells) {
    test(`${name}: recorded node runs the janitor with the payload on stdin`, () => {
      const r = run(shell, args, command(process.execPath), {});
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.got && r.got.args, ['--hook', 'post-tool-use']);
      assert.equal(r.got.stdin.replace(/^\uFEFF/, '').trim(), payload);
    });
    test(`${name}: a recorded node that is gone falls back to node on PATH`, () => {
      const r = run(shell, args, command(path.join(dir, 'gone', process.platform === 'win32' ? 'node.exe' : 'node')), { [pathVar]: path.dirname(process.execPath) + path.delimiter + sysPath });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.got && r.got.args, ['--hook', 'post-tool-use']);
    });
    test(`${name}: no node anywhere on PATH exits 0 quietly`, () => {
      // A node in a well-known location (Homebrew, Program Files) may still be
      // found; either way the hook must exit 0 without noise.
      const r = run(shell, args, command(path.join(dir, 'gone', 'node')), { [pathVar]: sysPath, HOME: emptyPath });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr.trim(), '');
    });
  }
});

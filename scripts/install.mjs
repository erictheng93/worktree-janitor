#!/usr/bin/env node
// Install worktree-janitor for Claude Code and/or OpenAI Codex CLI.
// Node >= 18 stdlib only; Windows, macOS and Linux.
//
//   node scripts/install.mjs [--claude] [--codex] [--all] [--uninstall] [--dry-run]
//
// --claude  claude plugin marketplace add <repo> + claude plugin install (user scope)
// --codex   user-level Codex hooks, the clean-worktrees skill and an AGENTS.md rule,
//           all pointing at THIS checkout's scripts/janitor.mjs
//
// Everything the installer writes is marked, so --uninstall removes exactly
// that and nothing else. Codex locations: $CODEX_HOME (default ~/.codex) for
// hooks and AGENTS.md, ~/.agents/skills for the skill.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwd = (p) => p.split(path.sep).join('/');
const JANITOR = fwd(path.join(REPO_ROOT, 'scripts', 'janitor.mjs'));
const INSTALLER = fwd(path.join(REPO_ROOT, 'scripts', 'install.mjs'));

const CLAUDE_MARKETPLACE = 'worktree-janitor-marketplace';
const CLAUDE_PLUGIN = `worktree-janitor@${CLAUDE_MARKETPLACE}`;

const TOML_BEGIN = '# >>> worktree-janitor >>>';
const TOML_END = '# <<< worktree-janitor <<<';
const MD_BEGIN = '<!-- >>> worktree-janitor >>> -->';
const MD_END = '<!-- <<< worktree-janitor <<< -->';
const SKILL_NAME = 'clean-worktrees';
const SKILL_MARK = '<!-- installed by worktree-janitor (scripts/install.mjs); remove with --uninstall -->';
const BAK_SUFFIX = '.worktree-janitor.bak';
// Last line of our own config.toml content (see findBlock).
const TOML_OWN_END_RE = /--hook post-tool-use[^\r\n]*\r?\n[ \t]*timeout[ \t]*=[ \t]*30[ \t]*(?:\r?\n|$)/;
// Any worktree-janitor hook, from this checkout or another one.
const OWN_HOOK_RE = /janitor\.mjs['"]?\s+--hook\s+(?:session-start|post-tool-use)\b/;

const HELP = `worktree-janitor installer

  node scripts/install.mjs [--claude] [--codex] [--all] [--uninstall] [--dry-run]

  --claude     Claude Code plugin (user scope), via the claude CLI
  --codex      Codex CLI: hooks in $CODEX_HOME (hooks.json if it exists, else a
               marked block in config.toml), skill in ~/.agents/skills/${SKILL_NAME},
               rule in $CODEX_HOME/AGENTS.md
  --all        both
  --uninstall  remove what this installer added (nothing else)
  --dry-run    print the planned changes, change nothing
`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = { claude: false, codex: false, uninstall: false, dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--claude') o.claude = true;
    else if (a === '--codex') o.codex = true;
    else if (a === '--all') o.claude = o.codex = true;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

// ---------------------------------------------------------------- output

const log = (s = '') => process.stdout.write(s + '\n');

// ---------------------------------------------------------------- quoting

// Quote one argument for the shell Codex runs a hook command in:
// powershell.exe -NoProfile -Command on Windows (verified, Codex 0.172), a
// POSIX sh elsewhere. Double quotes read well and also work in cmd.exe; use
// them unless the path holds a character that is special inside them, and
// fall back to single quotes (literal in both PowerShell and sh).
export function shellQuote(s, win = IS_WIN) {
  if (win) {
    if (!/[$`"\u2018-\u201f]/.test(s)) return `"${s}"`;
    return `'${s.replace(/['\u2018-\u201b]/g, (q) => q + q)}'`;
  }
  if (!/[$`"\\!]/.test(s)) return `"${s}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const hookCommand = (kind, janitor = JANITOR, win = IS_WIN) => `node ${shellQuote(janitor, win)} --hook ${kind}`;

// TOML basic string. JSON escapes are a subset of TOML basic-string escapes.
const tomlString = (s) => JSON.stringify(s);

// ---------------------------------------------------------------- file helpers

const readOrNull = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const eolOf = (text) => (text && text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (text, eol) => text.replace(/\r?\n/g, eol);
const sameIgnoringTrailing = (a, b) => a.replace(/\s+$/, '') === b.replace(/\s+$/, '');

class Plan {
  constructor(dryRun) {
    this.dryRun = dryRun;
    this.changes = 0;
  }

  // Write `next` to `file` (null = delete). Keeps a one-time backup of the
  // pre-install bytes next to the file when `backup` is set.
  write(file, before, next, { backup = false, what = '' } = {}) {
    if (before === next) return false;
    this.changes++;
    const verb = next === null ? 'delete' : before === null ? 'create' : 'update';
    log(`  ${this.dryRun ? 'would ' : ''}${verb} ${file}${what ? `  (${what})` : ''}`);
    if (this.dryRun) return true;
    if (backup && before !== null && !fs.existsSync(file + BAK_SUFFIX)) fs.writeFileSync(file + BAK_SUFFIX, before);
    if (next === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next);
    }
    return true;
  }

  remove(file, what = '') {
    if (!fs.existsSync(file)) return;
    this.changes++;
    log(`  ${this.dryRun ? 'would ' : ''}delete ${file}${what ? `  (${what})` : ''}`);
    if (!this.dryRun) fs.rmSync(file, { force: true });
  }

  rmdirIfEmpty(dir) {
    try {
      if (fs.readdirSync(dir).length) return;
    } catch {
      return;
    }
    log(`  ${this.dryRun ? 'would ' : ''}remove empty directory ${dir}`);
    if (!this.dryRun) fs.rmdirSync(dir);
  }
}

// After removing our part of a file, prefer the exact pre-install bytes when
// nothing else changed meanwhile; the backup is ours, so it goes either way.
// A file that did not exist before (no backup) and is empty once our part is
// gone was created by the installer: delete it.
function restoredText(file, stripped) {
  const bak = readOrNull(file + BAK_SUFFIX);
  if (bak !== null) return sameIgnoringTrailing(stripped, bak) ? bak : stripped;
  return stripped === '' ? null : stripped;
}

// ---------------------------------------------------------------- marked blocks

// Locate a marked block. `ownEnd` (a RegExp) marks where our own content
// ends inside it. Codex's config writer inserts new tables (hook trust,
// [hooks.state]) in front of the end-marker comment, which TOML treats as
// trailing decoration, so whatever sits between our last line and the end
// marker is not ours: it is kept on replace and on removal.
function findBlock(text, begin, end, ownEnd) {
  const i = text.indexOf(begin);
  if (i < 0) return null;
  const j = text.indexOf(end, i);
  if (j < 0) throw new Error(`found "${begin}" without "${end}"; fix the file by hand`);
  let k = j;
  if (ownEnd) {
    const m = ownEnd.exec(text.slice(i, j));
    if (!m) throw new Error('the worktree-janitor block was edited by hand; fix or remove it by hand');
    k = i + m.index + m[0].length;
  }
  let after = j + end.length;
  if (text.startsWith('\r\n', after)) after += 2;
  else if (text[after] === '\n') after += 1;
  return { start: i, ownEnd: k, endStart: j, after };
}

function stripBlock(text, begin, end, ownEnd = null) {
  if (text === null) return null;
  const blk = findBlock(text, begin, end, ownEnd);
  if (!blk) return text;
  let a = blk.start;
  // Also drop the blank line the installer put in front of the block.
  if (text.slice(0, a).endsWith('\r\n\r\n')) a -= 2;
  else if (text.slice(0, a).endsWith('\n\n')) a -= 1;
  return text.slice(0, a) + text.slice(blk.ownEnd, blk.endStart) + text.slice(blk.after);
}

// Put `block` (lines without EOLs) between markers: our part replaced in
// place if the markers exist (foreign lines before the end marker kept),
// else appended after one blank line.
function upsertBlock(text, block, begin, end, ownEnd = null) {
  const base = text || '';
  const eol = eolOf(base);
  const own = [begin, ...block].join(eol) + eol;
  const blk = findBlock(base, begin, end, ownEnd);
  if (blk) return base.slice(0, blk.start) + own + base.slice(blk.ownEnd);
  const body = own + end + eol;
  if (base === '') return body;
  return base + (base.endsWith('\n') ? eol : eol + eol) + body;
}

// ---------------------------------------------------------------- codex

function codexPaths(env = process.env) {
  const home = os.homedir();
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  return {
    home,
    codexHome,
    config: path.join(codexHome, 'config.toml'),
    hooksJson: path.join(codexHome, 'hooks.json'),
    agentsMd: path.join(codexHome, 'AGENTS.md'),
    skillDir: path.join(home, '.agents', 'skills', SKILL_NAME),
  };
}

export function codexHooksObject(janitor = JANITOR, win = IS_WIN) {
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('session-start', janitor, win), timeout: 30 }] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('post-tool-use', janitor, win), timeout: 30 }] }],
  };
}

export function codexTomlBlock(janitor = JANITOR, win = IS_WIN, installer = INSTALLER) {
  const h = codexHooksObject(janitor, win);
  return [
    `# Added by worktree-janitor. Remove with: node ${shellQuote(installer, win)} --codex --uninstall`,
    '[[hooks.SessionStart]]',
    '',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    `command = ${tomlString(h.SessionStart[0].hooks[0].command)}`,
    'timeout = 30',
    '',
    '[[hooks.PostToolUse]]',
    'matcher = "Bash"',
    '',
    '[[hooks.PostToolUse.hooks]]',
    'type = "command"',
    `command = ${tomlString(h.PostToolUse[0].hooks[0].command)}`,
    'timeout = 30',
  ];
}

// A config.toml that defines SessionStart / PostToolUse as a static array
// (`SessionStart = [...]`, `hooks = { ... }`) cannot take another
// [[hooks.X]] table: that would make the whole file invalid TOML.
function tomlHasStaticHooks(text) {
  return /^[ \t]*(?:hooks[ \t]*\.[ \t]*)?["']?(?:SessionStart|PostToolUse)["']?[ \t]*=/m.test(text) || /^[ \t]*hooks[ \t]*=/m.test(text);
}

const isOwnGroup = (g) => !!(g && Array.isArray(g.hooks) && g.hooks.length > 0 && g.hooks.every((h) => h && typeof h.command === 'string' && OWN_HOOK_RE.test(h.command)));

function stripOwnJsonHooks(obj) {
  const hooks = obj && typeof obj === 'object' && obj.hooks && typeof obj.hooks === 'object' ? obj.hooks : null;
  if (!hooks) return obj;
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev].filter((g) => !isOwnGroup(g));
    if (!hooks[ev].length) delete hooks[ev];
  }
  return obj;
}

function parseJsonOrThrow(text, file) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); not touching it`);
  }
}

function codexHooks(plan, p, uninstall) {
  // Which representation: Codex loads hooks.json AND inline [hooks] from
  // config.toml (merged), but warns on every session when one layer uses
  // both. So keep to the one the user already has: hooks.json if it exists,
  // else config.toml.
  const jsonText = readOrNull(p.hooksJson);
  const tomlText = readOrNull(p.config);

  // config.toml: remove our block on uninstall, and also on install when
  // hooks.json is the chosen representation (a block left from earlier).
  if (tomlText !== null && tomlText.includes(TOML_BEGIN) && (uninstall || jsonText !== null)) {
    plan.write(p.config, tomlText, restoredText(p.config, stripBlock(tomlText, TOML_BEGIN, TOML_END, TOML_OWN_END_RE)), { what: 'remove worktree-janitor hooks block' });
    plan.remove(p.config + BAK_SUFFIX, 'installer backup');
  }

  if (jsonText !== null) {
    const obj = parseJsonOrThrow(jsonText, p.hooksJson);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${p.hooksJson}: expected a JSON object; not touching it`);
    if (uninstall) {
      const before = JSON.stringify(obj);
      stripOwnJsonHooks(obj);
      if (JSON.stringify(obj) === before) return;
      const bak = readOrNull(p.hooksJson + BAK_SUFFIX);
      let next = JSON.stringify(obj, null, 2) + '\n';
      if (bak !== null) {
        try {
          if (JSON.stringify(JSON.parse(bak.replace(/^\uFEFF/, ''))) === JSON.stringify(obj)) next = bak;
        } catch {
          /* keep next */
        }
      }
      plan.write(p.hooksJson, jsonText, withEol(next, eolOf(jsonText)), { what: 'remove worktree-janitor hooks' });
      plan.remove(p.hooksJson + BAK_SUFFIX, 'installer backup');
      return;
    }
    if (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks)) obj.hooks = {};
    // Codex trust keys are positional (<file>:<event>:<group>:<handler>), so
    // never move a group: replace ours in place, or append it.
    for (const [ev, [group]] of Object.entries(codexHooksObject())) {
      if (!Array.isArray(obj.hooks[ev])) obj.hooks[ev] = [];
      const list = obj.hooks[ev];
      const own = list.map((g, i) => (isOwnGroup(g) ? i : -1)).filter((i) => i >= 0);
      if (!own.length) list.push(group);
      else {
        list[own[0]] = group;
        for (const i of own.slice(1).reverse()) list.splice(i, 1);
      }
    }
    const next = withEol(JSON.stringify(obj, null, 2) + '\n', eolOf(jsonText));
    // Unchanged content means unchanged trust: do not rewrite an identical file.
    if (sameJson(jsonText, next)) return log(`  ok ${p.hooksJson}  (hooks already installed)`);
    plan.write(p.hooksJson, jsonText, next, { backup: true, what: 'add worktree-janitor hooks' });
    return;
  }

  if (uninstall) return;
  if (tomlText !== null && tomlHasStaticHooks(stripBlock(tomlText, TOML_BEGIN, TOML_END, TOML_OWN_END_RE))) {
    throw new Error(`${p.config} defines hooks as a static array; adding [[hooks.*]] tables would break it. Add the hooks by hand (integrations/codex/).`);
  }
  const next = upsertBlock(tomlText, codexTomlBlock(), TOML_BEGIN, TOML_END, TOML_OWN_END_RE);
  if (next === tomlText) return log(`  ok ${p.config}  (hooks already installed)`);
  plan.write(p.config, tomlText, next, { backup: true, what: 'worktree-janitor hooks block' });
}

const sameJson = (a, b) => {
  try {
    return JSON.stringify(JSON.parse(a.replace(/^\uFEFF/, ''))) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
};

export function codexSkillText(janitor = JANITOR, win = IS_WIN) {
  const cmd = `node ${shellQuote(janitor, win)}`;
  return [
    '---',
    `name: ${SKILL_NAME}`,
    'description: Dry-run, then (after confirmation) remove merged git worktrees and merged local branches in the current repository.',
    '---',
    SKILL_MARK,
    '',
    `# ${SKILL_NAME}`,
    '',
    'Clean up merged git worktrees and local branches in the current repository.',
    '',
    '1. Run a dry run (changes nothing) and show the user the full report:',
    '',
    '   ```',
    `   ${cmd}`,
    '   ```',
    '',
    '2. If the report lists nothing to remove, say so and stop.',
    '3. Otherwise summarize what would be removed (worktrees and branches) and ask the user to confirm. Do not continue without an explicit yes.',
    '4. Only after confirmation, run:',
    '',
    '   ```',
    `   ${cmd} --apply`,
    '   ```',
    '',
    '   Show its output. Worktrees that are locked are skipped unless the user explicitly asks to include them, in which case add `--include-locked`.',
    '5. Optional arguments from the user: `--repo <path>` to target another repository, `--base <branch>` to choose the base branch.',
    '',
    'Never pass `--apply` before the user has seen the dry-run report and confirmed.',
    '',
  ].join('\n');
}

const OPENAI_YAML = 'policy:\n  allow_implicit_invocation: false\n';

function codexSkill(plan, p, uninstall) {
  const skillMd = path.join(p.skillDir, 'SKILL.md');
  const yaml = path.join(p.skillDir, 'agents', 'openai.yaml');
  const current = readOrNull(skillMd);
  const ours = current !== null && current.includes(SKILL_MARK);
  if (uninstall) {
    if (!ours) return;
    plan.remove(skillMd, 'skill');
    if (readOrNull(yaml) === OPENAI_YAML) plan.remove(yaml, 'skill policy');
    plan.rmdirIfEmpty(path.join(p.skillDir, 'agents'));
    plan.rmdirIfEmpty(p.skillDir);
    return;
  }
  if (current !== null && !ours) throw new Error(`${skillMd} exists and was not installed by worktree-janitor; not overwriting it`);
  const yamlNow = readOrNull(yaml);
  if (yamlNow !== null && yamlNow !== OPENAI_YAML && !ours) throw new Error(`${yaml} exists and is not ours; not overwriting it`);
  const text = codexSkillText();
  if (current === text && yamlNow === OPENAI_YAML) return log(`  ok ${skillMd}  (skill already installed)`);
  plan.write(skillMd, current, text, { what: `skill $${SKILL_NAME}` });
  plan.write(yaml, yamlNow, OPENAI_YAML, { what: 'explicit invocation only' });
}

export function agentsRule(janitor = JANITOR, win = IS_WIN) {
  const cmd = `node ${shellQuote(janitor, win)}`;
  return [
    '## Git worktrees (worktree-janitor)',
    '',
    'Never run `git worktree remove` (or delete a worktree directory) directly. On Windows it',
    'recurses through NTFS junctions such as a `node_modules` link and deletes their targets.',
    `Use worktree-janitor instead: \`${cmd}\` for a dry run, then the same command with`,
    '`--apply` after the user confirms, or the `$clean-worktrees` skill.',
  ];
}

function codexAgents(plan, p, uninstall) {
  const text = readOrNull(p.agentsMd);
  if (uninstall) {
    if (text === null || !text.includes(MD_BEGIN)) return;
    plan.write(p.agentsMd, text, restoredText(p.agentsMd, stripBlock(text, MD_BEGIN, MD_END)), { what: 'remove worktree-janitor rule' });
    plan.remove(p.agentsMd + BAK_SUFFIX, 'installer backup');
    return;
  }
  const next = upsertBlock(text, agentsRule(), MD_BEGIN, MD_END);
  if (next === text) return log(`  ok ${p.agentsMd}  (rule already present)`);
  plan.write(p.agentsMd, text, next, { backup: true, what: 'worktree-janitor rule' });
}

function installCodex(plan, uninstall) {
  const p = codexPaths();
  log(`Codex (${uninstall ? 'uninstall' : 'install'}): CODEX_HOME=${p.codexHome}`);
  if (!uninstall && !fs.existsSync(path.join(REPO_ROOT, 'scripts', 'janitor.mjs'))) throw new Error(`janitor not found at ${JANITOR}`);
  codexHooks(plan, p, uninstall);
  codexSkill(plan, p, uninstall);
  codexAgents(plan, p, uninstall);
  if (uninstall) return;
  const cfg = readOrNull(p.config) || '';
  if (/^\[plugins\.["']?worktree-janitor@/m.test(cfg)) {
    log('  warning: the worktree-janitor Codex plugin is also enabled in config.toml; its hooks would run twice. Use one or the other.');
  }
  log('');
  log('  Next steps for Codex:');
  log('  - Start Codex and trust the two worktree-janitor hooks (Codex asks at startup, or open /hooks).');
  log('    Untrusted hooks do not run; `codex exec` skips them silently. A changed hook (e.g. after');
  log('    re-installing from a different checkout path) needs trusting again.');
  log(`  - The skill is invoked explicitly: $${SKILL_NAME}`);
}

// ---------------------------------------------------------------- claude

// The claude executable: JANITOR_CLAUDE (tests), else found on PATH. On
// Windows an npm install is claude.cmd, which only runs through a shell.
function claudeCommand() {
  const override = process.env.JANITOR_CLAUDE;
  if (override) return /\.(c|m)?js$/i.test(override) ? { cmd: process.execPath, pre: [override], shell: false } : { cmd: override, pre: [], shell: false };
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, 'claude' + ext.toLowerCase());
      try {
        if (!fs.statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      return { cmd: p, pre: [], shell: IS_WIN && /\.(cmd|bat)$/i.test(p) };
    }
  }
  return null;
}

// Quote one argument for cmd.exe when it holds whitespace, a metacharacter or
// a double quote (embedded quotes are doubled). Plain arguments pass through.
export const cmdQuote = (x) => (/[\s"&|<>^()%!]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);

function runClaude(args) {
  const c = claudeCommand();
  if (!c) return { missing: true };
  const q = cmdQuote;
  const argv = [...c.pre, ...args];
  const r = spawnSync(c.shell ? q(c.cmd) : c.cmd, c.shell ? argv.map(q) : argv, { encoding: 'utf8', windowsHide: true, timeout: 120_000, shell: c.shell });
  if (r.error && r.error.code === 'ENOENT') return { missing: true };
  return { ok: !r.error && r.status === 0, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? String(r.error.message) : '') };
}

function claudeJson(args) {
  const r = runClaude(args);
  if (r.missing) return { missing: true };
  if (!r.ok) throw new Error(`claude ${args.join(' ')} failed: ${r.stderr.trim().split(/\r?\n/)[0] || 'unknown error'}`);
  try {
    return { data: JSON.parse(r.stdout) };
  } catch {
    throw new Error(`claude ${args.join(' ')}: unexpected output`);
  }
}

const samePathLoose = (a, b) => {
  const n = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
  return !!a && !!b && n(a) === n(b);
};

function installClaude(plan, uninstall) {
  log(`Claude Code (${uninstall ? 'uninstall' : 'install'}):`);
  const markets = claudeJson(['plugin', 'marketplace', 'list', '--json']);
  if (markets.missing) {
    log('  skipped: `claude` is not on PATH');
    return;
  }
  const market = (Array.isArray(markets.data) ? markets.data : []).find((m) => m && m.name === CLAUDE_MARKETPLACE);
  const plugins = claudeJson(['plugin', 'list', '--json']).data;
  const plugin = (Array.isArray(plugins) ? plugins : []).find((x) => x && x.id === CLAUDE_PLUGIN && (!x.scope || x.scope === 'user'));
  const marketHere = market && (samePathLoose(market.path, REPO_ROOT) || samePathLoose(market.installLocation, REPO_ROOT));

  const step = (args, what) => {
    plan.changes++;
    log(`  ${plan.dryRun ? 'would run' : 'run'}: claude ${args.join(' ')}  (${what})`);
    if (plan.dryRun) return;
    const r = runClaude(args);
    if (!r.ok) throw new Error(`claude ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] || 'unknown error'}`);
  };

  if (uninstall) {
    if (plugin) step(['plugin', 'uninstall', CLAUDE_PLUGIN, '--scope', 'user'], 'remove plugin');
    else log(`  ok: ${CLAUDE_PLUGIN} not installed`);
    if (market && marketHere) step(['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE], 'remove marketplace');
    else if (market) log(`  kept marketplace ${CLAUDE_MARKETPLACE}: it points at ${market.path || market.installLocation}, not this checkout`);
    return;
  }
  if (market && !marketHere) {
    throw new Error(`marketplace ${CLAUDE_MARKETPLACE} already points at ${market.path || market.installLocation}; run --claude --uninstall from that checkout first`);
  }
  if (!market) step(['plugin', 'marketplace', 'add', REPO_ROOT], 'add local marketplace');
  else log(`  ok: marketplace ${CLAUDE_MARKETPLACE} -> ${REPO_ROOT}`);
  if (!plugin) step(['plugin', 'install', CLAUDE_PLUGIN, '--scope', 'user'], 'install plugin');
  else log(`  ok: ${CLAUDE_PLUGIN} installed (user scope)`);
}

// ---------------------------------------------------------------- main

function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`install: ${e.message}\n${HELP}`);
    return 2;
  }
  if (o.help || (!o.claude && !o.codex)) {
    process.stdout.write(HELP);
    return o.help ? 0 : 2;
  }
  const plan = new Plan(o.dryRun);
  let failed = false;
  for (const [on, fn] of [
    [o.claude, installClaude],
    [o.codex, installCodex],
  ]) {
    if (!on) continue;
    try {
      fn(plan, o.uninstall);
    } catch (e) {
      failed = true;
      process.stderr.write(`  error: ${e.message}\n`);
    }
  }
  if (o.dryRun) log(`\nDry run: ${plan.changes} change(s) planned, nothing written.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

// Static checks of the Codex plugin manifest and its marketplace entry.
// Run: node --test test/codex-plugin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHooksObject } from '../scripts/install.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(REPO, ...p), 'utf8'));

test('Codex plugin: inline hooks run janitor.mjs from ${PLUGIN_ROOT}; skills point at the Codex skill', () => {
  const plugin = readJson('.codex-plugin', 'plugin.json');
  assert.equal(plugin.name, 'worktree-janitor');
  assert.equal(plugin.version, readJson('.claude-plugin', 'plugin.json').version, 'same version as the Claude plugin');
  // Inline hooks are required: without them Codex loads hooks/hooks.json,
  // the Claude Code file, and ignores its "args" (it would run bare `node`).
  const hooks = plugin.hooks && plugin.hooks.hooks;
  assert.ok(hooks, 'hooks declared inline');
  // The same node fallback chain the installer writes (no recorded node: a
  // plugin is installed without running our code), command for macOS/Linux,
  // commandWindows for PowerShell, janitor path from ${PLUGIN_ROOT}.
  assert.deepEqual(hooks, codexHooksObject('${PLUGIN_ROOT}/scripts/janitor.mjs', null));
  const skill = fs.readFileSync(path.join(REPO, plugin.skills, 'clean-worktrees', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: clean-worktrees\ndescription: [^\n]+\n---\n/);
  const skillDir = path.join(REPO, plugin.skills, 'clean-worktrees');
  assert.ok(fs.existsSync(path.resolve(skillDir, '../../../../scripts/janitor.mjs')), 'relative path in SKILL.md resolves');
  assert.equal(fs.readFileSync(path.join(skillDir, 'agents', 'openai.yaml'), 'utf8'), 'policy:\n  allow_implicit_invocation: false\n');
});

test('Codex marketplace: one local plugin at the repository root', () => {
  const m = readJson('.agents', 'plugins', 'marketplace.json');
  assert.equal(m.name, 'worktree-janitor-marketplace');
  assert.deepEqual(m.plugins.map((p) => [p.name, p.source]), [['worktree-janitor', { source: 'local', path: './' }]]);
});

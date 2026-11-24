// Release assets (scripts/build-release.mjs) and the formula updater.
// Run: node --test test/release.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { build, isRuntimePath, manifestVersion } from '../scripts/build-release.mjs';
import { setUrlAndSha } from '../scripts/update-formula.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-release-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
// The build reads `git ls-files`. Old git (Debian 11's 2.30) in a container
// refuses a checkout owned by another uid and ignores -c safe.directory.
const gitOk = spawnSync('git', ['-c', `safe.directory=${REPO}`, 'ls-files'], { cwd: REPO }).status === 0;
const skip = gitOk ? false : 'git refuses this checkout (dubious ownership); the release build runs on a normal checkout';

// Names in a ustar archive, read back with our own minimal parser.
function tarNames(buf) {
  const names = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, n) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const name = (str(345, 155) ? str(345, 155) + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 12), 8);
    names.push({ name, mode: parseInt(str(100, 8), 8), mtime: parseInt(str(136, 12), 8), type: str(156, 1) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

test('build: archives hold only runtime files under one top-level directory, reproducibly', { skip }, () => {
  const version = manifestVersion();
  const a = build({ out: path.join(ROOT, 'a'), mtime: 1700000000 });
  const b = build({ out: path.join(ROOT, 'b'), mtime: 1700000000 });
  assert.equal(a.version, version);
  assert.deepEqual(a.assets.map((x) => x.name), [`worktree-janitor-${version}.tar.gz`, `worktree-janitor-${version}.zip`, 'install.sh', 'install.ps1']);
  assert.deepEqual(a.assets, b.assets, 'two builds are byte-identical');

  const sums = fs.readFileSync(path.join(a.out, 'SHA256SUMS'), 'utf8');
  for (const x of a.assets) assert.ok(sums.includes(`${sha(path.join(a.out, x.name))}  ${x.name}\n`), x.name);

  const tgz = fs.readFileSync(path.join(a.out, a.assets[0].name));
  assert.equal(tgz.readUInt32LE(4), 0, 'gzip mtime 0');
  const entries = tarNames(zlib.gunzipSync(tgz));
  const top = `worktree-janitor-${version}/`;
  assert.ok(entries.every((e) => e.name.startsWith(top)), 'one top-level directory');
  assert.ok(entries.every((e) => e.mtime === 1700000000), 'fixed mtime');
  const files = entries.filter((e) => e.type === '0').map((e) => e.name.slice(top.length));
  assert.deepEqual(files, [...files].sort(), 'sorted');
  for (const f of ['scripts/janitor.mjs', 'scripts/install.mjs', 'hooks/hooks.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json', 'skills/clean-worktrees/SKILL.md', 'LICENSE', 'package.json', 'CHANGELOG.md']) {
    assert.ok(files.includes(f), `${f} shipped`);
  }
  assert.ok(files.every(isRuntimePath), 'nothing but runtime files');
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('.github/') || f.startsWith('Formula/')), 'no tests, CI or formula');
  assert.ok(entries.filter((e) => e.type === '0').every((e) => e.mode === 0o644 || e.mode === 0o755));
  assert.equal(entries.find((e) => e.name === `${top}scripts/janitor.mjs`).mode, 0o755, 'shebang scripts executable');

  // The system tar (GNU tar, bsdtar, Windows tar.exe) agrees.
  const t = spawnSync('tar', ['-tzf', path.join(a.out, a.assets[0].name)], { encoding: 'utf8' });
  if (t.status === 0) assert.ok(t.stdout.includes(`${top}scripts/janitor.mjs`));
});

test('build: refuses a version that does not match the manifests', { skip }, () => {
  assert.throws(() => build({ out: path.join(ROOT, 'c'), version: 'v9.9.9' }), /does not match the manifests/);
  assert.throws(() => build({ out: path.join(ROOT, 'c'), version: 'latest' }), /must look like/);
});

test('zip extracts with the system tool to the same files as the tarball', { skip }, () => {
  const out = path.join(ROOT, 'z');
  const r = build({ out, mtime: 1700000000 });
  const x = path.join(ROOT, 'zx');
  fs.mkdirSync(x);
  const t = spawnSync('tar', ['-xf', path.join(out, r.assets[1].name), '-C', x], { encoding: 'utf8' });
  if (t.status !== 0) return; // GNU tar cannot read zip; bsdtar (macOS, Windows) can
  const j = path.join(x, `worktree-janitor-${r.version}`, 'scripts', 'janitor.mjs');
  assert.equal(fs.readFileSync(j, 'utf8'), fs.readFileSync(path.join(REPO, 'scripts', 'janitor.mjs'), 'utf8'));
});

test('update-formula: replaces url and sha256, rejects bad input', () => {
  const rb = fs.readFileSync(path.join(REPO, 'Formula', 'worktree-janitor.rb'), 'utf8');
  const next = setUrlAndSha(rb, 'file:///tmp/w.tar.gz', 'a'.repeat(64));
  assert.match(next, /^ {2}url "file:\/\/\/tmp\/w\.tar\.gz"$/m);
  assert.match(next, new RegExp(`^ {2}sha256 "${'a'.repeat(64)}"$`, 'm'));
  assert.equal(next.split('\n').length, rb.split('\n').length);
  assert.throws(() => setUrlAndSha(rb, 'x', 'nope'), /not a sha256/);
  assert.throws(() => setUrlAndSha(rb, 'a"b', 'a'.repeat(64)), /unexpected character/);
  assert.match(rb, new RegExp(`releases/download/${manifestVersion()}/worktree-janitor-${manifestVersion()}\\.tar\\.gz"`), 'formula points at this version');
});

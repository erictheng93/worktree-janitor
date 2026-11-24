#!/usr/bin/env node
// @ts-check
// Build the release assets for one version, Node >= 18 stdlib only:
//
//   node scripts/build-release.mjs [--version vX.Y.Z] [--out dist]
//
// Writes to <out>:
//   worktree-janitor-vX.Y.Z.tar.gz   top-level directory worktree-janitor-vX.Y.Z/
//   worktree-janitor-vX.Y.Z.zip      same tree
//   install.sh, install.ps1          the installers, as they are in this commit
//   SHA256SUMS                       sha256 of every file above (sha256sum format)
//
// The archives hold only the runtime files (RUNTIME below), taken from
// `git ls-files`, so untracked or ignored files never ship. Entries are
// sorted, every mtime is SOURCE_DATE_EPOCH (default: the commit time of
// HEAD), owner/group are 0/"", modes are 0644 (0755 for files starting with
// "#!"). Text is archived exactly as checked out (LF, see .gitattributes).
// The same tree therefore gives byte-identical tarballs; the gzip and zip
// deflate streams are identical for a given Node.js (zlib) build, which is
// why the release workflow pins its Node version.
//
// --version must match the "version" in package.json and both plugin
// manifests (it defaults to them), so a tag can never ship other manifests.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NAME = 'worktree-janitor';

/** Paths (directories end in "/") that make up the runtime tree. */
export const RUNTIME = ['scripts/', 'hooks/', 'skills/', '.claude-plugin/', '.codex-plugin/', '.agents/', 'integrations/', 'docs/', 'LICENSE', 'CHANGELOG.md', 'package.json'];
/** Files at the root matching this are shipped too (README.md, README.zh-TW.md, ...). */
const README_RE = /^README[^/]*$/;
/** Installers published next to the archives. */
export const INSTALLERS = ['install.sh', 'install.ps1'];

/**
 * @typedef {{ name: string, data: Buffer, mode: number }} Entry
 */

/** @param {string[]} args */
function git(args) {
  // safe.directory: a checkout owned by another user (CI containers) is
  // still ours to read.
  const r = spawnSync('git', ['-c', `safe.directory=${REPO}`, ...args], { cwd: REPO, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ? r.stderr.toString().trim() : r.error}`);
  return r.stdout.toString('utf8');
}

/** @param {string} p */
export const isRuntimePath = (p) => README_RE.test(p) || RUNTIME.some((r) => (r.endsWith('/') ? p.startsWith(r) : p === r));

/**
 * The runtime files of the current checkout, sorted by path.
 * @returns {string[]}
 */
export function runtimeFiles() {
  return git(['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter(isRuntimePath)
    .filter((p) => fs.existsSync(path.join(REPO, p)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** @param {string} file */
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));

/** @returns {string} the version every manifest agrees on, as vX.Y.Z */
export function manifestVersion() {
  const files = ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
  const versions = files.map((f) => String(readJson(f).version));
  if (new Set(versions).size !== 1) throw new Error(`manifest versions differ: ${files.map((f, i) => `${f}=${versions[i]}`).join(', ')}`);
  return `v${versions[0]}`;
}

// ---------------------------------------------------------------- tar (ustar)

/**
 * @param {Buffer} buf
 * @param {number} off
 * @param {number} len
 * @param {number} value
 */
function octal(buf, off, len, value) {
  buf.write(value.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii');
}

/**
 * One ustar header block. Names up to 255 bytes via the prefix field.
 * @param {string} name
 * @param {number} size
 * @param {number} mode
 * @param {number} mtime
 * @param {'0' | '5'} type
 */
function tarHeader(name, size, mode, mtime, type) {
  const h = Buffer.alloc(512);
  let base = name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (cut < 0 || Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long for ustar: ${name}`);
  }
  h.write(base, 0, 100, 'utf8');
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.fill(' ', 148, 156);
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/**
 * @param {string} root top-level directory name
 * @param {Entry[]} entries
 * @param {number} mtime
 */
export function tarBuffer(root, entries, mtime) {
  /** @type {Buffer[]} */
  const parts = [];
  const dirs = new Set([root + '/']);
  for (const e of entries) {
    const segs = e.name.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(`${root}/${segs.slice(0, i).join('/')}/`);
  }
  /** @type {{ name: string, entry?: Entry }[]} */
  const all = [...[...dirs].map((name) => ({ name })), ...entries.map((entry) => ({ name: `${root}/${entry.name}`, entry }))];
  all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { name, entry } of all) {
    if (!entry) {
      parts.push(tarHeader(name, 0, 0o755, mtime, '5'));
      continue;
    }
    parts.push(tarHeader(name, entry.data.length, entry.mode, mtime, '0'), entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/**
 * gzip with a fixed header: mtime 0, no name, OS byte 255 ("unknown"), so the
 * header does not depend on the build machine.
 * @param {Buffer} data
 */
export function gzipDeterministic(data) {
  const gz = zlib.gzipSync(data, { level: 9 });
  gz.writeUInt32LE(0, 4);
  gz[9] = 255;
  return gz;
}

// ---------------------------------------------------------------- zip

/** @type {number[] | null} */
let CRC_TABLE = null;
/** @param {Buffer} buf */
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE.push(c >>> 0);
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {number} epoch seconds, UTC; returns MS-DOS [time, date] */
function dosTime(epoch) {
  const d = new Date(Math.max(epoch, 315532800) * 1000); // DOS dates start in 1980
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return [time, date];
}

/**
 * Zip with Unix modes ("version made by" 3 = Unix), deflate, no extra fields.
 * @param {string} root
 * @param {Entry[]} entries
 * @param {number} mtime
 */
export function zipBuffer(root, entries, mtime) {
  const [time, date] = dosTime(mtime);
  /** @type {Buffer[]} */
  const local = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    const name = Buffer.from(`${root}/${e.name}`, 'utf8');
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

// ---------------------------------------------------------------- main

/** @param {Buffer} b */
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * @param {{ version?: string, out?: string, mtime?: number }} [opts]
 * @returns {{ version: string, out: string, assets: { name: string, sha256: string }[] }}
 */
export function build(opts = {}) {
  const want = manifestVersion();
  const version = opts.version || want;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`--version must look like v1.2.3, got ${version}`);
  if (version !== want) throw new Error(`--version ${version} does not match the manifests (${want}); bump package.json and both plugin.json files first`);
  const envEpoch = process.env.SOURCE_DATE_EPOCH;
  const mtime = opts.mtime ?? (envEpoch ? Number(envEpoch) : Number(git(['log', '-1', '--format=%ct']).trim()));
  if (!Number.isInteger(mtime) || mtime < 0) throw new Error(`bad SOURCE_DATE_EPOCH: ${envEpoch}`);
  const out = path.resolve(opts.out || path.join(REPO, 'dist'));
  fs.mkdirSync(out, { recursive: true });

  /** @type {Entry[]} */
  const entries = runtimeFiles().map((name) => {
    const data = fs.readFileSync(path.join(REPO, name));
    return { name, data, mode: data.subarray(0, 2).toString('latin1') === '#!' ? 0o755 : 0o644 };
  });
  const root = `${NAME}-${version}`;
  /** @type {[string, Buffer][]} */
  const files = [
    [`${root}.tar.gz`, gzipDeterministic(tarBuffer(root, entries, mtime))],
    [`${root}.zip`, zipBuffer(root, entries, mtime)],
    ...INSTALLERS.map((f) => /** @type {[string, Buffer]} */ ([f, fs.readFileSync(path.join(REPO, f))])),
  ];
  const assets = files.map(([name, data]) => {
    fs.writeFileSync(path.join(out, name), data);
    return { name, sha256: sha256(data) };
  });
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), assets.map((a) => `${a.sha256}  ${a.name}\n`).join(''));
  return { version, out, assets };
}

/** @param {string[]} argv */
function main(argv) {
  /** @type {{ version?: string, out?: string }} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' && i + 1 < argv.length) o.version = argv[++i];
    else if (a === '--out' && i + 1 < argv.length) o.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('node scripts/build-release.mjs [--version vX.Y.Z] [--out dist]\n');
      return 0;
    } else {
      process.stderr.write(`build-release: unknown or incomplete argument: ${a}\n`);
      return 2;
    }
  }
  try {
    const r = build(o);
    for (const a of r.assets) process.stdout.write(`${a.sha256}  ${path.join(r.out, a.name)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`build-release: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

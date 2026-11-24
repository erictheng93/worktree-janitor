#!/usr/bin/env node
// @ts-check
// Point Formula/worktree-janitor.rb at one release tarball:
//
//   node scripts/update-formula.mjs [--version vX.Y.Z] [--sums dist/SHA256SUMS]
//                                   [--url URL] [--out FILE]
//
// --version  default: the version in the manifests (as scripts/build-release.mjs)
// --sums     SHA256SUMS written by build-release.mjs; the tarball's sha256 is read from it
// --url      tarball URL (default: the GitHub release asset of --version);
//            CI passes a file:// URL to test a locally built tarball
// --out      where to write (default: Formula/worktree-janitor.rb in place)
//
// The release workflow runs this after publishing and opens a pull request
// with the result, so `brew install` from the tap gets the new version.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestVersion, NAME } from './build-release.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMULA = path.join(REPO, 'Formula', `${NAME}.rb`);
const OWNER_REPO = 'erictheng93/worktree-janitor';

/**
 * @param {string} text formula source
 * @param {string} url
 * @param {string} sha256
 * @returns {string}
 */
export function setUrlAndSha(text, url, sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  if (/["\\#]/.test(url)) throw new Error(`unexpected character in url: ${url}`);
  const urlRe = /^(  url ")[^"]*(")$/m;
  const shaRe = /^(  sha256 ")[0-9a-f]*(")$/m;
  if (!urlRe.test(text) || !shaRe.test(text)) throw new Error('formula has no top-level url/sha256 lines to update');
  return text.replace(urlRe, `$1${url}$2`).replace(shaRe, `$1${sha256}$2`);
}

/** @param {string[]} argv */
function main(argv) {
  /** @type {Record<string, string>} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(version|sums|url|out)$/.exec(a);
    if (m && i + 1 < argv.length) o[m[1]] = argv[++i];
    else {
      process.stderr.write(`update-formula: unknown or incomplete argument: ${a}\n`);
      return 2;
    }
  }
  try {
    const version = o.version || manifestVersion();
    const asset = `${NAME}-${version}.tar.gz`;
    const sums = fs.readFileSync(o.sums || path.join(REPO, 'dist', 'SHA256SUMS'), 'utf8');
    const line = sums.split(/\r?\n/).find((l) => l.endsWith(`  ${asset}`));
    if (!line) throw new Error(`no ${asset} in SHA256SUMS`);
    const url = o.url || `https://github.com/${OWNER_REPO}/releases/download/${version}/${asset}`;
    const out = o.out || FORMULA;
    const next = setUrlAndSha(fs.readFileSync(FORMULA, 'utf8'), url, line.split(' ')[0]);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, next);
    process.stdout.write(`${out}: ${url} ${line.split(' ')[0]}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`update-formula: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

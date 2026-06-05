#!/usr/bin/env node
// Single source of truth for the release version: package.json. The web app and
// the Pulldit Bridge extension share one version. This script propagates
// package.json's "version" into every file that hard-codes it, and verifies they
// agree in --check mode (wired into `npm run check`, so CI fails on drift).
//
//   node scripts/sync-version.mjs            # propagate package.json -> all targets
//   node scripts/sync-version.mjs 1.4.0      # set package.json to 1.4.0, then propagate
//   node scripts/sync-version.mjs --check    # verify everything matches (exit 1 on drift)
//
// Note: at runtime the extension still reads its own manifest.json
// (chrome.runtime.getManifest().version); this only keeps the shipped files in
// sync with package.json at release time.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+$/;
const V = String.raw`\d+\.\d+\.\d+`;

// Each target match exposes the version in group 2 (group 1 = prefix, group 3 =
// suffix). The same regex drives both replace (swap group 2) and check (read it).
const targets = [
  { file: 'src/config.js', re: new RegExp(`(version:\\s*')(${V})(')`, 'g') },        // APP + EXTENSION
  { file: 'extension/manifest.json', re: new RegExp(`("version":\\s*")(${V})(")`, 'g') },
  { file: 'index.html', re: new RegExp(`(<strong id="ext-latest">v)(${V})(</strong>)`, 'g') },
];

const PKG = root + 'package.json';
const PKG_RE = /("version":\s*")(\d+\.\d+\.\d+)(")/;

function pkgVersion() {
  const m = readFileSync(PKG, 'utf8').match(PKG_RE);
  if (!m) throw new Error('no semver "version" in package.json');
  return m[2];
}

function setPkgVersion(v) {
  const src = readFileSync(PKG, 'utf8');
  if (!PKG_RE.test(src)) throw new Error('no semver "version" in package.json');
  writeFileSync(PKG, src.replace(PKG_RE, `$1${v}$3`));
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const setArg = args.find((a) => SEMVER.test(a));
  if (setArg && !check) setPkgVersion(setArg);

  const version = pkgVersion();
  const problems = [];
  let changed = 0;

  for (const t of targets) {
    const path = root + t.file;
    const src = readFileSync(path, 'utf8');
    const found = [...src.matchAll(t.re)];
    if (found.length === 0) {
      problems.push(`${t.file}: no version token found`);
      continue;
    }
    if (check) {
      for (const m of found) if (m[2] !== version) problems.push(`${t.file}: ${m[2]} != ${version}`);
    } else {
      const out = src.replace(t.re, `$1${version}$3`);
      if (out !== src) {
        writeFileSync(path, out);
        changed++;
      }
    }
  }

  if (problems.length) {
    console.error((check ? 'version drift:' : 'version sync failed:') + '\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(check ? `version OK: all files at ${version}` : `version ${version} synced (${changed} file(s) updated)`);
}

main();

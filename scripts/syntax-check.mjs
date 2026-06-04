#!/usr/bin/env node
// Lightweight build gate: parse-check every JS file we ship (browser + node) for
// syntax errors WITHOUT executing it. `node --check` only parses, so files that
// reference browser globals (window, document, JSZip) are validated safely.
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = ['src', 'test', 'worker', 'scripts', 'extension'];
const ignore = new Set(['node_modules', '.git', 'vendor']);

/** @param {string} dir */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (ignore.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (['.js', '.mjs'].includes(extname(name))) {
      yield full;
    }
  }
}

const files = [];
for (const d of dirs) files.push(...walk(join(root, d)));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    process.stdout.write(`ok   ${file.slice(root.length)}\n`);
  } catch (err) {
    failed++;
    process.stderr.write(`FAIL ${file.slice(root.length)}\n${err.stderr?.toString() ?? err}\n`);
  }
}

process.stdout.write(`\nsyntax-check: ${files.length - failed}/${files.length} files ok\n`);
process.exit(failed === 0 ? 0 : 1);

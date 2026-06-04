#!/usr/bin/env python3
"""Bump the extension's patch version by +0.0.1 in extension/manifest.json.

manifest.json is the single source of truth — background.js and bridge.js read the version at
runtime via chrome.runtime.getManifest().version, so this is the only file that ever changes.
Run with `npm run bump:ext` whenever you change the extension.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "extension", "manifest.json")

src = open(MANIFEST, encoding="utf-8").read()
pat = re.compile(r'("version":\s*")(\d+)\.(\d+)\.(\d+)(")')
m = pat.search(src)
if not m:
    raise SystemExit("could not find a semver version in extension/manifest.json")

major, minor, patch = int(m.group(2)), int(m.group(3)), int(m.group(4))
new_version = f"{major}.{minor}.{patch + 1}"
src = src[: m.start()] + f'{m.group(1)}{new_version}{m.group(5)}' + src[m.end():]
open(MANIFEST, "w", encoding="utf-8", newline="\n").write(src)
print(f"extension version -> {new_version}")

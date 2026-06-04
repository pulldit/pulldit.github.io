#!/usr/bin/env python3
"""Package extension/ into pulldit-bridge.zip (manifest.json at the archive root).

Deterministic (sorted, fixed timestamps) so identical sources produce identical archives —
nice for reproducible releases. Used locally (`npm run pack:ext`) and by the deploy workflow.
The archive is store-ready (Chrome Web Store / Firefox AMO) and is also the file users download
from the site to "Load unpacked".
"""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extension")
OUT = os.path.join(ROOT, "pulldit-bridge.zip")
SKIP = {".DS_Store", "Thumbs.db"}
FIXED_DATE = (2026, 1, 1, 0, 0, 0)

files = []
for dirpath, _dirnames, filenames in os.walk(SRC):
    for name in filenames:
        if name in SKIP:
            continue
        full = os.path.join(dirpath, name)
        arc = os.path.relpath(full, SRC).replace(os.sep, "/")
        files.append((full, arc))
files.sort(key=lambda x: x[1])

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for full, arc in files:
        info = zipfile.ZipInfo(arc, date_time=FIXED_DATE)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        with open(full, "rb") as fh:
            z.writestr(info, fh.read())

print(f"packed {len(files)} files -> {os.path.relpath(OUT, ROOT)}")

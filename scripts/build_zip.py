"""Build vivimusic-firefox-ready-to-sign.zip from the repo root.

Zip entries always use forward slashes (AMO rejects backslash paths).
Usage: python scripts/build_zip.py
"""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'vivimusic-firefox-ready-to-sign.zip')
SKIP_DIRS = {'.git', '.github', '.claude', 'scripts', 'bitchrod extesnion'}
SKIP_FILES = {'vivimusic-firefox-ready-to-sign.zip', 'README_CUSTOM.md', '.gitignore'}

tmp = OUT + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, dirs, files in os.walk(ROOT):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for f in sorted(files):
            if f in SKIP_FILES or f.endswith('.tmp'):
                continue
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, ROOT).replace(os.sep, '/'))
os.replace(tmp, OUT)
print(OUT, os.path.getsize(OUT), 'bytes')

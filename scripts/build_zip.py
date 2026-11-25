"""Build the two release zips from the repo root:

  vivimusic-automix-firefox.zip      Firefox (upload to AMO to sign)
  vivimusic-automix-edge-chrome.zip  Edge and Chrome (load unpacked)

Same code in both. The Chromium manifest is derived from manifest.json:
service worker only, declarativeNetRequest instead of blocking webRequest,
no Firefox settings and no upstream extension key (so the ID never clashes
with upstream's store add-on).
Zip entries always use forward slashes (AMO rejects backslash paths).
Only the allowlisted files and folders below go in: the manifest loads only
src/ and icons/, the rest is the licence and the notices. Specs, scripts,
local caches and reports stay out even when they sit in the repo root.
Usage: python scripts/build_zip.py [--out-dir DIR]   (default: the repo root)
"""
import argparse
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP_FIREFOX = 'vivimusic-automix-firefox.zip'
ZIP_CHROMIUM = 'vivimusic-automix-edge-chrome.zip'
SHIP_FILES = ['manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'NOTICES-PLUS.md', 'readme.md']
SHIP_DIRS = ['src', 'icons']
SKIP_DIRS = {'__pycache__'}


def chromium_manifest(manifest):
    m = json.loads(json.dumps(manifest))
    m['background'] = {'service_worker': m['background']['service_worker']}
    perms = [p for p in m['permissions'] if p not in ('webRequest', 'webRequestBlocking')]
    if 'declarativeNetRequestWithHostAccess' not in perms:
        perms.append('declarativeNetRequestWithHostAccess')
    m['permissions'] = perms
    m.pop('browser_specific_settings', None)
    m.pop('key', None)
    m['minimum_chrome_version'] = '116'   # content scripts in the MAIN world, DNR tabIds
    return m


def files():
    for f in SHIP_FILES:
        p = os.path.join(ROOT, f)
        if not os.path.isfile(p):
            raise SystemExit(f'missing {f}')
        yield p, f
    for top in SHIP_DIRS:
        for d, dirs, names in os.walk(os.path.join(ROOT, top)):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            for f in sorted(names):
                if f.endswith(('.tmp', '.orig')):
                    continue
                p = os.path.join(d, f)
                yield p, os.path.relpath(p, ROOT).replace(os.sep, '/')


def build(out, manifest_text):
    tmp = out + '.tmp'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        for path, name in files():
            if name == 'manifest.json' and manifest_text is not None:
                z.writestr(name, manifest_text)
            else:
                z.write(path, name)
    os.replace(tmp, out)
    print(out, os.path.getsize(out), 'bytes')


ap = argparse.ArgumentParser()
ap.add_argument('--out-dir', default=ROOT, help='where the two zips go (default: the repo root)')
out_dir = ap.parse_args().out_dir
with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as fh:
    manifest = json.load(fh)
build(os.path.join(out_dir, ZIP_FIREFOX), None)
build(os.path.join(out_dir, ZIP_CHROMIUM),json.dumps(chromium_manifest(manifest), indent=2, ensure_ascii=False) + '\n')

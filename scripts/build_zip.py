"""Build the two release zips from the repo root:

  vivimusic-automix-firefox.zip      Firefox (upload to AMO to sign)
  vivimusic-automix-edge-chrome.zip  Edge and Chrome (load unpacked)

Same code in both. The Chromium manifest is derived from manifest.json:
service worker only, declarativeNetRequest instead of blocking webRequest,
no Firefox settings and no upstream extension key (so the ID never clashes
with upstream's store add-on).
Zip entries always use forward slashes (AMO rejects backslash paths).
Usage: python scripts/build_zip.py
"""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_FIREFOX = os.path.join(ROOT, 'vivimusic-automix-firefox.zip')
OUT_CHROMIUM = os.path.join(ROOT, 'vivimusic-automix-edge-chrome.zip')
SKIP_DIRS = {'.git', '.github', '.claude', 'scripts', 'upstream-amo', 'dist', 'bitchrod extesnion'}
SKIP_FILES = {os.path.basename(OUT_FIREFOX), os.path.basename(OUT_CHROMIUM),
              'README_CUSTOM.md', 'TESTING.md', '.gitignore'}


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
    for d, dirs, names in os.walk(ROOT):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for f in sorted(names):
            if f in SKIP_FILES or f.endswith('.tmp'):
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


with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as fh:
    manifest = json.load(fh)
build(OUT_FIREFOX, None)
build(OUT_CHROMIUM, json.dumps(chromium_manifest(manifest), indent=2, ensure_ascii=False) + '\n')

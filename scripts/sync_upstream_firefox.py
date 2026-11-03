"""Merge upstream's Firefox (AMO) build into this fork.

Upstream publishes two different things:
  * GitHub (Archimetrix/VIVIMUSIC_WEB): the Chrome source, tagged vX.Y.Z.
  * AMO (addons.mozilla.org/firefox/addon/vivimusicweb): a separate Firefox
    port of the same version, never pushed to GitHub.

For every file the AMO build ships, this does a 3-way merge:
    base   = upstream GitHub file at the matching tag
    theirs = the AMO file
    ours   = this working tree
so upstream's Firefox-only changes land on top of our changes. Files that
only exist in the AMO build are copied in when we don't have them yet.

manifest.json is never merged automatically. The AMO manifest we last synced
is kept in scripts/upstream-amo-manifest.json; when the new AMO manifest
differs from it, the difference is printed so it can be applied by hand, then
recorded with --accept-manifest.

Exit code 2 means something needs a human (conflict markers or new manifest
changes); the CI workflow fails on it.

Usage (from the repo root, with the upstream remote fetched):
    git fetch upstream --tags
    python scripts/sync_upstream_firefox.py            # dry run: report only
    python scripts/sync_upstream_firefox.py --apply    # write merged files
Options: --tag v10.1.2 (default: "v" + AMO version), --remote upstream,
         --accept-manifest (record the current AMO manifest as handled)
"""
import argparse
import difflib
import io
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AMO_API = 'https://addons.mozilla.org/api/v5/addons/addon/vivimusicweb/'
# Upstream's star-verification gate was removed from this fork on purpose.
SKIP = {'src/gate.js', 'src/gate.css', 'src/stargate.js', 'manifest.json'}
# Files where this fork deliberately differs from the AMO build: conflicting
# hunks keep our side (non-conflicting upstream changes still merge in).
# background.js: AMO drops the VIVI_NET_FETCH relay that net.js needs.
KEEP_OURS = {'src/background.js'}
AMO_MANIFEST_BASELINE = os.path.join(ROOT, 'scripts', 'upstream-amo-manifest.json')
TEXT_EXT = ('.js', '.css', '.html', '.json', '.md', '.txt')


def git(*args, check=True):
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True)
    if check and r.returncode not in (0, 1):
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.decode(errors='replace')}")
    return r


def lf(b):
    return b.replace(b'\r\n', b'\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='write merged files (default: dry run)')
    ap.add_argument('--tag', help='upstream git tag matching the AMO version')
    ap.add_argument('--remote', default='upstream')
    ap.add_argument('--accept-manifest', action='store_true', help='record the current AMO manifest as handled')
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')

    meta = json.load(urllib.request.urlopen(AMO_API))
    ver = meta['current_version']['version']
    url = meta['current_version']['file']['url']
    tag = a.tag or 'v' + ver
    print(f'AMO version {ver}, merging against {a.remote} tag {tag}')
    if git('rev-parse', '--verify', '--quiet', f'refs/tags/{tag}', check=False).returncode != 0:
        sys.exit(f'tag {tag} not found: run `git fetch {a.remote} --tags`, or pass --tag')

    xpi = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url).read()))
    conflicts, changed, added = [], [], []
    tmp = tempfile.mkdtemp(prefix='vivi-sync-')
    for name in sorted(xpi.namelist()):
        if name.endswith(('/', '.orig')) or name.startswith('META-INF/') or name in SKIP:
            continue
        theirs = xpi.read(name)
        local = os.path.join(ROOT, name)
        base_r = git('show', f'{tag}:{name}', check=False)
        if base_r.returncode != 0:            # file only exists in the AMO build
            if not os.path.exists(local):
                added.append(name)
                if a.apply:
                    os.makedirs(os.path.dirname(local), exist_ok=True)
                    open(local, 'wb').write(theirs)
            continue
        base = base_r.stdout
        if not name.endswith(TEXT_EXT):
            if theirs != base:
                print(f'  binary changed upstream (copy by hand if wanted): {name}')
            continue
        if lf(theirs) == lf(base) or not os.path.exists(local):
            continue
        ours = open(local, 'rb').read()
        crlf = b'\r\n' in ours
        paths = {}
        for k, data in (('ours', lf(ours)), ('base', lf(base)), ('theirs', lf(theirs))):
            paths[k] = os.path.join(tmp, k)
            open(paths[k], 'wb').write(data)
        favour = ['--ours'] if name in KEEP_OURS else []
        r = git('merge-file', *favour, '-L', 'ours', '-L', tag, '-L', f'amo-{ver}', paths['ours'], paths['base'], paths['theirs'], check=False)
        merged = open(paths['ours'], 'rb').read()
        if merged == lf(ours):
            continue
        (conflicts if r.returncode > 0 else changed).append(name)
        if a.apply:
            open(local, 'wb').write(merged.replace(b'\n', b'\r\n') if crlf else merged)

    # manifest: report what changed since the AMO manifest we last handled
    m_amo = xpi.read('manifest.json').decode()
    m_seen = open(AMO_MANIFEST_BASELINE, encoding='utf-8').read() if os.path.exists(AMO_MANIFEST_BASELINE) else ''
    diff = list(difflib.unified_diff(lf(m_seen.encode()).decode().splitlines(), lf(m_amo.encode()).decode().splitlines(),
                                     'last synced AMO manifest', f'amo-{ver}/manifest.json', lineterm=''))
    if a.accept_manifest:
        open(AMO_MANIFEST_BASELINE, 'w', encoding='utf-8', newline='').write(m_amo)
        print('recorded the current AMO manifest as handled')
        diff = []

    mode = 'applied' if a.apply else 'would change (dry run)'
    print()
    print(f'merged cleanly, {mode}: {changed or "none"}')
    print(f'merged WITH CONFLICTS, {mode} (fix the <<<<<<< markers): {conflicts or "none"}')
    print(f'new AMO-only files, {mode}: {added or "none"}')
    print()
    if diff:
        print('manifest.json: new upstream Firefox manifest changes, apply by hand, then rerun with --accept-manifest:')
        for line in diff:
            print('  ' + line)
    else:
        print('manifest.json: nothing new from upstream')
    return 2 if (conflicts or diff) else 0


if __name__ == '__main__':
    sys.exit(main())

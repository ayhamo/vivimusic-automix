"""Merge an upstream GitHub tag (Chrome source) into the current branch.

Resolves only the conflicts that are routine for this fork:
  * files this fork deleted on purpose (star gate, funding links, splash,
    tab icon): stay deleted
  * manifest.json hunks where the two sides differ only in the "version"
    line: keep ours (the fork has its own version numbers)
Anything else is left unmerged and the script exits 2, so CI fails loudly.

Usage: python scripts/merge_upstream.py <tag> [--commit]
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DELETED_HERE = {'src/gate.js', 'src/gate.css', 'src/stargate.js', 'src/loader.js', 'src/favicon-main.js', 'icons/custom-logo-full.png', 'icons/custom-logo-icon.png', '.github/FUNDING.yml'}
# files this fork rewrote: upstream's copy stays in the tree unchanged (so it merges cleanly) and the
# manifest runs ours (manifest-plus.json "replace"); upstream's edits to it are ported by hand
FORKED = {'src/crossfade.js': 'src/automix/crossfade.js', 'src/crossfade-page.js': 'src/automix/crossfade-page.js'}
# upstream files whose functions src/plus/bg-plus.js replaces by reassigning them (copies of ours):
# upstream's edits to those functions merge without a conflict and then do nothing, so look at them
SHADOWED = {'src/spotify.js': 'getSpDc, setSpDc, getSecretDict, clearSpotify, spotifyConnectFromBrowser',
            'src/apple-canvas.js': 'getOrFetchAmpToken, ampGet, extractEditorialVideoUrl, resolveAppleCanvasDirect',
            'src/background.js': 'checkForUpdate, lastfmWebPoll, ensureAmpHeaderSpoofRule'}
VERSION_LINE = re.compile(r'^\s*"version"\s*:')


def git(*args, check=True):
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
    if check and r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{r.stdout}{r.stderr}")
    return r


MARKER = re.compile(r'^(<<<<<<<|=======|>>>>>>>|\|{7})( |\r?$)', re.M)
# ours, optional diff3/zdiff3 base section, theirs; LF or CRLF line endings
CONFLICT = re.compile(r'<<<<<<< [^\n]*\n(.*?)(?:\|{7}[^\n]*\n.*?)?=======\r?\n(.*?)>>>>>>> [^\n]*\n', re.S)


def resolve_manifest(path):
    """Keep ours in hunks that differ only by the version line. True if fully resolved."""
    text = open(path, encoding='utf-8', newline='').read()
    strip = lambda block: [l.rstrip('\r') for l in block.splitlines() if not VERSION_LINE.match(l)]
    out, i = [], 0
    for m in CONFLICT.finditer(text):
        out.append(text[i:m.start()])
        out.append(m.group(1) if strip(m.group(1)) == strip(m.group(2)) else m.group(0))
        i = m.end()
    out.append(text[i:])
    result = ''.join(out)
    open(path, 'w', encoding='utf-8', newline='').write(result)
    return not MARKER.search(result)


def rebuild_manifest(tag, base):
    """manifest.json is built: upstream's (the tag) + manifest-plus.json. The version is three-way:
    ours only if we changed it since the merge base, else upstream's (git's own rule)."""
    ours = json.loads(git('show', 'HEAD:manifest.json').stdout).get('version')
    was = json.loads(git('show', f'{base}:manifest.json').stdout).get('version')
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'apply_manifest.py'), '--ref', tag],
                       cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
    print(r.stdout + r.stderr, end='')
    if r.returncode not in (0, 1):
        return False
    path = os.path.join(ROOT, 'manifest.json')
    m = json.load(open(path, encoding='utf-8'))
    if ours and ours != was:
        m['version'] = ours
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(m, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    if r.returncode == 1:
        print('manifest.json: rebuilt, but manifest-plus.json lost an anchor (above): check it, then git add it')
    return r.returncode == 0


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    tag, commit = sys.argv[1], '--commit' in sys.argv
    base = git('merge-base', 'HEAD', tag).stdout.strip()
    changed = set(git('diff', '--name-only', base, tag).stdout.split())
    for up, ours in FORKED.items():
        if up in changed:
            print(f'port by hand: upstream changed {up} (ours is {ours}); see git diff {base[:9]} {tag} -- {up}')
    for up, names in SHADOWED.items():
        if up in changed:
            print(f'check by hand: upstream changed {up}; src/plus/bg-plus.js replaces {names}')
    r = git('merge', '--no-ff', '--no-commit', tag, check=False)
    print(r.stdout + r.stderr)
    unmerged = [p for p in git('diff', '--name-only', '--diff-filter=U').stdout.splitlines() if p]
    left = []
    for p in unmerged:
        if p in DELETED_HERE:
            git('rm', '-q', '--', p)
            print(f'kept deleted: {p}')
        elif p == 'manifest.json' and resolve_manifest(os.path.join(ROOT, p)):
            git('add', '--', p)
            print('manifest.json: only the version differed, kept ours')
        elif p == 'manifest.json' and rebuild_manifest(tag, base):
            git('add', '--', p)
            print('manifest.json: rebuilt from upstream', tag, '+ manifest-plus.json')
        else:
            left.append(p)
    # Upstream re-adding a file we deleted (no conflict, just "added by them").
    for p in DELETED_HERE:
        if os.path.exists(os.path.join(ROOT, p)) and p not in unmerged:
            git('rm', '-q', '--', p)
            print(f'removed re-added file: {p}')
    if left:
        print('needs a human, unresolved conflicts in:', ', '.join(left))
        return 2
    # Never commit a file that still carries conflict markers.
    for p in git('diff', '--cached', '--name-only').stdout.splitlines():
        f = os.path.join(ROOT, p)
        if os.path.isfile(f) and MARKER.search(open(f, encoding='utf-8', errors='replace', newline='').read()):
            print('conflict markers left in', p)
            return 2
    if commit and git('rev-parse', '-q', '--verify', 'MERGE_HEAD', check=False).returncode == 0:
        git('commit', '--no-edit', '-q')
        print(f'merged {tag}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

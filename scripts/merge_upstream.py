"""Merge an upstream GitHub tag (Chrome source) into the current branch.

Resolves only the conflicts that are routine for this fork:
  * files this fork deleted on purpose (star gate, funding links): stay deleted
  * manifest.json hunks where the two sides differ only in the "version"
    line: keep ours (the fork has its own version numbers)
Anything else is left unmerged and the script exits 2, so CI fails loudly.

Usage: python scripts/merge_upstream.py <tag> [--commit]
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DELETED_HERE = {'src/gate.js', 'src/gate.css', 'src/stargate.js', '.github/FUNDING.yml'}
VERSION_LINE = re.compile(r'^\s*"version"\s*:')


def git(*args, check=True):
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
    if check and r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{r.stdout}{r.stderr}")
    return r


def resolve_manifest(path):
    """Keep ours in hunks that differ only by the version line. True if fully resolved."""
    text = open(path, encoding='utf-8', newline='').read()
    out, i, unresolved = [], 0, False
    pattern = re.compile(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', re.S)
    for m in pattern.finditer(text):
        ours, theirs = m.group(1), m.group(2)
        strip = lambda block: [l for l in block.splitlines() if not VERSION_LINE.match(l)]
        out.append(text[i:m.start()])
        if strip(ours) == strip(theirs):
            out.append(ours)
        else:
            out.append(m.group(0))
            unresolved = True
        i = m.end()
    out.append(text[i:])
    open(path, 'w', encoding='utf-8', newline='').write(''.join(out))
    return not unresolved


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    tag, commit = sys.argv[1], '--commit' in sys.argv
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
    if commit and git('rev-parse', '-q', '--verify', 'MERGE_HEAD', check=False).returncode == 0:
        git('commit', '--no-edit', '-q')
        print(f'merged {tag}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

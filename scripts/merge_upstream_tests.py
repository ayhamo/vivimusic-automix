"""Tests for scripts/merge_upstream.py's main() with git faked (no repository touched).

  python scripts/merge_upstream_tests.py        (exit 1 on a failure)
"""
import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('merge_upstream', os.path.join(HERE, 'merge_upstream.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

failed = 0


def check(name, got, want):
    global failed
    ok = got == want
    if not ok:
        failed += 1
    print('ok  ' if ok else 'FAIL', name, '' if ok else f'\n     got  {got!r}\n     want {want!r}')


def run(merge_rc, unmerged=(), merge_head=False, changed=(), rebuild=True):
    """main() against a fake git: what it returns, and what it asked for."""
    calls, rebuilt = [], []

    def git(*args, check=True):
        calls.append(args)
        out, rc = '', 0
        if args[0] == 'merge-base':
            out = 'base0'
        elif args[:2] == ('diff', '--name-only') and len(args) == 4 and args[2] == 'base0':
            out = '\n'.join(changed)
        elif args[:3] == ('diff', '--name-only', '--diff-filter=U'):
            out = '\n'.join(unmerged)
        elif args[0] == 'merge':
            rc = merge_rc
        elif args[:2] == ('rev-parse', '-q'):
            rc = 0 if merge_head else 1
        elif args[:3] == ('diff', '--cached', '--name-only'):
            out = ''
        return types.SimpleNamespace(stdout=out, stderr='', returncode=rc)

    M.git = git
    M.rebuild_manifest = lambda tag, base: (rebuilt.append(tag), rebuild)[1]
    M.resolve_manifest = lambda path: False
    sys.argv = ['merge_upstream.py', 'v9', '--commit']
    return M.main(), calls, rebuilt


# a merge that failed with nothing to resolve (bad tag, dirty tree): its own exit code, not 0
rc, calls, _ = run(merge_rc=128)
check('a failed merge with no conflicts and no MERGE_HEAD: fails', rc, 128)
check('  and commits nothing', any(c[0] == 'commit' for c in calls), False)
# upstream changed background.js (its importScripts list): the manifest is rebuilt though it merged cleanly
rc, calls, rebuilt = run(merge_rc=0, merge_head=True, changed=['src/background.js', 'src/popup.js'])
check('background.js changed upstream, a clean merge: the manifest is rebuilt and added', [rc, rebuilt, ('add', '--', 'manifest.json') in calls], [0, ['v9'], True])
rc, calls, rebuilt = run(merge_rc=0, merge_head=True, changed=['src/background.js'], rebuild=False)
check('  a rebuild that needs a human: fails, nothing committed', [rc, any(c[0] == 'commit' for c in calls)], [2, False])
rc, calls, rebuilt = run(merge_rc=0, merge_head=True, changed=['src/popup.js'])
check('neither changed: no rebuild, committed', [rc, rebuilt, any(c[0] == 'commit' for c in calls)], [0, [], True])
rc, calls, rebuilt = run(merge_rc=0, merge_head=False, changed=[])
check('already up to date: nothing to do', [rc, rebuilt], [0, []])

print(f'{failed} failed' if failed else 'all passed')
sys.exit(1 if failed else 0)

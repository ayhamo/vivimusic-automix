"""Build manifest.json from upstream's manifest plus manifest-plus.json.

Our manifest changes live in manifest-plus.json as operations (set, add,
remove, insert before/after). After each upstream merge, manifest.json is
rebuilt from upstream's new manifest, so a manifest conflict is solved by
running this script instead of by hand.

Usage:
  python scripts/apply_manifest.py --ref v11.5.0      upstream's manifest at a git ref
  python scripts/apply_manifest.py --ref v11.1 --check  only compare with manifest.json

Firefox's background.scripts list is built from the importScripts() call in
upstream's src/background.js at the same ref, so upstream's new background
helpers are picked up without editing the overlay.
Exit code: 0 ok, 1 an operation could not be applied (anchor missing), 2 --check differs.
"""
import argparse
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
problems = []


def git_show(ref, path):
    return subprocess.run(['git', 'show', f'{ref}:{path}'], cwd=ROOT, check=True,
                          capture_output=True, text=True, encoding='utf-8').stdout


def list_ops(items, ops, what):
    items = list(items or [])
    # replace: our copy takes the place of upstream's file (a file this fork rewrote: upstream's stays
    # in the tree unchanged, so its edits merge cleanly and are ported by hand)
    for old, new in ops.get('replace', {}).items():
        if old in items:
            items[items.index(old)] = new
        else:
            problems.append(f'{what}: {old} (replaced by {new}) is gone; added at the end')
            items.append(new)
    for x in ops.get('remove', []):
        if x in items:
            items.remove(x)
    for x in ops.get('add', []):
        if x not in items:
            items.append(x)
    for op in ops.get('insert', []):
        x = op['item']
        if x in items:
            continue
        if op.get('first'):
            items.insert(0, x)
        elif 'after' in op or 'before' in op:
            anchor = op.get('after', op.get('before'))
            if anchor not in items:
                problems.append(f'{what}: anchor {anchor} for {x} is gone; added at the end')
                items.append(x)
            else:
                i = items.index(anchor)
                items.insert(i + 1 if 'after' in op else i, x)
        else:
            items.append(x)
    return items


def background_helpers(ref):
    src = git_show(ref, 'src/background.js')
    m = re.search(r'importScripts\(([^)]*)\)', src)
    if not m:
        problems.append('background: no importScripts() in upstream background.js')
        return []
    # importScripts('a.js', "b.js", `c.js`): any of JavaScript's string quotes
    return ['src/' + q[1] for q in re.findall(r"""(['"`])([^'"`]+)\1""", m.group(1))]


def build(ref):
    up = json.loads(git_show(ref, 'manifest.json'))
    plus = json.load(open(os.path.join(ROOT, 'manifest-plus.json'), encoding='utf-8'))
    m = json.loads(json.dumps(up))
    for k, v in plus.get('set', {}).items():
        m[k] = v
    m['permissions'] = list_ops(m.get('permissions'), plus.get('permissions', {}), 'permissions')
    m['host_permissions'] = list_ops(m.get('host_permissions'), plus.get('host_permissions', {}), 'host_permissions')

    bg = plus.get('background_scripts', {})
    helpers = [s for s in background_helpers(ref) if s not in bg.get('drop', [])]
    sw = m.get('background', {}).get('service_worker', 'src/background.js')
    scripts = helpers + [s for s in bg.get('before_background', []) if s not in helpers] + [sw] + bg.get('after_background', [])
    m['background'] = {'scripts': scripts, 'service_worker': sw}

    for cs_ops in plus.get('content_scripts', []):
        group = next((g for g in m.get('content_scripts', []) if cs_ops['match_js'] in g.get('js', [])), None)
        if group is None:
            problems.append(f"content_scripts: no group with {cs_ops['match_js']}")
            continue
        for key in ('js', 'css'):
            if key in cs_ops:
                group[key] = list_ops(group.get(key), cs_ops[key], f"content_scripts[{cs_ops['match_js']}].{key}")
                if not group[key]:
                    del group[key]

    war_ops = plus.get('web_accessible_resources', {})
    war = next((w for w in m.get('web_accessible_resources', []) if 'https://music.youtube.com/*' in w.get('matches', [])), None)
    if war is None:
        problems.append('web_accessible_resources: no entry for music.youtube.com')
    else:
        war['resources'] = list_ops(war.get('resources'), war_ops, 'web_accessible_resources')

    # keys we set go where upstream had them; new ones at the end, gecko settings last
    order = list(up.keys()) + [k for k in m if k not in up]
    if 'browser_specific_settings' in order:
        order.remove('browser_specific_settings')
        order.append('browser_specific_settings')
    return {k: m[k] for k in order}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True, help="upstream git ref (tag) whose manifest.json is the base")
    ap.add_argument('--check', action='store_true', help='compare with manifest.json, write nothing')
    a = ap.parse_args()
    out = build(a.ref)
    for p in problems:
        print('WARNING:', p)
    path = os.path.join(ROOT, 'manifest.json')
    if a.check:
        cur = json.load(open(path, encoding='utf-8'))
        if cur == out:
            print('manifest.json matches upstream', a.ref, '+ manifest-plus.json')
            return 1 if problems else 0
        for k in sorted(set(cur) | set(out)):
            if cur.get(k) != out.get(k):
                print('differs:', k)
                print('  manifest.json:', json.dumps(cur.get(k))[:600])
                print('  built:        ', json.dumps(out.get(k))[:600])
        return 2
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    print('manifest.json built from upstream', a.ref, '+ manifest-plus.json')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
# gg_tags_index.py — сканер якорей GG: по проекту
import os, re, sys, json
ROOT = sys.argv[1] if len(sys.argv)>1 else '.'
PAT = re.compile(r'^\s*(?:\/\/|<!--|/\*|\*)\s*\[?GG:(API|SECTION|END|ANCHOR|FEATURE|CHANGELOG)\b([^ \]]*)', re.I)

out = []
for dirpath, _, files in os.walk(ROOT):
    for fn in files:
        if not any(fn.endswith(x) for x in ('.js', '.ts', '.html', '.md')): continue
        p = os.path.join(dirpath, fn)
        try:
            with open(p, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f, 1):
                    m = PAT.search(line)
                    if m:
                        out.append({'file': os.path.relpath(p, ROOT), 'line': i, 'kind': m.group(1), 'detail': m.group(2).strip()})
        except Exception as e:
            pass

print(json.dumps(out, ensure_ascii=False, indent=2))
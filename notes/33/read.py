import json, os

D = os.path.dirname(os.path.abspath(__file__))
rows = []
for line in open(os.path.join(D, 'status.jsonl')):
    line = line.strip()
    if not line:
        continue
    try:
        rows.append(json.loads(line))
    except Exception as e:
        print('bad line', e)
print('count', len(rows))
if rows:
    print('keys', sorted(rows[-1].keys()))
seen = set()
for r in rows:
    key = json.dumps({'pc': r.get('prompt_cache'), 'rl': r.get('rate_limits')}, sort_keys=True)
    if key in seen:
        continue
    seen.add(key)
    print(json.dumps({'version': r.get('version'), 'model': (r.get('model') or {}).get('id'), 'prompt_cache': r.get('prompt_cache'), 'rate_limits': r.get('rate_limits')}))

import glob, sqlite3

for p in sorted(glob.glob('/home/u/g/antigravity-cli/conversations/*.db')):
    c = sqlite3.connect('file:%s?mode=ro' % p, uri=True)
    schema = c.execute("select sql from sqlite_master where name='parent_references'").fetchone()
    rows = c.execute('select * from parent_references').fetchall()
    print(p.rsplit('/', 1)[1], schema[0] if schema else None)
    for r in rows:
        print('  ', [x if not isinstance(x, bytes) else x[:200] for x in r])

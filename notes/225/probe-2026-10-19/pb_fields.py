import sqlite3
import sys

db = sys.argv[1]
table = sys.argv[2]
needle = sys.argv[3].encode()


def varint(b, i):
    r = 0
    s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7f) << s
        s += 7
        if c < 0x80:
            return r, i


def walk(b, path, out, depth=0):
    i = 0
    n = len(b)
    while i < n:
        try:
            key, i = varint(b, i)
        except IndexError:
            return
        fnum, wt = key >> 3, key & 7
        p = path + [fnum]
        if wt == 0:
            v, i = varint(b, i)
            if depth <= 2 and any(x in path for x in ()):
                pass
            out.append((p, 'varint', v))
        elif wt == 1:
            i += 8
        elif wt == 5:
            i += 4
        elif wt == 2:
            ln, i = varint(b, i)
            chunk = b[i:i + ln]
            i += ln
            if needle in chunk and len(chunk) == len(needle) + 0 or chunk == needle:
                out.append((p, 'string', chunk.decode('utf-8', 'replace')))
            elif needle in chunk:
                sub = []
                ok = True
                try:
                    walk(chunk, p, sub, depth + 1)
                except Exception:
                    ok = False
                if ok and sub:
                    out.extend(sub)
                else:
                    out.append((p, 'bytes-with-needle', chunk[:80]))
            elif len(chunk) < 64:
                try:
                    txt = chunk.decode('utf-8')
                    if txt.isprintable():
                        out.append((p, 'str', txt))
                except UnicodeDecodeError:
                    pass
        else:
            return


con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
cur = con.cursor()
cur.execute('select idx, data from "%s"' % table)
for idx, data in cur.fetchall():
    out = []
    walk(data, [], out)
    print('row idx', idx, 'bytes', len(data))
    hit_paths = [o for o in out if o[1] in ('string', 'bytes-with-needle')]
    for o in hit_paths:
        print('  NEEDLE at field path', o[0], o[1], o[2])
    for o in out:
        if o[1] == 'varint' and len(o[0]) >= 2 and hit_paths and o[0][:-1] == hit_paths[0][0][:-1]:
            print('  sibling varint', o[0], o[2])
        if o[1] == 'str' and hit_paths and o[0][:-1] == hit_paths[0][0][:-1]:
            print('  sibling str', o[0], o[2])

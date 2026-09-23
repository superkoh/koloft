#!/usr/bin/env node
/*
 * The `rsync` the mirror pulls with. Every transfer flag is ignored; only the last two
 * arguments matter — `<host>:<relative dir>/` and the local dir — and the relative dir
 * is resolved against the fake machine's home, which is where the "remote" files really
 * are. Full argv goes to `<state>/rsync-log`; `<state>/hb-fail` makes it exit 255, the
 * same unreachable-machine answer the fake ssh gives.
 */
const fs = require('fs')
const path = require('path')

const STATE = process.env.KOLOFT_FAKE_SSH_STATE
const cfg = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'))
const argv = process.argv.slice(2)

try {
  fs.appendFileSync(cfg.rsyncLog, JSON.stringify({ argv, ts: Date.now() }) + '\n')
} catch {
  /* observation scaffolding only */
}

if (fs.existsSync(path.join(STATE, 'hb-fail'))) process.exit(255)

const dst = argv[argv.length - 1]
const src = argv[argv.length - 2] || ''
const rel = src.replace(/^[^:]*:/, '').replace(/\/+$/, '')
const from = path.isAbsolute(rel) ? rel : path.join(cfg.machine, rel)

// Only a file whose BYTES moved is rewritten — what `--inplace` buys the real thing.
// Copying unconditionally re-creates every hook report each round, and the watcher on
// the mirror replays the tab's last SessionStart as if it had just happened.
function mirror(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true })
  for (const e of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const src = path.join(fromDir, e.name)
    const out = path.join(toDir, e.name)
    if (e.isDirectory()) {
      mirror(src, out)
      continue
    }
    const buf = fs.readFileSync(src)
    let same = false
    try {
      same = fs.readFileSync(out).equals(buf)
    } catch {
      /* not there yet */
    }
    if (!same) fs.writeFileSync(out, buf)
  }
}

if (fs.existsSync(from)) mirror(from, dst)
process.exit(0)

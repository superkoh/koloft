#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const SSH_UNREACHABLE_EXIT = 255

const STATE = process.env.KOLOFT_FAKE_SSH_STATE
const cfg = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'))
const argv = process.argv.slice(2)

try {
  fs.appendFileSync(cfg.rsyncLog, JSON.stringify({ argv, ts: Date.now() }) + '\n')
} catch {}

// PLATFORM§33
if (fs.existsSync(path.join(STATE, 'hb-fail'))) process.exit(SSH_UNREACHABLE_EXIT)

const dst = argv[argv.length - 1]
const src = argv[argv.length - 2] || ''
const rel = src.replace(/^[^:]*:/, '').replace(/\/+$/, '')
const from = path.isAbsolute(rel) ? rel : path.join(cfg.machine, rel)

const excludedNames = argv.map((a) => /^--exclude=([^*/]+)$/.exec(a)?.[1]).filter((name) => !!name)

function mirrorRewritingOnlyChangedBytesLikeInplace(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true })
  for (const e of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const src = path.join(fromDir, e.name)
    const out = path.join(toDir, e.name)
    if (e.isDirectory()) {
      mirrorRewritingOnlyChangedBytesLikeInplace(src, out)
      continue
    }
    if (excludedNames.includes(e.name)) continue
    const buf = fs.readFileSync(src)
    let same = false
    try {
      same = fs.readFileSync(out).equals(buf)
    } catch {}
    if (!same) fs.writeFileSync(out, buf)
  }
}

if (fs.existsSync(from)) mirrorRewritingOnlyChangedBytesLikeInplace(from, dst)
process.exit(0)

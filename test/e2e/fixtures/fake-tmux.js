#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const STATE = process.env.KOLOFT_FAKE_SSH_STATE
const aliveDir = path.join(STATE, 'alive')
const ioDir = path.join(STATE, 'io')
fs.mkdirSync(aliveDir, { recursive: true })
fs.mkdirSync(ioDir, { recursive: true })

const raw = process.argv.slice(2)
let verb = null
const rest = []
for (let i = 0; i < raw.length; i++) {
  const a = raw[i]
  if (a === '-L' || a === '-f') {
    i++
    continue
  }
  if (!verb) verb = a
  else rest.push(a)
}
const flagVal = (f) => {
  const i = rest.indexOf(f)
  return i >= 0 ? rest[i + 1] : undefined
}

const openFifoNeverSeeingEof = (fifo) => fs.openSync(fifo, fs.constants.O_RDWR)

const aliveFile = (name) => path.join(aliveDir, name)
const fifoPath = (io) => path.join(ioDir, `${io}.in`)
const outPath = (io) => path.join(ioDir, `${io}.out`)

function recordOf(name) {
  try {
    const rec = JSON.parse(fs.readFileSync(aliveFile(name), 'utf8'))
    return { pid: Number(rec.pid), io: String(rec.io) }
  } catch {
    return null
  }
}
function pidOf(name) {
  return recordOf(name)?.pid ?? 0
}
function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function attach(name) {
  const rec = recordOf(name)
  const pid = rec?.pid ?? 0
  const io = rec?.io ?? name
  if (!alive(pid)) {
    try {
      fs.unlinkSync(aliveFile(name))
    } catch {}
    process.exit(1)
  }
  const wfd = openFifoNeverSeeingEof(fifoPath(io))
  process.stdin.on('data', (d) => {
    try {
      fs.writeSync(wfd, d)
    } catch {}
  })
  process.stdin.resume()

  let off = 0
  const pump = () => {
    try {
      const size = fs.statSync(outPath(io)).size
      if (size <= off) return
      const buf = Buffer.alloc(size - off)
      const fd = fs.openSync(outPath(io), 'r')
      fs.readSync(fd, buf, 0, buf.length, off)
      fs.closeSync(fd)
      off = size
      process.stdout.write(buf)
    } catch {}
  }
  setInterval(pump, 80)
  setInterval(() => {
    if (alive(pid)) return
    pump()
    try {
      fs.unlinkSync(aliveFile(name))
    } catch {}
    setTimeout(() => process.exit(0), 150)
  }, 200)
}

if (verb === 'new-session') {
  const name = flagVal('-s')
  const cmd = rest[rest.length - 1]
  if (!alive(pidOf(name))) {
    const io = name
    const fifo = fifoPath(io)
    try {
      fs.unlinkSync(fifo)
    } catch {}
    cp.execFileSync('mkfifo', [fifo])
    fs.writeFileSync(outPath(io), '')
    const inFd = openFifoNeverSeeingEof(fifo)
    const outFd = fs.openSync(outPath(io), 'a')
    const cmdSurvivingHangup = `trap "" HUP; ${cmd}`
    const child = cp.spawn('sh', ['-c', cmdSurvivingHangup], {
      detached: true,
      stdio: [inFd, outFd, outFd],
      cwd: process.cwd(),
      // PLATFORM§35
      env: {
        ...process.env,
        TMUX: `${ioDir}/${io}.sock,0,0`,
        TMUX_PANE: '%0',
        KOLOFT_FAKE_TMUX_IO: io
      }
    })
    child.unref()
    fs.writeFileSync(aliveFile(name), JSON.stringify({ pid: child.pid, io }))
  }
  attach(name)
} else if (verb === 'attach') {
  attach(flagVal('-t'))
} else if (verb === 'ls') {
  for (const name of fs.readdirSync(aliveDir)) {
    if (alive(pidOf(name))) process.stdout.write(name + '\n')
    else
      try {
        fs.unlinkSync(aliveFile(name))
      } catch {}
  }
  process.exit(0)
} else if (verb === 'display-message' || verb === 'display') {
  const io = process.env.KOLOFT_FAKE_TMUX_IO
  const me = fs.readdirSync(aliveDir).find((n) => (io ? recordOf(n)?.io === io : false))
  process.stdout.write((me ?? '') + '\n')
  process.exit(0)
} else if (verb === 'rename-session') {
  const to = rest[rest.length - 1]
  const io = process.env.KOLOFT_FAKE_TMUX_IO
  const from = fs
    .readdirSync(aliveDir)
    .find((n) => (io ? recordOf(n)?.io === io : n === flagVal('-t')))
  if (from && to && from !== to) fs.renameSync(aliveFile(from), aliveFile(to))
  process.exit(0)
} else if (verb === 'kill-session') {
  const name = flagVal('-t')
  const pid = pidOf(name)
  if (pid) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {}
    cp.spawnSync('sleep', ['0.5'])
    if (alive(pid))
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
  }
  try {
    fs.unlinkSync(aliveFile(name))
  } catch {}
  process.exit(0)
} else {
  process.exit(0)
}

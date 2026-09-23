#!/usr/bin/env node
/*
 * The `tmux` on the fake machine's PATH (helpers/remote.ts). It reproduces the one
 * property the whole remote design rests on: the session keeps running when the thing
 * that started it goes away, and a later `attach` finds it again.
 *
 * `new-session -A -D -s <name> '<cmd>'`
 *   already alive → attach; otherwise spawn `sh -c 'trap "" HUP; <cmd>'` DETACHED, in
 *   its own process group, stdin from a FIFO and stdout/stderr appended to a file, then
 *   attach. The pid goes in `<state>/alive/<name>`. Detached + ignored SIGHUP is what
 *   makes E-RW-08 (quit Koloft, relaunch, attach) possible at all — and keeps
 *   Playwright's teardown process-group kill from taking the "remote" claude with it.
 * `attach -d -t <name>`  → pump our stdin into the FIFO and the out file to our stdout
 *   until the pid dies (exit 0) or we are killed; missing session → exit 1.
 * `rename-session -t <pane|name> <new>` → the session KEEPS its files and only its
 *   name moves, so an attach already pumping is untouched. The caller is Koloft's hook
 *   running inside the session, which knows itself by `$TMUX_PANE`; the spawned command
 *   carries its io key in the env, and every alive record names that same key.
 * `ls -F '#S'`           → the names under alive/ whose pid still answers (dead ones
 *   are swept), one per line — exactly what the heartbeat parses.
 * `kill-session -t <name>` → TERM then KILL the process group, drop the alive file.
 *
 * The FIFO is opened O_RDWR on both ends so it never sees EOF: a detached claude whose
 * stdin closed would exit the moment the first attach ended.
 */
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

const aliveFile = (name) => path.join(aliveDir, name)
const fifoPath = (io) => path.join(ioDir, `${io}.in`)
const outPath = (io) => path.join(ioDir, `${io}.out`)

/** what an alive record holds: the session's pid and the io key its FIFO and out file
 *  are named after. The key never moves, so a rename costs a running attach nothing. */
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
    } catch {
      /* already gone */
    }
    process.exit(1)
  }
  const wfd = fs.openSync(fifoPath(io), fs.constants.O_RDWR)
  process.stdin.on('data', (d) => {
    try {
      fs.writeSync(wfd, d)
    } catch {
      /* the session ended under us */
    }
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
    } catch {
      /* the out file may not exist for a beat */
    }
  }
  setInterval(pump, 80)
  setInterval(() => {
    if (alive(pid)) return
    pump()
    try {
      fs.unlinkSync(aliveFile(name))
    } catch {
      /* already swept */
    }
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
    } catch {
      /* first run */
    }
    cp.execFileSync('mkfifo', [fifo])
    fs.writeFileSync(outPath(io), '')
    const inFd = fs.openSync(fifo, fs.constants.O_RDWR)
    const outFd = fs.openSync(outPath(io), 'a')
    const child = cp.spawn('sh', ['-c', `trap "" HUP; ${cmd}`], {
      detached: true,
      stdio: [inFd, outFd, outFd],
      cwd: process.cwd(),
      // the real tmux sets both, and the hook renames the session only when it finds
      // itself inside one. KOLOFT_FAKE_TMUX_IO is what `-t %0` resolves through.
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
      } catch {
        /* raced with another sweep */
      }
  }
  process.exit(0)
} else if (verb === 'display-message' || verb === 'display') {
  // `display-message -p -t $TMUX_PANE '#S'` from inside the session: its own name
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
    } catch {
      /* already dead */
    }
    cp.spawnSync('sleep', ['0.5'])
    if (alive(pid))
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already dead */
      }
  }
  try {
    fs.unlinkSync(aliveFile(name))
  } catch {
    /* never existed */
  }
  process.exit(0)
} else {
  process.exit(0)
}

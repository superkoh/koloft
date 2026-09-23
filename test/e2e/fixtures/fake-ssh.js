#!/usr/bin/env node
/*
 * The `ssh` a remote-workspace E2E run gets instead of the real one. There is no second
 * machine: this script IS the machine. Its home is `<state>/machine/`, and everything a
 * real remote would hold — the pushed packages, `~/.claude/projects`, the hook reports —
 * lands there, so the product's own rsync mirror, sidebar reader and kill path all run
 * unchanged against real files.
 *
 * State dir comes from KOLOFT_FAKE_SSH_STATE (set on the app's launch env by
 * helpers/remote.ts installFakeRemote), with the paths in `<state>/config.json`.
 *
 * What it does is decided by the LAST argv element — the remote command string:
 *   `test -d "$HOME/.koloft/m-…"`  → run it under HOME=machine (prints ok iff pushed)
 *   contains `tar xf -`            → run it under HOME=machine with stdin inherited,
 *                                    so the real tar on this Mac unpacks the package
 *   `-tt` + `sh "$HOME/.koloft/tabs/<tab>.sh" <mode>` → run that script for real, with
 *                                    stdio inherited: THIS process is the tab terminal
 *   anything else (heartbeat, kill) → run it under HOME=machine; `<state>/hb-fail`
 *                                    makes it exit 255 without running anything, the
 *                                    way an unreachable machine does
 *
 * Every call appends one {argv, phase:'start'} line to `<state>/log` and one
 * {argv, phase:'end', exit} line when it finishes, so a spec can read both "was this
 * ever asked for" and "what did it answer".
 */
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const STATE = process.env.KOLOFT_FAKE_SSH_STATE
const cfg = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'))
const argv = process.argv.slice(2)
const remoteCmd = argv[argv.length - 1] || ''

function log(rec) {
  try {
    fs.appendFileSync(cfg.log, JSON.stringify({ ...rec, ts: Date.now() }) + '\n')
  } catch {
    /* observation scaffolding only */
  }
}

log({ argv, phase: 'start' })

function done(code) {
  log({ argv, phase: 'end', exit: code })
  process.exit(code)
}

/** the environment every command on "the machine" sees: its own home, and a PATH whose
 *  first entry holds the fake tmux / rsync / claude and the node wrapper ensure.sh finds */
function machineEnv(extra) {
  return {
    ...process.env,
    HOME: cfg.machine,
    PWD: cfg.machine,
    PATH: `${cfg.bin}:${cfg.nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...extra
  }
}

function runSh(cmd, stdin, extraEnv) {
  const r = cp.spawnSync('sh', ['-c', cmd], {
    stdio: [stdin, 'inherit', 'inherit'],
    env: machineEnv(extraEnv),
    cwd: cfg.machine
  })
  return r.status == null ? 1 : r.status
}

if (remoteCmd.includes('tar xf -')) {
  done(runSh(remoteCmd, 'inherit'))
}

if (remoteCmd.includes('test -d "$HOME/.koloft/m-')) {
  done(runSh(remoteCmd, 'ignore'))
}

if (argv.includes('-tt')) {
  const m = /tabs\/([^"/]+)\.sh"?\s+(\w+)/.exec(remoteCmd)
  if (!m) done(2)
  const script = path.join(cfg.machine, '.koloft', 'tabs', `${m[1]}.sh`)
  const r = cp.spawnSync('sh', [script, m[2]], {
    stdio: 'inherit',
    cwd: cfg.machine,
    env: machineEnv({
      // keeps readCalls/resumedId working: the remote claude writes into the same log
      // the local one does, which is the only process-boundary view a spec has
      KOLOFT_FAKE_CLAUDE_LOG: cfg.claudeCalls,
      KOLOFT_SCRATCHPAD_BASE: cfg.scratchpadBase
    })
  })
  done(r.status == null ? 1 : r.status)
}

// heartbeat, kill-session, and anything else: the machine may be unreachable
if (fs.existsSync(path.join(STATE, 'hb-fail'))) done(255)
done(runSh(remoteCmd, 'ignore'))

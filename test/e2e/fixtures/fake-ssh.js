#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const SSH_UNREACHABLE_EXIT = 255

const STATE = process.env.KOLOFT_FAKE_SSH_STATE
const cfg = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'))
const argv = process.argv.slice(2)
const remoteCmd = argv[argv.length - 1] || ''

function log(rec) {
  try {
    fs.appendFileSync(cfg.log, JSON.stringify({ ...rec, ts: Date.now() }) + '\n')
  } catch {}
}

log({ argv, phase: 'start' })

function done(code) {
  log({ argv, phase: 'end', exit: code })
  process.exit(code)
}

function machineEnvWithFakeBinsFirst(extra) {
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
    env: machineEnvWithFakeBinsFirst(extraEnv),
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
    env: machineEnvWithFakeBinsFirst({
      KOLOFT_FAKE_CLAUDE_LOG: cfg.claudeCalls,
      KOLOFT_SCRATCHPAD_BASE: cfg.scratchpadBase
    })
  })
  done(r.status == null ? 1 : r.status)
}

if (argv.includes('-t')) {
  done(runSh(remoteCmd, 'inherit'))
}

// PLATFORM§33
if (fs.existsSync(path.join(STATE, 'hb-fail'))) done(SSH_UNREACHABLE_EXIT)
done(runSh(remoteCmd, argv.includes('-n') ? 'ignore' : 'inherit'))

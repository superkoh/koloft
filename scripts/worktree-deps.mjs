import fs from 'node:fs'
import { spawn } from 'node:child_process'
import {
  LOCK_HEARTBEAT_MS,
  REINSTALL,
  depsState,
  needsInstall,
  readLock,
  worktreeOf
} from './worktree-deps-state.mjs'

const SETUP_STEPS = [
  ['npm', ['ci']],
  ['npm', ['run', 'rebuild']],
  ['node', ['node_modules/electron/install.js']],
  ['node', ['scripts/fetch-vendor.cjs']]
]

function claimInstall(w) {
  const mine = `${w.lock}.${process.pid}`
  fs.writeFileSync(mine, String(process.pid))
  try {
    fs.linkSync(mine, w.lock)
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(mine, { force: true })
  }
}

function removeLockIfStill(w, text) {
  if (text !== undefined && readLock(w)?.text === text) fs.rmSync(w.lock, { force: true })
}

function stillInstalling(w) {
  const now = new Date()
  fs.utimesSync(w.lock, now, now)
}

const exitCodeOf = (cmd, args, cwd, out) =>
  new Promise((resolve) =>
    spawn(cmd, args, { cwd, stdio: ['ignore', out, out] })
      .on('close', resolve)
      .on('error', () => resolve(1))
  )

const cwd = process.argv.includes('--here')
  ? process.cwd()
  : JSON.parse(fs.readFileSync(0, 'utf8')).cwd
const w = worktreeOf(cwd)
const deadLock = readLock(w)?.text
const state = depsState(w)
if (!needsInstall(w, state)) process.exit(0)
if (state === 'failed') removeLockIfStill(w, deadLock)
if (!claimInstall(w)) process.exit(0)
if (state === 'failed') fs.rmSync(w.nodeModules, { recursive: true, force: true })

const out = fs.openSync(w.log, 'w')
const heartbeat = setInterval(() => stillInstalling(w), LOCK_HEARTBEAT_MS)
let failedStep
for (const [cmd, args] of SETUP_STEPS)
  if ((await exitCodeOf(cmd, args, w.root, out)) !== 0) {
    failedStep = [cmd, args]
    break
  }
clearInterval(heartbeat)
if (failedStep) {
  fs.rmSync(w.nodeModules, { recursive: true, force: true })
  const said =
    `Installing this worktree's node_modules failed at \`${failedStep[0]} ${failedStep[1].join(' ')}\` (log: ${w.log}). ` +
    `node_modules was removed, so Node resolves packages from the parent checkout and a push is stopped until the next session start or \`${REINSTALL}\` installs it: fix it before building or testing here.`
  fs.writeFileSync(w.failed, said)
  console.error(said)
} else fs.rmSync(w.failed, { force: true })
fs.rmSync(w.lock, { force: true })
if (failedStep) process.exit(2)

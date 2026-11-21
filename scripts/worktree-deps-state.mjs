import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const REINSTALL = 'node scripts/worktree-deps.mjs --here'
const LONGEST_STEP_MS = 30 * 60_000

const gitPath = (cwd, ...args) =>
  spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', ...args], {
    encoding: 'utf8'
  }).stdout?.trim() ?? ''

export function worktreeOf(cwd) {
  const root = gitPath(cwd, '--show-toplevel')
  const gitDir = gitPath(cwd, '--git-dir')
  return {
    root,
    linked: root !== '' && gitDir !== gitPath(cwd, '--git-common-dir'),
    nodeModules: path.join(root, 'node_modules'),
    lock: path.join(gitDir, 'worktree-deps.lock'),
    failed: path.join(gitDir, 'worktree-deps.failed'),
    log: path.join(gitDir, 'worktree-deps.log')
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function readLock(w) {
  try {
    return { text: fs.readFileSync(w.lock, 'utf8'), mtimeMs: fs.statSync(w.lock).mtimeMs }
  } catch {
    return undefined
  }
}

export function depsState(w) {
  if (!w.linked) return 'ready'
  const lock = readLock(w)
  if (lock) {
    const pid = Number(lock.text)
    const young = Date.now() - lock.mtimeMs < LONGEST_STEP_MS
    return young && pid > 0 && isAlive(pid) ? 'installing' : 'failed'
  }
  return fs.existsSync(w.failed) ? 'failed' : 'ready'
}

export const lockText = (w) => readLock(w)?.text

export function removeLockIfStill(w, text) {
  if (text !== undefined && lockText(w) === text) fs.rmSync(w.lock, { force: true })
}

export function stillInstalling(w) {
  const now = new Date()
  fs.utimesSync(w.lock, now, now)
}

export function claimInstall(w) {
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

export function failureNote(w) {
  const said = fs.existsSync(w.failed)
    ? fs.readFileSync(w.failed, 'utf8').trim()
    : `Installing this worktree's node_modules stopped before it finished (log: ${w.log}).`
  return `${said} Run \`${REINSTALL}\` in this worktree (it installs node_modules from scratch), then try again.`
}

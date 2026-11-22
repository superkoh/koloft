import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const REINSTALL = 'node scripts/worktree-deps.mjs --here'
export const LOCK_HEARTBEAT_MS = 60_000
const SILENT_LOCK_IS_DEAD_MS = 5 * LOCK_HEARTBEAT_MS

export function worktreeOf(cwd) {
  const [root = '', gitDir = '', commonDir = ''] =
    spawnSync(
      'git',
      [
        '-C',
        cwd,
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir'
      ],
      { encoding: 'utf8' }
    )
      .stdout?.trim()
      .split('\n') ?? []
  return {
    root,
    linked: root !== '' && gitDir !== commonDir,
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

export function readLock(w) {
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
    const young = Date.now() - lock.mtimeMs < SILENT_LOCK_IS_DEAD_MS
    return young && pid > 0 && isAlive(pid) ? 'installing' : 'failed'
  }
  return fs.existsSync(w.failed) ? 'failed' : 'ready'
}

export const needsInstall = (w, state = depsState(w)) =>
  w.linked && state !== 'installing' && (state === 'failed' || !fs.existsSync(w.nodeModules))

export function failureNote(w) {
  const said = fs.existsSync(w.failed)
    ? fs.readFileSync(w.failed, 'utf8').trim()
    : `Installing this worktree's node_modules stopped before it finished (log: ${w.log}).`
  return `${said} Run \`${REINSTALL}\` in this worktree (it installs node_modules from scratch), then try again.`
}

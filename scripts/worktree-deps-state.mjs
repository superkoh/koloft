import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const REINSTALL = 'node scripts/worktree-deps.mjs --here'
const LONGEST_INSTALL_MS = 30 * 60_000

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

export function depsState(w) {
  if (!w.linked) return 'ready'
  if (fs.existsSync(w.lock)) {
    const pid = Number(fs.readFileSync(w.lock, 'utf8'))
    const young = Date.now() - fs.statSync(w.lock).mtimeMs < LONGEST_INSTALL_MS
    return young && pid > 0 && isAlive(pid) ? 'installing' : 'failed'
  }
  return fs.existsSync(w.failed) ? 'failed' : 'ready'
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
  return `${said} Run \`${REINSTALL}\` in this worktree, then try again.`
}

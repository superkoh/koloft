import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp } from './app'
import type { E2EEnv } from './env'
import { encodeCwd, waitBooted } from './p1'

export const REMOTE_HOST = 'devbox'

export function machineHome(env: E2EEnv): string {
  return path.join(env.home, 'fake-ssh', 'machine')
}

export function remoteDir(env: E2EEnv): string {
  return path.join(machineHome(env), 'proj')
}

export function remoteKey(env: E2EEnv): string {
  return `ssh://${REMOTE_HOST}${remoteDir(env)}`
}

export const REMOTE_WS_NAME = 'proj'

export function stateDir(env: E2EEnv): string {
  return path.join(env.home, 'fake-ssh')
}

export function mirrorProjectDir(env: E2EEnv): string {
  return path.join(env.userData, 'remote', REMOTE_HOST, 'projects', encodeCwd(remoteDir(env)))
}

export interface SshCall {
  argv: string[]
  phase: 'start' | 'end'
  exit?: number
  ts: number
}

export function sshCalls(env: E2EEnv): SshCall[] {
  const file = path.join(stateDir(env), 'log')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as SshCall]
      } catch {
        return []
      }
    })
}

export function sshCommands(env: E2EEnv, phase: 'start' | 'end' = 'start'): string[] {
  return sshCalls(env)
    .filter((c) => c.phase === phase)
    .map((c) => c.argv[c.argv.length - 1] ?? '')
}

export function rsyncCalls(env: E2EEnv): string[][] {
  const file = path.join(stateDir(env), 'rsync-log')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [(JSON.parse(l) as { argv: string[] }).argv]
      } catch {
        return []
      }
    })
}

export function liveTmuxSessions(env: E2EEnv): string[] {
  const dir = path.join(stateDir(env), 'alive')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => {
    try {
      process.kill(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).pid as number, 0)
      return true
    } catch {
      return false
    }
  })
}

export function breakConnection(env: E2EEnv): void {
  fs.writeFileSync(path.join(stateDir(env), 'hb-fail'), '')
}

export function healConnection(env: E2EEnv): void {
  fs.rmSync(path.join(stateDir(env), 'hb-fail'), { force: true })
}

export function setNextRemoteSessionTitle(env: E2EEnv, title: string): void {
  fs.writeFileSync(path.join(machineHome(env), 'fake-claude-next-title'), title)
}

export function remoteStatuslineOut(env: E2EEnv): string | null {
  const f = path.join(machineHome(env), 'fake-claude-statusline.out')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
}

export async function addRemoteWorkspace(
  page: Page,
  env: E2EEnv
): Promise<{ code: string; path?: string }> {
  return page.evaluate(
    (p) => window.api.workspace.add(p) as Promise<{ code: string; path?: string }>,
    remoteKey(env)
  )
}

export function seedRemoteWorkspace(env: E2EEnv): void {
  const file = path.join(env.userData, 'layout.json')
  const layout = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    workspaces: { path: string }[]
  }
  layout.workspaces.push({ path: remoteKey(env) })
  fs.writeFileSync(file, JSON.stringify(layout, null, 2))
}

function writeExec(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

export function installFakeRemote(env: E2EEnv): void {
  const state = stateDir(env)
  const machine = machineHome(env)
  // PLATFORM§35
  const binAheadOfHomebrewTmuxOnRemotePathLine = path.join(machine, '.local', 'bin')
  for (const d of [
    state,
    binAheadOfHomebrewTmuxOnRemotePathLine,
    machine,
    remoteDir(env),
    path.join(machine, '.koloft')
  ]) {
    fs.mkdirSync(d, { recursive: true })
  }

  const nodeBin = process.execPath
  const nodeDir = path.dirname(nodeBin)

  fs.writeFileSync(
    path.join(state, 'config.json'),
    JSON.stringify({
      machine,
      bin: binAheadOfHomebrewTmuxOnRemotePathLine,
      nodeDir,
      log: path.join(state, 'log'),
      rsyncLog: path.join(state, 'rsync-log'),
      claudeCalls: env.claudeCalls,
      scratchpadBase: env.scratchpadBase
    })
  )

  const fixtures = path.join(__dirname, '..', 'fixtures')
  const shim = (script: string): string =>
    `#!/bin/sh\nexec ${JSON.stringify(nodeBin)} ${JSON.stringify(path.join(fixtures, script))} "$@"\n`

  // PLATFORM§2
  for (const dir of [env.fakeBin, env.shimDir]) {
    writeExec(path.join(dir, 'ssh'), shim('fake-ssh.js'))
    writeExec(path.join(dir, 'rsync'), shim('fake-rsync.js'))
  }
  writeExec(path.join(binAheadOfHomebrewTmuxOnRemotePathLine, 'tmux'), shim('fake-tmux.js'))
  writeExec(path.join(binAheadOfHomebrewTmuxOnRemotePathLine, 'rsync'), shim('fake-rsync.js'))
  fs.copyFileSync(
    path.join(fixtures, 'fake-claude.js'),
    path.join(binAheadOfHomebrewTmuxOnRemotePathLine, 'claude')
  )
  fs.chmodSync(path.join(binAheadOfHomebrewTmuxOnRemotePathLine, 'claude'), 0o755)

  const nodeWhereEnsureShLooksSoItNeverReachesForCurlOrSudo = path.join(
    machine,
    '.koloft',
    'node',
    'bin'
  )
  fs.mkdirSync(nodeWhereEnsureShLooksSoItNeverReachesForCurlOrSudo, { recursive: true })
  writeExec(
    path.join(nodeWhereEnsureShLooksSoItNeverReachesForCurlOrSudo, 'node'),
    `#!/bin/sh\nexec ${JSON.stringify(nodeBin)} "$@"\n`
  )

  env.launchEnv.KOLOFT_FAKE_SSH_STATE = state
}

export async function launchWithRemote(
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  installFakeRemote(env)
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

export function killFakeRemote(env: E2EEnv): void {
  const thisRunStateDir = stateDir(env)
  for (const line of execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }).split(
    '\n'
  )) {
    if (!line.includes(thisRunStateDir)) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (!pid || pid === process.pid) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

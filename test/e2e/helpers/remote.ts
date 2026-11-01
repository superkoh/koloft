import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp } from './app'
import { agyCalls, installAgy, installCodex, installMuse, type AgyCall, type E2EEnv } from './env'
import {
  type AgentName,
  centerTerm,
  encodeCwd,
  killSession,
  runIn,
  terminalText,
  termIds,
  waitBooted
} from './p1'
import {
  PLAYWRIGHT_CLI_JS_UNDER_ITS_FOLDER,
  PLAYWRIGHT_CLI_UNDER_KOLOFT_HOME
} from '../../../src/main/remote/playwrightCli'
import type { BackendId } from '../../../src/shared/types'

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

const SCRIPT_SENT_AS_BASE64 =
  /^sh -c 'eval "\$\(printf %s "\$0" \| base64 -d\)"' ([A-Za-z0-9+/=]+)$/

export function remoteCommandText(argv: string[]): string {
  const sent = argv[argv.length - 1] ?? ''
  const encoded = SCRIPT_SENT_AS_BASE64.exec(sent)
  return encoded ? Buffer.from(encoded[1], 'base64').toString('utf8') : sent
}

export function sshCommands(env: E2EEnv, phase: 'start' | 'end' = 'start'): string[] {
  return sshCalls(env)
    .filter((c) => c.phase === phase)
    .map((c) => remoteCommandText(c.argv))
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

export function dropTabLinkWhileItsSessionDies(env: E2EEnv, pid: number): void {
  fs.writeFileSync(path.join(stateDir(env), 'tab-link-drop'), '')
  killSession(pid, env)
}

export function tmuxClientsOf(tmuxName: string): number[] {
  const lines = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  const named = new RegExp(`fake-tmux\\.js .*-[st] ${tmuxName}(\\s|$)`)
  return lines.filter((l) => named.test(l)).map((l) => Number(l.trim().split(/\s+/)[0]))
}

export function dropTabLinkWhileItsSessionLives(env: E2EEnv, tmuxName: string): void {
  fs.writeFileSync(path.join(stateDir(env), 'tab-link-drop'), '')
  for (const pid of tmuxClientsOf(tmuxName)) process.kill(pid, 'SIGKILL')
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

export function writeExec(file: string, body: string): void {
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
  const playwrightCliTheWrapperFindsSoItNeverReachesForNpm = path.dirname(
    path.join(
      machine,
      '.koloft',
      PLAYWRIGHT_CLI_UNDER_KOLOFT_HOME,
      PLAYWRIGHT_CLI_JS_UNDER_ITS_FOLDER
    )
  )
  fs.mkdirSync(path.dirname(playwrightCliTheWrapperFindsSoItNeverReachesForNpm), {
    recursive: true
  })
  // PLATFORM§62
  fs.rmSync(playwrightCliTheWrapperFindsSoItNeverReachesForNpm, { force: true, recursive: true })
  fs.symlinkSync(
    path.dirname(require.resolve('@playwright/cli/package.json')),
    playwrightCliTheWrapperFindsSoItNeverReachesForNpm
  )

  env.launchEnv.KOLOFT_FAKE_SSH_STATE = state
}

// AGY§3 AGY§5
export function installRemoteAgy(env: E2EEnv): void {
  const bin = path.join(machineHome(env), '.local', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'fake-agy.js'), path.join(bin, 'agy'))
  fs.chmodSync(path.join(bin, 'agy'), 0o755)
  const settings = path.join(machineHome(env), '.gemini', 'antigravity-cli', 'settings.json')
  fs.mkdirSync(path.dirname(settings), { recursive: true })
  fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [remoteDir(env)] }))
}

export function machineAgyCalls(env: E2EEnv): AgyCall[] {
  return agyCalls(env, machineHome(env)).filter(
    (c) => !c.argv.includes('-p') && !c.argv.includes('--version')
  )
}

export function machineAgyApiCalls(
  env: E2EEnv
): { method: string; body: unknown; authorized: boolean }[] {
  const file = path.join(machineHome(env), 'fake-agy-api.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; body: unknown; authorized: boolean })
}

export async function agyReady(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        for (const id of await termIds(page))
          if ((await terminalText(page, id)).includes('Antigravity CLI')) return true
        return false
      },
      { timeout: 90_000 }
    )
    .toBe(true)
}

export async function boundRemoteSession(
  page: Page,
  backend: BackendId
): Promise<{ tabId: string; id: string }> {
  let found: { tabId: string; id: string } | undefined
  await expect
    .poll(
      async () => {
        const all = await page.evaluate(() => window.api.sessions.list())
        const s = all.find(
          (x) => x.backendId === backend && x.remote && x.alive && x.nativeSessionId
        )
        found = s && { tabId: s.tabId, id: s.nativeSessionId! }
        return !!found
      },
      { timeout: 60_000 }
    )
    .toBe(true)
  return found!
}

export const MAC_CODEX_ACCESS_TOKEN = 'mac-access-token-for-the-machine'

export function installCodexOnFakeRemote(env: E2EEnv): void {
  installCodex(
    env,
    JSON.stringify({ tokens: { access_token: MAC_CODEX_ACCESS_TOKEN, account_id: 'mac-account' } })
  )
  const bin = path.join(machineHome(env), '.local', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  writeExec(
    path.join(bin, 'codex'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, '..', 'fixtures', 'fake-codex.js'))} "$@"\n`
  )
}

export function machineCodexLog<T>(env: E2EEnv, name: string): T[] {
  const file = path.join(machineHome(env), name)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

export function installMuseOnMachine(env: E2EEnv): void {
  const machine = machineHome(env)
  const bin = path.join(machine, '.local', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'fake-muse.js'), path.join(bin, 'muse'))
  fs.chmodSync(path.join(bin, 'muse'), 0o755)
  fs.mkdirSync(remoteDir(env), { recursive: true })
  const config = path.join(machine, '.config', 'muse')
  fs.mkdirSync(config, { recursive: true })
  fs.writeFileSync(
    path.join(config, 'trust.json'),
    JSON.stringify({
      schema_version: 1,
      projects: { [fs.realpathSync(remoteDir(env))]: { decision: 'trusted' } }
    })
  )
}

export interface MachineMuseCall {
  pid: number
  argv: string[]
  cwd: string
  sessionId: string
  configHome: string | null
  credentials: string | null
}

export function machineMuseCalls(env: E2EEnv): MachineMuseCall[] {
  const file = path.join(machineHome(env), 'fake-muse-calls.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MachineMuseCall)
}

export type OtherAgentName = Exclude<AgentName, 'Claude'>

export const OTHER_AGENTS_ON_THE_MACHINE: {
  label: OtherAgentName
  install: (env: E2EEnv) => void
  bound?: (page: Page) => Promise<unknown>
}[] = [
  { label: 'Codex', install: installCodexOnFakeRemote },
  {
    label: 'Muse',
    install: (env) => {
      installMuse(env)
      installMuseOnMachine(env)
    }
  },
  {
    label: 'Antigravity',
    install: (env) => {
      installAgy(env)
      installRemoteAgy(env)
    },
    bound: async (page) => {
      await agyReady(page)
      await runIn(page, centerTerm(page), 'first words')
      return boundRemoteSession(page, 'agy')
    }
  }
]

export function dropTmuxPassthrough(env: E2EEnv): void {
  fs.writeFileSync(path.join(stateDir(env), 'no-passthrough'), '')
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

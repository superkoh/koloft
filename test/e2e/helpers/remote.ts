import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp } from './app'
import type { E2EEnv } from './env'
import { encodeCwd, waitBooted } from './p1'

/**
 * The remote-workspace fixture: a whole "other machine" made of three Node scripts
 * (fixtures/fake-ssh.js, fake-tmux.js, fake-rsync.js) and one directory that plays its
 * home. Nothing here mocks a Koloft function — the product spawns real `ssh` and `rsync`
 * by bare name, types its real launch line into a real pty, and the real fake-claude
 * runs "over there"; only the wire between the two machines is fake.
 *
 * Read the header of fixtures/fake-ssh.js for what each ssh call does.
 *
 * WHERE THE FAKES GO — both dirs, because two different PATHs are in play and only one
 * is ours (the same reason env.ts installs the fake `security` twice):
 *  - `fakeBin` is first on the app's own PATH, so it wins for commands MAIN spawns
 *    (the heartbeat, the mirror pull, the kill).
 *  - `shimDir` is what Koloft re-pins in a pty after the login shell's path_helper has
 *    hoisted /usr/bin, so it wins for the launch line TYPED into the tab.
 *
 * WHERE THE REMOTE DIRECTORY IS — `<home>/fake-ssh/machine/proj`, an absolute path that
 * also happens to exist on this Mac. A path like `/home/koh/api` cannot be created here,
 * and the tab script really does `cd` into its workspace. The cost is that a product bug
 * which stat'd a remote path locally would not be caught by the `cd`; E-RW-01's "nothing
 * of this session is under the local ~/.claude/projects" assertion is what covers that
 * side instead.
 */

export const REMOTE_HOST = 'devbox'

/** the fake machine's home — its `~` for every command the fake ssh runs */
export function machineHome(env: E2EEnv): string {
  return path.join(env.home, 'fake-ssh', 'machine')
}

/** the absolute path ON THE MACHINE that the remote workspace points at */
export function remoteDir(env: E2EEnv): string {
  return path.join(machineHome(env), 'proj')
}

/** what the layout stores and the sidebar groups by: `ssh://<host><path>` */
export function remoteKey(env: E2EEnv): string {
  return `ssh://${REMOTE_HOST}${remoteDir(env)}`
}

/** the sidebar head's name for it — a remote workspace is named by its last segment */
export const REMOTE_WS_NAME = 'proj'

export function stateDir(env: E2EEnv): string {
  return path.join(env.home, 'fake-ssh')
}

/** where the mirror pull drops the machine's transcripts for this workspace */
export function mirrorProjectDir(env: E2EEnv): string {
  return path.join(env.userData, 'remote', REMOTE_HOST, 'projects', encodeCwd(remoteDir(env)))
}

export interface SshCall {
  argv: string[]
  phase: 'start' | 'end'
  exit?: number
  ts: number
}

/** Every ssh the app has run so far, start and end records alike. */
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

/** The remote command string of each ssh call (the last argv element). */
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

/** The tmux session names the machine currently has running (what the heartbeat sees). */
export function liveTmuxSessions(env: E2EEnv): string[] {
  const dir = path.join(stateDir(env), 'alive')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => {
    try {
      // an alive record is `{ pid, io }` — fixtures/fake-tmux.js says why the io key
      // is held apart from the name (a rename must not disturb a running attach)
      process.kill(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).pid as number, 0)
      return true
    } catch {
      return false
    }
  })
}

/** Cut the machine off: every background ssh and every rsync answers 255 from now on. */
export function breakConnection(env: E2EEnv): void {
  fs.writeFileSync(path.join(stateDir(env), 'hb-fail'), '')
}

export function healConnection(env: E2EEnv): void {
  fs.rmSync(path.join(stateDir(env), 'hb-fail'), { force: true })
}

/** The sentinel files fake-claude reads live under ITS home, which for a remote session
 *  is the machine's, not the test's. */
export function setNextRemoteSessionTitle(env: E2EEnv, title: string): void {
  fs.writeFileSync(path.join(machineHome(env), 'fake-claude-next-title'), title)
}

/** What the remote claude's statusline render produced, or null if it never ran. */
export function remoteStatuslineOut(env: E2EEnv): string | null {
  const f = path.join(machineHome(env), 'fake-claude-statusline.out')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
}

/** Add the fixture's remote workspace through the same IPC `addWorkspace` uses. */
export async function addRemoteWorkspace(
  page: Page,
  env: E2EEnv
): Promise<{ code: string; path?: string }> {
  return page.evaluate(
    (p) => window.api.workspace.add(p) as Promise<{ code: string; path?: string }>,
    remoteKey(env)
  )
}

/** Pin the remote workspace in layout.json BEFORE launch — the shape a user who already
 *  had this machine arrives in, and the only way a seeded transcript survives the first
 *  rescan's garbage collection (its mirror belongs to a workspace nobody has pinned yet). */
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

/**
 * Build the machine and put the fakes on both PATHs. Call BEFORE launchApp — the state
 * dir travels to the app in KOLOFT_FAKE_SSH_STATE, and argv/env is fixed at spawn.
 */
export function installFakeRemote(env: E2EEnv): void {
  const state = stateDir(env)
  const machine = machineHome(env)
  // `<machine>/.local/bin`, not a dir of our own: the tab script and ensure.sh both run
  // REMOTE_PATH_LINE, which prepends `$HOME/.local/bin:$HOME/.koloft/node/bin:/opt/homebrew/bin`
  // in front of whatever PATH the fake ssh handed them. Anywhere else and this Mac's own
  // Homebrew tmux wins — which is a REAL tmux server, shared across test runs, holding
  // sessions from other homes.
  const bin = path.join(machine, '.local', 'bin')
  for (const d of [state, bin, machine, remoteDir(env), path.join(machine, '.koloft')]) {
    fs.mkdirSync(d, { recursive: true })
  }

  const nodeBin = process.execPath
  const nodeDir = path.dirname(nodeBin)

  fs.writeFileSync(
    path.join(state, 'config.json'),
    JSON.stringify({
      machine,
      bin,
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

  // `ssh` and `rsync` have to be found in BOTH dirs (see the header)
  for (const dir of [env.fakeBin, env.shimDir]) {
    writeExec(path.join(dir, 'ssh'), shim('fake-ssh.js'))
    writeExec(path.join(dir, 'rsync'), shim('fake-rsync.js'))
  }
  // …and these only ever run ON the machine, on the PATH the fake ssh hands out
  writeExec(path.join(bin, 'tmux'), shim('fake-tmux.js'))
  writeExec(path.join(bin, 'rsync'), shim('fake-rsync.js'))
  fs.copyFileSync(path.join(fixtures, 'fake-claude.js'), path.join(bin, 'claude'))
  fs.chmodSync(path.join(bin, 'claude'), 0o755)

  // ensure.sh must find a node ≥20 where it would have installed one, so it never
  // reaches for curl or sudo: with all five checks passing it is a no-op
  const nodeHome = path.join(machine, '.koloft', 'node', 'bin')
  fs.mkdirSync(nodeHome, { recursive: true })
  writeExec(path.join(nodeHome, 'node'), `#!/bin/sh\nexec ${JSON.stringify(nodeBin)} "$@"\n`)

  env.launchEnv.KOLOFT_FAKE_SSH_STATE = state
}

/**
 * Build the machine, then launch a booted app against it. Every remote spec launches by
 * hand rather than through the `app` fixture: the fixture would start Electron before a
 * hook could install the fakes, and the fake ssh has to be on PATH from the first
 * heartbeat onwards.
 */
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

/**
 * End every "remote" claude this test started. The whole point of the fake tmux is that
 * those processes survive the app, so a spec that fails mid-way would otherwise leave
 * them running on the developer's Mac — the home dir goes, the pids do not.
 */
export function killFakeRemote(env: E2EEnv): void {
  // They all outlive the app: the "remote" claude is detached on purpose, and the
  // `ssh -tt` and the tmux attach under a closed tab's pty are not in that pty's process
  // group either, so they keep polling. Each carries this run's state dir in its argv, which is what makes them safe to match — a bare pid out of `alive/` would
  // not: nothing says the OS has not handed it to somebody else by now.
  const marker = stateDir(env)
  for (const line of execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }).split(
    '\n'
  )) {
    if (!line.includes(marker)) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (!pid || pid === process.pid) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

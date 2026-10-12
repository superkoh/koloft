import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { parseArgs } from 'util'
import {
  addCodexAccount,
  addKeychainEntry,
  seededAccount,
  seedSettings,
  setupE2EEnv,
  writeGitIdentity,
  type E2EEnv
} from '../e2e/helpers/env'
import {
  installLabSsh,
  installOnTarget,
  remoteKeyFor,
  runOnTarget,
  startSshLab,
  stopSshLab,
  type SshLab
} from '../e2e/helpers/docker'
import { writeExec } from '../e2e/helpers/remote'
import { defaultControlDir } from '../../src/main/remote/ssh'

const USAGE = `Starts a hidden dev build of Koloft with the real claude and codex, in a home of its own.

  npm run handtest -- start [--account <name>] [--port <n>] [--remote]
  npm run handtest -- menu <home> <menu item id>
  npm run handtest -- stop <home>

start prints JSON: the debug address to drive it with (playwright-cli attach --cdp=<cdp>),
its home, its workspaces, and the stop line. menu clicks an app-menu item (an id from
src/main/menu.ts, like command-palette), since the hidden window gets no real ⌘ keys.
stop quits it and deletes the home.
  --account  the Claude account from the installed Koloft's Settings ▸ Accounts it runs on
             (the first enabled one when left out)
  --remote   also start the Docker SSH lab with the real claude on it, as a remote workspace
             (a Linux claude from KOLOFT_SMOKE_CLAUDE_LINUX, or downloaded to match the local one)
Run npm run build first.`

const REPO = path.resolve(__dirname, '..', '..')
const MAIN_ENTRY = path.join(REPO, 'out', 'main', 'index.js')
const INSTALLED_PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'koloft')
const INSTALLED_KEYCHAIN_SERVICE = 'koloft-claude-oauth'
const DEV_BUILD_KEYCHAIN_SERVICE = 'koloft-dev-claude-oauth'
const STATE_FILE = 'handtest.json'
const DEFAULT_PORT = '9555'
const WINDOW_OPEN_DEADLINE_MS = 30_000
const QUIT_DEADLINE_MS = 20_000
const POLL_MS = 500
const USAGE_PROBE_THAT_TEST_MODE_TURNS_OFF = 'https://api.anthropic.com'
const LINUX_CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases'
const LINUX_ARCH: Record<string, string> = { aarch64: 'arm64', x86_64: 'x64' }
const LAB_USER = 'kuser'
const LAB_ALIAS = 'kt-key'
const GIT_ID = ['-c', 'user.email=handtest@koloft.test', '-c', 'user.name=handtest']

interface State {
  pid: number
  port: string
  lab?: SshLab
}

interface InstalledAccount {
  name: string
  kind: string
  enabled: boolean
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const mainInspectorPort = (port: string): number => Number(port) + 1

function installedSettings(): { accounts?: InstalledAccount[]; skipPermissions?: boolean } {
  return JSON.parse(fs.readFileSync(path.join(INSTALLED_PROFILE, 'settings.json'), 'utf8'))
}

function onLoginPath(name: string): string | undefined {
  const cleanEnv = { HOME: os.homedir(), USER: os.userInfo().username, PATH: '/usr/bin:/bin' }
  try {
    const found = execFileSync('/bin/zsh', ['-lc', `command -v ${name}`], {
      env: cleanEnv,
      encoding: 'utf8'
    }).trim()
    return found ? fs.realpathSync(found) : undefined
  } catch {
    return undefined
  }
}

function tokenOf(account: string): string {
  return execFileSync(
    'security',
    ['find-generic-password', '-s', INSTALLED_KEYCHAIN_SERVICE, '-a', account, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).replace(/\n$/, '')
}

function codexAuthOfTheInstalledApp(): string | undefined {
  const homes = path.join(INSTALLED_PROFILE, 'codex-homes')
  const own = fs.existsSync(homes)
    ? fs.readdirSync(homes).map((name) => path.join(homes, name, 'auth.json'))
    : []
  return [...own, path.join(os.homedir(), '.codex', 'auth.json')].find((f) => fs.existsSync(f))
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

function commitAll(env: E2EEnv, dir: string): void {
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'start']
  ])
    execFileSync('git', args, { cwd: dir, env: env.launchEnv })
}

function useRealClaude(env: E2EEnv, account: string): string {
  const claude = onLoginPath('claude')
  if (!claude) throw new Error('no claude on the login PATH')
  fs.rmSync(path.join(env.fakeBin, 'claude'))
  fs.symlinkSync(claude, path.join(env.fakeBin, 'claude'))
  fs.writeFileSync(env.keychainFile, '{}')
  fs.chmodSync(env.keychainFile, 0o600)
  addKeychainEntry(env, DEV_BUILD_KEYCHAIN_SERVICE, account, tokenOf(account))
  // CC§9
  fs.writeFileSync(
    path.join(env.home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: Object.fromEntries(
        Object.values(env.workspaces).map((dir) => [dir, { hasTrustDialogAccepted: true }])
      )
    })
  )
  return claude
}

// CODEX§15
function useRealCodex(env: E2EEnv): boolean {
  const codex = onLoginPath('codex')
  const auth = codexAuthOfTheInstalledApp()
  if (!codex || !auth) return false
  const wrapper = path.join(env.fakeBin, 'codex')
  writeExec(
    wrapper,
    `#!/bin/sh\n` +
      `if [ "$1" = "login" ] && [ "$2" != "status" ] && [ "$2" != "--device-auth" ]; then\n` +
      `  shift\n  exec '${codex}' login --device-auth "$@"\nfi\n` +
      `exec '${codex}' "$@"\n`
  )
  addCodexAccount(env, fs.readFileSync(auth, 'utf8'))
  for (const copy of fs.globSync(path.join(env.userData, 'codex-homes', '*', 'auth.json')))
    fs.chmodSync(copy, 0o600)
  const codexHome = path.join(env.home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  // CODEX§11
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    Object.values(env.workspaces)
      .map((dir) => `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`)
      .join('\n')
  )
  env.launchEnv.KOLOFT_CODEX_CMD = wrapper
  env.launchEnv.CODEX_HOME = codexHome
  fs.writeFileSync(path.join(env.home, '.zprofile'), `export PATH="${env.fakeBin}:$PATH"\n`)
  return true
}

async function linuxClaude(env: E2EEnv, localClaude: string): Promise<string> {
  const given = process.env.KOLOFT_SMOKE_CLAUDE_LINUX
  if (given && fs.existsSync(given)) return given
  const version = execFileSync(localClaude, ['--version'], { encoding: 'utf8' }).split(' ')[0]
  const machine = execFileSync('docker', ['info', '--format', '{{.Architecture}}'], {
    encoding: 'utf8'
  }).trim()
  const url = `${LINUX_CLAUDE_RELEASES}/${version}/linux-${LINUX_ARCH[machine] ?? machine}/claude`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const file = path.join(env.home, 'linux-claude')
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o755 })
  return file
}

async function startRemote(env: E2EEnv, localClaude: string): Promise<SshLab> {
  const binary = await linuxClaude(env, localClaude)
  const lab = await startSshLab(env)
  installLabSsh(env, lab)
  installOnTarget(lab, binary, '/usr/local/bin/claude')
  const project = `/home/${LAB_USER}/proj`
  // CC§9 CC§10
  runOnTarget(
    lab,
    LAB_USER,
    `printf '%s' ${JSON.stringify(
      JSON.stringify({
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        projects: { [project]: { hasTrustDialogAccepted: true } }
      })
    )} > .claude.json && cd proj && git init -q -b main && git add -A && ` +
      `git ${GIT_ID.join(' ')} commit -q -m start`
  )
  return lab
}

function writeLayout(env: E2EEnv, remote?: string): void {
  const workspaces = [...Object.values(env.workspaces), ...(remote ? [remote] : [])]
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({
      version: 6,
      workspaces: workspaces.map((p) => ({ path: p })),
      members: [],
      panels: {}
    })
  )
}

async function koloftPage(port: string): Promise<{ webSocketDebuggerUrl: string } | undefined> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string
    url: string
    webSocketDebuggerUrl: string
  }[]
  return targets.find((t) => t.type === 'page' && t.url.endsWith('/renderer/index.html'))
}

async function start(opt: { account?: string; port: string; remote: boolean }): Promise<void> {
  if (!fs.existsSync(MAIN_ENTRY)) throw new Error(`${MAIN_ENTRY} not found — run npm run build`)
  for (const port of [Number(opt.port), mainInspectorPort(opt.port)])
    if (!(await portIsFree(port))) throw new Error(`port ${port} is taken`)
  const installed = installedSettings()
  const account =
    opt.account ?? installed.accounts?.find((a) => a.kind === 'oauth' && a.enabled)?.name
  if (!account) throw new Error('the installed Koloft has no Claude account to lend')
  const env = setupE2EEnv()
  let lab: SshLab | undefined
  try {
    writeGitIdentity(env.home)
    for (const dir of Object.values(env.workspaces)) commitAll(env, dir)
    seedSettings(env, {
      onboardingSeen: true,
      multiAccount: true,
      skipPermissions: installed.skipPermissions ?? false,
      accounts: [seededAccount(account, 'oauth')]
    })
    const claude = useRealClaude(env, account)
    const codex = useRealCodex(env)
    if (opt.remote) lab = await startRemote(env, claude)
    const remote = lab ? remoteKeyFor(LAB_ALIAS, LAB_USER) : undefined
    writeLayout(env, remote)
    const log = path.join(env.home, 'koloft.log')
    const out = fs.openSync(log, 'a')
    const child = spawn(
      require('electron') as unknown as string,
      [
        MAIN_ENTRY,
        `--user-data-dir=${env.userData}`,
        `--remote-debugging-port=${opt.port}`,
        `--inspect=127.0.0.1:${mainInspectorPort(opt.port)}`,
        ...env.extraArgs
      ],
      {
        cwd: REPO,
        env: { ...env.launchEnv, KOLOFT_PROBE_BASE_URL: USAGE_PROBE_THAT_TEST_MODE_TURNS_OFF },
        detached: true,
        stdio: ['ignore', out, out]
      }
    )
    child.unref()
    const state: State = { pid: child.pid!, port: opt.port, lab }
    fs.writeFileSync(path.join(env.home, STATE_FILE), JSON.stringify(state))
    const deadline = Date.now() + WINDOW_OPEN_DEADLINE_MS
    while (!(await koloftPage(opt.port).catch(() => undefined))) {
      if (Date.now() > deadline) throw new Error(`Koloft did not open its window — see ${log}`)
      await wait(POLL_MS)
    }
    console.log(
      JSON.stringify(
        {
          cdp: `http://127.0.0.1:${opt.port}`,
          home: env.home,
          account,
          codex,
          workspaces: { ...env.workspaces, ...(remote ? { remote } : {}) },
          log,
          stop: `npm run handtest -- stop ${env.home}`
        },
        null,
        2
      )
    )
  } catch (err) {
    await stop(env.home).catch(() => undefined)
    throw err
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function processesUnder(home: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', home], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map(Number)
      .filter((pid) => pid && pid !== process.pid)
  } catch {
    return []
  }
}

async function evaluate(webSocketDebuggerUrl: string, expression: string): Promise<unknown> {
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const answer = new Promise<unknown>((resolve) => {
    ws.onmessage = (m) => resolve(JSON.parse(String(m.data)))
    setTimeout(resolve, QUIT_DEADLINE_MS)
  })
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }))
  const result = await answer
  ws.close()
  return result
}

async function approveQuit(port: string): Promise<void> {
  const page = await koloftPage(port)
  if (page) await evaluate(page.webSocketDebuggerUrl, 'window.api.app.approveQuit()')
}

function readState(home: string): State | undefined {
  const file = path.join(home, STATE_FILE)
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as State) : undefined
}

async function clickMenuItem(home: string, id: string): Promise<void> {
  const state = readState(home)
  if (!state) throw new Error(`no sandbox in ${home}`)
  const [main] = (await (
    await fetch(`http://127.0.0.1:${mainInspectorPort(state.port)}/json/list`)
  ).json()) as { webSocketDebuggerUrl: string }[]
  const clicked = `process.mainModule.require('electron').Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)}).click()`
  console.log(JSON.stringify(await evaluate(main.webSocketDebuggerUrl, clicked)))
}

async function stop(home: string): Promise<void> {
  const state = readState(home)
  if (state) {
    await approveQuit(state.port).catch(() => undefined)
    const deadline = Date.now() + QUIT_DEADLINE_MS
    while (alive(state.pid) && Date.now() < deadline) await wait(POLL_MS)
  }
  for (const pid of processesUnder(home)) process.kill(pid, 'SIGKILL')
  if (state?.lab) stopSshLab(state.lab, defaultControlDir())
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  console.log(JSON.stringify({ stopped: home, left: processesUnder(home) }))
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    account: { type: 'string' },
    port: { type: 'string', default: DEFAULT_PORT },
    remote: { type: 'boolean', default: false }
  }
})

const [command, home, menuItem] = positionals
if (command === 'start') {
  await start({ account: values.account, port: values.port!, remote: values.remote! })
} else if (command === 'stop' && home) {
  await stop(home)
} else if (command === 'menu' && home && menuItem) {
  await clickMenuItem(home, menuItem)
} else {
  console.error(USAGE)
  process.exit(2)
}

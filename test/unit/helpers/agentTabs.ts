import fs from 'fs'
import os from 'os'
import path from 'path'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import { AgySessions, type AgySessionDeps } from '../../../src/agents/agy/main/agySessions'
import { ClaudeBackend, type ClaudeBackendDeps } from '../../../src/agents/claude/main/backend'
import { trustCodexFolder } from '../../../src/agents/codex/main/backend'
import { CodexSessions, type CodexSessionDeps } from '../../../src/agents/codex/main/codexSessions'
import { SessionRuntime } from '../../../src/core/agent/sessionRuntime'
import { GithubRepos } from '../../../src/main/githubRepos'
import type { RemoteTab } from '../../../src/main/host/host'
import { Hosts } from '../../../src/main/host/hosts'
import { localHost } from '../../../src/main/host/localHost'
import { SshHost, type MachineAccount } from '../../../src/main/host/sshHost'
import type { BytesResult } from '../../../src/main/remote/ssh'

export const MACHINE = 'devbox'
export const MACHINE_PACKAGE = 'm-0000000000000000'
export const MACHINE_FOLDER = '/home/me/proj'
export const ON_THE_MACHINE = `ssh://${MACHINE}${MACHINE_FOLDER}`
export const LOGIN_PATH_ON_THE_MACHINE = '/opt/login-shell/bin:/home/linuxbrew/.linuxbrew/bin'

export interface World {
  home: string
  repo: string
  regDir: string
  userData: string
  controlDir: string
  gone(): void
}

export function makeWorld(): World {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-agent-tabs-')))
  const homeBefore = process.env.HOME
  process.env.HOME = home
  const world = {
    home,
    repo: path.join(home, 'repo'),
    regDir: path.join(home, 'hook-sessions'),
    userData: path.join(home, 'userData'),
    controlDir: path.join(home, 'ssh-control')
  }
  for (const dir of [world.repo, world.regDir, world.userData]) fs.mkdirSync(dir)
  return {
    ...world,
    gone: () => {
      process.env.HOME = homeBefore
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
}

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ONE_TIME_TOKEN = /--csrf_token=[0-9a-f]{48}/g
const TAB_PASS = /KOLOFT_TAB_PASS=[A-Za-z0-9_-]+/g
const TOOL_FOLDER_OF_ONE_TAB = /\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

export const sameOnEveryRun = (text: string, world: World): string =>
  text
    .replaceAll(world.home, '<home>')
    .replace(TOOL_FOLDER_OF_ONE_TAB, '<tool folder of this tab>')
    .replace(SESSION_ID, '<session id>')
    .replace(ONE_TIME_TOKEN, '--csrf_token=<token>')
    .replace(TAB_PASS, 'KOLOFT_TAB_PASS=<pass>')

export function filesUnder(dir: string, pinnedElsewhere?: { name: RegExp; where: string }): string {
  if (!fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .sort()
    .map((rel) => path.join(dir, rel))
    .filter((p) => fs.statSync(p).isFile())
    .map((p) => {
      const name = path.basename(p)
      const text = pinnedElsewhere?.name.test(name)
        ? `(its text is pinned in ${pinnedElsewhere.where})`
        : fs.readFileSync(p, 'utf8')
      return `=== file ${name} ===\n${text}`
    })
    .join('\n')
}

export const standInForKoloftsPrompt = (backend: string, rules?: string): string =>
  `<Koloft's "prompt" for ${backend}${rules ? ', with the project rules' : ''}>`

type SshRun = (cmd: string, opts?: { timeoutMs?: number; input?: Buffer }) => Promise<BytesResult>

const SCRIPT_IT_CARRIES = / ([A-Za-z0-9+/]+={0,2})$/

function readableCommand(cmd: string, input?: Buffer): string {
  const script = SCRIPT_IT_CARRIES.exec(cmd)
  const text = script
    ? `${cmd.slice(0, script.index)} <base64 of the script below>\n${Buffer.from(script[1], 'base64').toString('utf8')}`
    : cmd
  return input ? `${text}\n--- its stdin ---\n${input.toString('utf8')}` : text
}

export interface RecordedSsh {
  ran: string[]
  run: SshRun
}

export function recordingSsh(
  answer: (readable: string) => Partial<BytesResult> = () => ({})
): RecordedSsh {
  const ran: string[] = []
  return {
    ran,
    run: async (cmd, opts) => {
      const readable = readableCommand(cmd, opts?.input)
      ran.push(readable)
      return { code: 0, stdout: Buffer.from(''), stderr: '', ...answer(readable) }
    }
  }
}

export interface TabStarted {
  id: string
  typedLine?: string
  executable?: string
  argv?: string[]
  shell?: string
  cwd: string
  setupCommand?: string
  extraEnv?: Record<string, string | undefined>
  envSetForThisTab?: Record<string, string>
}

interface PtyCreateArgs {
  id?: string
  launchCommand?: string | ((id: string) => string)
  koloftShim: false | { hookSettings(tabId: string): string | undefined }
  executable?: string
  argv?: string[]
  shell?: string
  cwd: string
  setupCommand?: string
  extraEnv?: Record<string, string | undefined>
  envSetForThisTab?: Record<string, string>
}

export function recordingPty(tabId: string): { started: TabStarted[]; pty: unknown } {
  const started: TabStarted[] = []
  return {
    started,
    pty: {
      nextId: () => tabId,
      create: (args: PtyCreateArgs) => {
        const id = args.id ?? tabId
        const typedLine =
          typeof args.launchCommand === 'function' ? args.launchCommand(id) : args.launchCommand
        if (args.koloftShim) args.koloftShim.hookSettings(id)
        started.push({
          id,
          typedLine,
          executable: args.executable,
          argv: args.argv,
          shell: args.shell,
          cwd: args.cwd,
          setupCommand: args.setupCommand,
          extraEnv: args.extraEnv,
          envSetForThisTab: args.envSetForThisTab
        })
        return { id, startedAt: 0 }
      },
      get: () => undefined,
      pidOf: () => undefined,
      kill: () => {},
      on: () => {},
      write: () => {},
      type: async () => true,
      wakeReady: () => {},
      clearResumeIntent: () => {}
    }
  }
}

export interface MachineSetup {
  run: SshRun
  alive?: () => ReadonlySet<string>
  firstHeartbeatDone?: () => Promise<void>
  pickAccount?: () => Promise<MachineAccount | undefined>
  noAccountMessage?: () => string
  loginPath?: () => Promise<string>
  agentTools?: boolean
  machinePackageName?: () => string
  hookSettings?: (
    tabId: string,
    machineDir: string,
    allowKoloft: boolean
  ) => Record<string, unknown>
}

export function machineIn(world: World, name: string, m: MachineSetup): SshHost {
  return new SshHost(name, {
    run: m.run,
    shell: () => ({ spawnCwd: '/' }),
    watch: () => {},
    unwatch: () => {},
    github: {},
    claude: {
      userData: world.userData,
      controlDir: world.controlDir,
      machinePackage: () => ({
        dir: world.home,
        name: m.machinePackageName?.() ?? MACHINE_PACKAGE
      }),
      alive: m.alive ?? (() => new Set()),
      firstHeartbeatDone: m.firstHeartbeatDone ?? (async () => {}),
      realPath: (p) => p,
      settings: () => ({ skipPermissions: false }),
      agentTools: () => m.agentTools ?? true,
      pickAccount: m.pickAccount ?? (async () => ({ env: {}, banner: '' })),
      noAccountMessage: m.noAccountMessage ?? (() => NO_USABLE_ACCOUNT.claude),
      hookSettings: m.hookSettings ?? (() => ({})),
      loginPath: m.loginPath ?? (async () => '')
    }
  })
}

export interface ClaudeSetup {
  machine: MachineSetup
  withPlugin?: boolean
  projectRules?: string
  remoteTab?: RemoteTab
}

export function claudeBackendIn(world: World, pty: unknown, c: ClaudeSetup): ClaudeBackend {
  return new ClaudeBackend({
    pty,
    tracker: {
      track: () => {},
      movePick: () => {},
      bindSession: () => {},
      untrack: () => {},
      list: () => [],
      infoOf: () => undefined,
      remoteOf: () => c.remoteTab
    },
    hosts: new Hosts(
      localHost(new GithubRepos(), {
        hookRegDir: () => world.regDir,
        agentPlugin: () =>
          c.withPlugin === false ? undefined : path.join(world.home, 'koloft', 'agent-plugin'),
        docsPlugin: () => path.join(world.home, 'koloft', 'docs-plugin'),
        assistOf: () => undefined,
        agentHomes: () => ({ codexHome: '/nowhere' }),
        pastedPicturesDir: () => path.join(world.userData, 'palette-pictures')
      }),
      (machine) => machineIn(world, machine, c.machine)
    ),
    workspaces: () => null,
    remoteSync: () => null,
    userData: () => world.userData,
    setupLine: () => undefined,
    hookSettings: () => undefined,
    playwrightMcp: async () => [],
    ptysChanged: () => {},
    events: () => {},
    error: () => {},
    projectRules: async () => c.projectRules
  } as unknown as ClaudeBackendDeps)
}

export interface AgySetup {
  machine: MachineSetup
  agentTools?: boolean
  apiKey?: string
  signedInOnTheWeb?: boolean
}

export function agySessionsIn(world: World, pty: unknown, a: AgySetup): AgySessions {
  const accountHome = path.join(world.home, 'agy-homes', 'work')
  const tools = path.join(world.home, 'tools')
  fs.mkdirSync(tools, { recursive: true })
  for (const tool of ['playwright-cli', 'gh']) fs.writeFileSync(path.join(tools, tool), '')
  const mirror = path.join(world.home, 'mirror-hooks')
  fs.mkdirSync(mirror, { recursive: true })
  if (a.signedInOnTheWeb) {
    const own = path.join(accountHome, 'antigravity-cli')
    fs.mkdirSync(path.join(own, 'cache'), { recursive: true })
    fs.writeFileSync(path.join(own, 'antigravity-oauth-token'), '{"token":"web-sign-in"}')
    fs.writeFileSync(path.join(own, 'cache', 'onboarding.json'), '{"done":true}')
  }
  const machines = new Map<string, SshHost>()
  const machine = (name: string): SshHost => {
    if (!machines.has(name)) machines.set(name, machineIn(world, name, a.machine))
    return machines.get(name)!
  }
  const alive = a.machine.alive ?? (() => new Set<string>())
  let sessions: AgySessions | undefined
  const deps: AgySessionDeps = {
    pty: pty as AgySessionDeps['pty'],
    runtime: new SessionRuntime(),
    projectInfo: (p) => ({
      root: p.startsWith('ssh://') ? ON_THE_MACHINE : world.repo,
      treeRoot: p
    }),
    remoteDirExists: async () => true,
    changed: () => {},
    events: (tabId, event) => sessions?.observe(tabId, event),
    error: () => {},
    noAccountMessage: (backend) => NO_USABLE_ACCOUNT[backend],
    koloftPrompt: standInForKoloftsPrompt,
    hookRegDir: world.regDir,
    openShimRoot: path.join(world.home, 'agy-open'),
    scriptsDir: path.join(world.home, 'scripts'),
    ownersGemini: () => path.join(world.home, '.gemini'),
    pickHome: () => ({ account: 'work', home: accountHome }),
    apiKeyOf: async () => a.apiKey,
    playwrightBin: tools,
    browserEndpoint: () => '',
    builtInStatusLine: () => undefined,
    skipPermissions: () => false,
    assistOf: () => undefined,
    agent: { enabled: () => a.agentTools ?? false, answer: () => {} },
    gitAccounts: { configEnv: (env) => env, ghWrapper: path.join(tools, 'gh') },
    remote: {
      machine,
      hosts: () => [MACHINE],
      keyed: (host, p) => `ssh://${host}${p}`,
      mirrorDir: () => mirror,
      mirrorGemini: () => path.join(world.home, 'mirror-gemini'),
      gone: (_host, id) => !alive().has(id),
      connected: () => true,
      nextPull: async () => undefined,
      setupLine: () => undefined,
      hookSettings: () => undefined,
      machineName: () => a.machine.machinePackageName?.() ?? MACHINE_PACKAGE
    }
  }
  sessions = new AgySessions(path.join(world.home, 'agy-sessions.json'), deps)
  return sessions
}

export interface CodexSetup {
  run(machine: string, readable: string): { code: number | null; stdout: string; stderr: string }
  ranOnTheMachine: string[]
  agentTools?: boolean
}

export function codexSessionsIn(world: World, pty: unknown, c: CodexSetup): CodexSessions {
  const tabDirs = path.join(world.userData, 'remote', 'tabs')
  return new CodexSessions(path.join(world.home, 'sessions.json'), {
    pty: pty as CodexSessionDeps['pty'],
    runtime: new SessionRuntime(),
    projectInfo: (p) => ({
      root: p.startsWith('ssh://') ? ON_THE_MACHINE : world.repo,
      treeRoot: p
    }),
    remoteDirExists: async () => true,
    machine: {
      instance: 'table-instance',
      ready: async () => {},
      run: async (machine, cmd) => {
        const readable = readableCommand(cmd)
        c.ranOnTheMachine.push(readable)
        return c.run(machine, readable)
      },
      sshArgs: (_machine, background) =>
        [
          '-o',
          `ControlPath=${world.controlDir}/%C`,
          background ? '-o' : '',
          background ? 'BatchMode=yes' : ''
        ].filter(Boolean),
      machinePackage: () => ({ dir: world.home, name: MACHINE_PACKAGE }),
      tabDir: (tabId) => path.join(tabDirs, tabId),
      fileExists: async () => false,
      keyed: (machine, p) => `ssh://${machine}${p}`,
      mirrorDir: () => path.join(world.home, 'mirror-hooks'),
      nextPull: async () => {},
      loginPath: async () => LOGIN_PATH_ON_THE_MACHINE
    },
    changed: () => {},
    events: () => {},
    error: () => {},
    noAccountMessage: (backend) => NO_USABLE_ACCOUNT[backend],
    koloftPrompt: standInForKoloftsPrompt,
    hookRegDir: world.regDir,
    trustFolder: trustCodexFolder,
    pickHome: () => ({ account: 'work', home: path.join(world.home, 'codex-home') }),
    homeOf: () => undefined,
    assistOf: () => undefined,
    replyLanguageScript: '/koloft/codex-reply-language.sh',
    builtInStatusLine: () => true,
    browserEndpoint: () => '',
    openShimRoot: path.join(world.home, 'codex-open'),
    playwrightBin: path.join(world.home, 'commands', 'bin'),
    docsSkillsFolder: () => '/koloft/docs-plugin/skills',
    agent: { enabled: () => c.agentTools ?? true, answer: () => {}, skillsFolder: () => undefined },
    gitAccounts: {
      configEnv: (env) => env,
      ghWrapper: path.join(world.home, 'shim', 'gh')
    }
  })
}

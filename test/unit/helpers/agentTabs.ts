import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import type { SessionEvent } from '@shared/sessionEvent'
import { docsWritingOn } from '@plugins/docs-writing/api'
import {
  saidFile,
  seedHandedOverOwnerWords,
  writeConductorMarker
} from '@plugins/sessions/main/hooks'
import { AgySessions, type AgySessionDeps } from '../../../src/agents/agy/main/agySessions'
import { ClaudeBackend, type ClaudeBackendDeps } from '../../../src/agents/claude/main/backend'
import type { MachineAccount } from '../../../src/agents/claude/main/claudeLaunch'
import { CodexSessions, type CodexSessionDeps } from '../../../src/agents/codex/main/codexSessions'
import { SessionRuntime } from '../../../src/core/agent/sessionRuntime'
import { BackgroundFile } from '../../../src/main/backgroundFile'
import { GithubRepos } from '../../../src/main/githubRepos'
import type { RemoteTab } from '../../../src/main/host/host'
import { Hosts } from '../../../src/main/host/hosts'
import { localHost } from '../../../src/main/host/localHost'
import { SIGN_IN_THROUGH_A_TAB_THAT_CAN_ASK_FIRST, SshHost } from '../../../src/main/host/sshHost'
import { answerOf, type BytesResult } from '../../../src/main/remote/ssh'
import { tabPushed } from '../../../src/main/remote/launch'
import { standInMachine, type MachineSaid } from './standInMachine'

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
  gone(): Promise<void>
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
    gone: async () => {
      try {
        await BackgroundFile.whenAllWritten()
      } finally {
        process.env.HOME = homeBefore
        fs.rmSync(home, { recursive: true, force: true })
      }
    }
  }
}

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ONE_TIME_TOKEN = /--csrf_token=[0-9a-f]{48}/g
const TAB_PASS = /KOLOFT_TAB_PASS=[A-Za-z0-9_-]+/g
const TOOL_FOLDER_OF_ONE_TAB = /\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const PROMPT_FILE_NAMED_BY_ITS_TEXT = /agent-prompts\/[0-9a-f]{16}\.md/g

export const sameOnEveryRun = (text: string, world: World): string =>
  text
    .replaceAll(world.home, '<home>')
    .replace(TOOL_FOLDER_OF_ONE_TAB, '<tool folder of this tab>')
    .replace(PROMPT_FILE_NAMED_BY_ITS_TEXT, 'agent-prompts/<hash of the prompt text>.md')
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

export function shellOnThisMacAsTheMachine(
  machineHome: () => string,
  loginShell: () => string
): SshRun {
  return (cmd, opts) =>
    new Promise((resolve) => {
      const c = spawn(loginShell(), ['-c', cmd], {
        env: { HOME: machineHome(), PATH: '/usr/bin:/bin' },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const out: Buffer[] = []
      let err = ''
      c.stdout.on('data', (d: Buffer) => out.push(d))
      c.stderr.on('data', (d: Buffer) => (err += String(d)))
      c.on('close', (code) =>
        resolve({ code, stdout: answerOf(cmd, Buffer.concat(out)), stderr: err })
      )
      c.stdin.on('error', () => {})
      c.stdin.end(opts?.input)
    })
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
  pickAccount?: (launchKey: string, resumeSessionId?: string) => Promise<MachineAccount | undefined>
  noAccountMessage?: () => string
  loginPath?: () => Promise<string>
  agentTools?: boolean
  skipPermissions?: boolean
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
    tabs: {
      userData: world.userData,
      controlDir: world.controlDir,
      machinePackage: () => ({
        dir: world.home,
        name: m.machinePackageName?.() ?? MACHINE_PACKAGE
      }),
      alive: m.alive ?? (() => new Set()),
      firstHeartbeatDone: m.firstHeartbeatDone ?? (async () => {}),
      loginPath: m.loginPath ?? (async () => '')
    }
  })
}

export interface ClaudeSetup {
  machine: MachineSetup
  withPlugin?: boolean
  projectRules?: string
  remoteTab?: RemoteTab
  workspaceOfEverySession?: string
  tracker?: Partial<ClaudeBackendDeps['tracker']>
  events?: ClaudeBackendDeps['events']
  hookSettings?: ClaudeBackendDeps['hookSettings']
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
      remoteOf: () => c.remoteTab,
      ...c.tracker
    },
    hosts: new Hosts(
      localHost(new GithubRepos(), { agentHomes: () => ({ codexHome: '/nowhere' }) }),
      (machine) => machineIn(world, machine, c.machine)
    ),
    launchHere: {
      writeConductorMarker: (tabId: string, role: string) =>
        writeConductorMarker(world.regDir, tabId, role),
      handOverOwnerWords: (tabId: string, words: string) =>
        seedHandedOverOwnerWords(saidFile(world.regDir, tabId), words),
      agentPlugin: () =>
        c.withPlugin === false ? undefined : path.join(world.home, 'koloft', 'agent-plugin'),
      docsPlugin: () => path.join(world.home, 'koloft', 'docs-plugin'),
      assistOf: () => undefined,
      pastedPicturesDir: () => path.join(world.userData, 'palette-pictures')
    },
    launchOnMachine: {
      realPath: (_machine: string, p: string) => p,
      settings: () => ({ skipPermissions: c.machine.skipPermissions ?? false }),
      agentTools: () => c.machine.agentTools ?? true,
      docsWritingOn,
      pickAccount: c.machine.pickAccount ?? (async () => ({ env: {}, banner: '' })),
      noAccountMessage: c.machine.noAccountMessage ?? (() => NO_USABLE_ACCOUNT.claude),
      hookSettings: c.machine.hookSettings ?? (() => ({}))
    },
    store: () =>
      c.workspaceOfEverySession ? { workspaceOf: () => c.workspaceOfEverySession } : null,
    remoteSync: () => null,
    userData: () => world.userData,
    setupLine: () => undefined,
    hookSettings: c.hookSettings ?? (() => undefined),
    playwrightMcp: async () => [],
    ptysChanged: () => {},
    events: c.events ?? (() => {}),
    error: () => {},
    projectRules: async () => c.projectRules
  } as unknown as ClaudeBackendDeps)
}

export interface WiredIntoTheApp {
  runtime?: SessionRuntime
  changed?: () => void
  pinnedWorkspaces?: () => string[]
  rereadRows?: () => void
  rootOf?: (dir: string) => string
}

export interface AgySetup extends WiredIntoTheApp {
  machine: MachineSetup
  agentTools?: boolean
  apiKey?: string
  signedInOnTheWeb?: boolean
  builtInStatusLine?: string
  events?: (tabId: string, event: SessionEvent) => void
  runtime?: SessionRuntime
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
    runtime: a.runtime ?? new SessionRuntime(),
    projectInfo: (p) => ({
      root: p.startsWith('ssh://') ? ON_THE_MACHINE : (a.rootOf?.(p) ?? world.repo),
      treeRoot: p
    }),
    remoteDirExists: async () => true,
    changed: () => a.changed?.(),
    pinnedWorkspaces: () => a.pinnedWorkspaces?.() ?? [],
    rereadRows: () => a.rereadRows?.(),
    events: (tabId, event) => {
      a.events?.(tabId, event)
      sessions?.observe(tabId, event)
    },
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
    builtInStatusLine: () => a.builtInStatusLine,
    skipPermissions: () => false,
    assistOf: () => undefined,
    agent: { enabled: () => a.agentTools ?? false, answer: () => {} },
    gitAccounts: { configEnv: (env) => env, ghWrapper: path.join(tools, 'gh') },
    remote: {
      machine,
      saidWhenTheMachineWantsAPasswordFirst: SIGN_IN_THROUGH_A_TAB_THAT_CAN_ASK_FIRST,
      hosts: () => [MACHINE],
      keyed: (host, p) => `ssh://${host}${p}`,
      mirrorDir: () => mirror,
      mirrorGemini: () => path.join(world.home, 'mirror-gemini'),
      gone: (_host, id) => !alive().has(id),
      connected: () => true,
      nextPull: async () => undefined,
      setupLine: () => undefined,
      hookSettings: () => undefined
    }
  }
  sessions = new AgySessions(path.join(world.home, 'agy-sessions.json'), deps)
  return sessions
}

export interface CodexSetup extends WiredIntoTheApp {
  run(machine: string, readable: string): MachineSaid
  ranOnTheMachine: string[]
  agentTools?: boolean
  builtInStatusLine?: boolean
  events?: (tabId: string, event: SessionEvent) => void
  runtime?: SessionRuntime
}

export function codexSessionsIn(world: World, pty: unknown, c: CodexSetup): CodexSessions {
  const tabDirs = path.join(world.userData, 'remote', 'tabs')
  const sshArgs = (background: boolean): string[] =>
    [
      '-o',
      `ControlPath=${world.controlDir}/%C`,
      background ? '-o' : '',
      background ? 'BatchMode=yes' : ''
    ].filter(Boolean)
  return new CodexSessions(path.join(world.home, 'sessions.json'), {
    pty: pty as CodexSessionDeps['pty'],
    runtime: c.runtime ?? new SessionRuntime(),
    projectInfo: (p) => ({
      root: p.startsWith('ssh://') ? ON_THE_MACHINE : (c.rootOf?.(p) ?? world.repo),
      treeRoot: p
    }),
    remoteDirExists: async () => true,
    machine: {
      instance: 'table-instance',
      machine: (name) =>
        standInMachine(name, {
          run: (cmd) => {
            const readable = readableCommand(cmd)
            c.ranOnTheMachine.push(readable)
            return c.run(name, readable)
          },
          sshArgs,
          packageName: MACHINE_PACKAGE,
          tabFiles: (tabId) => {
            const dir = path.join(tabDirs, tabId)
            return {
              dir,
              pushedLine: () =>
                tabPushed({
                  host: name,
                  sshOptions: sshArgs(false),
                  machine: { dir: world.home, name: MACHINE_PACKAGE },
                  tabId,
                  tabDir: dir
                })
            }
          },
          loginPath: async () => LOGIN_PATH_ON_THE_MACHINE
        }),
      keyed: (machine, p) => `ssh://${machine}${p}`,
      mirrorDir: () => path.join(world.home, 'mirror-hooks'),
      nextPull: async () => {}
    },
    changed: () => c.changed?.(),
    pinnedWorkspaces: () => c.pinnedWorkspaces?.() ?? [],
    rereadRows: () => c.rereadRows?.(),
    events: (tabId, event) => c.events?.(tabId, event),
    error: () => {},
    noAccountMessage: (backend) => NO_USABLE_ACCOUNT[backend],
    koloftPrompt: standInForKoloftsPrompt,
    hookRegDir: world.regDir,
    pickHome: () => ({ account: 'work', home: path.join(world.home, 'codex-home') }),
    homeOf: () => undefined,
    assistOf: () => undefined,
    replyLanguageScript: '/koloft/codex-reply-language.sh',
    builtInStatusLine: () => c.builtInStatusLine ?? true,
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { seedRepo } from './helpers/gitShim'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-tab-launch-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

const codex = vi.hoisted(() => ({
  transports: [] as { sessionEnv?: Record<string, string>; configOverrides?: string[] }[]
}))
vi.mock('../../src/main/codexRuntime', () => ({
  resolveCodexRuntime: async () => ({
    binary: '/fixture/codex',
    env: {},
    version: '999.0.0',
    verified: true
  }),
  updateCodex: async () => {}
}))
vi.mock('../../src/main/codexTransport', () => ({
  createCodexTransport: async (options: (typeof codex.transports)[number]) => {
    codex.transports.push(options)
    return { url: 'unix:///test/rpc.sock', stop: async () => {}, request: async () => ({}) }
  },
  CodexRpc: class {
    request = async (method: string, params: { cwds?: string[] }) =>
      method === 'hooks/list'
        ? {
            data: (params.cwds ?? []).map((cwd) => ({
              cwd,
              hooks: [],
              warnings: [],
              errors: []
            }))
          }
        : { data: [], nextCursor: null }
    close = async () => {}
  }
}))

import { barePath } from '@shared/remoteKey'
import type { CreateTabOptions } from '@shared/types'
import { portOffset } from '@shared/worktreeName'
import { ClaudeBackend, type ClaudeBackendDeps } from '../../src/main/backends/claude'
import { BackgroundFile } from '../../src/main/backgroundFile'
import { CodexSessions, type CodexSessionDeps } from '../../src/main/codexSessions'
import { GithubLookup } from '../../src/main/github'
import type { ClaudeLaunch } from '../../src/main/host/host'
import { Hosts } from '../../src/main/host/hosts'
import { localHost } from '../../src/main/host/localHost'
import { SshHost } from '../../src/main/host/sshHost'
import { SessionRuntime } from '../../src/main/sessionRuntime'
import type { TreeIo } from '../../src/main/sessionWorktrees'

const execFileAsync = promisify(execFile)
const TAB = 'pty-t1'
const MACHINE = 'devbox'
let home: string
let realHome: string | undefined
let repo: string
let regDir: string
let userData: string

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-tab-launch-')))
  realHome = process.env.HOME
  process.env.HOME = home
  repo = path.join(home, 'repo')
  regDir = path.join(home, 'hook-sessions')
  userData = path.join(home, 'userData')
  for (const dir of [repo, regDir, userData]) fs.mkdirSync(dir)
  codex.transports.length = 0
})

afterEach(async () => {
  process.env.HOME = realHome
  await BackgroundFile.whenAllWritten()
  fs.rmSync(home, { recursive: true, force: true })
})

function filesUnder(dir: string): string {
  if (!fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => path.join(dir, rel))
    .filter((p) => fs.statSync(p).isFile())
    .map((p) => `${path.basename(p)}: ${fs.readFileSync(p, 'utf8')}`)
    .join('\n')
}

async function claudeTab(
  cwd: string,
  spec: Partial<CreateTabOptions>,
  withPlugin = true
): Promise<string> {
  let handed = ''
  let conductor: boolean | undefined
  let allowKoloft: boolean | undefined
  const backend = new ClaudeBackend({
    pty: {
      create: (args: Parameters<ClaudeBackendDeps['pty']['create']>[0]) => {
        const command =
          typeof args.launchCommand === 'function' ? args.launchCommand(TAB) : args.launchCommand
        if (args.koloftShim) args.koloftShim.hookSettings(TAB)
        handed = `${command}\n${JSON.stringify({ conductor, allowKoloft, env: args.extraEnv })}`
        return { id: TAB }
      }
    },
    tracker: { track: () => {}, movePick: () => {}, list: () => [] },
    hosts: new Hosts(
      localHost(new GithubLookup(), {
        hookRegDir: () => regDir,
        agentPlugin: () => (withPlugin ? '/koloft/agent-plugin' : undefined),
        assistOf: () => undefined
      }),
      (machine) =>
        new SshHost(machine, {
          run: async () => ({ code: 0, stdout: Buffer.from(''), stderr: '' }),
          shell: () => ({ spawnCwd: '/' }),
          watch: () => {},
          unwatch: () => {},
          github: {},
          claude: {
            userData,
            controlDir: path.join(home, 'ssh-control'),
            machinePackage: () => ({ dir: home, name: 'm-0000000000000000' }),
            alive: () => new Set(),
            firstHeartbeatDone: async () => {},
            realPath: (p) => p,
            settings: () => ({ skipPermissions: false }),
            agentTools: () => true,
            pickAccount: async () => ({ env: {}, banner: '' }),
            hookSettings: () => ({})
          }
        })
    ),
    workspaces: () => null,
    remoteSync: () => null,
    userData: () => userData,
    setupLine: () => undefined,
    hookSettings: (_tabId: string, allowsKoloft: boolean, isConductor: boolean) => {
      allowKoloft = allowsKoloft
      conductor = isConductor
      return undefined
    },
    ptysChanged: () => {}
  } as unknown as ClaudeBackendDeps)
  const r = await backend.create({ kind: 'claude', cwd, ...spec })
  if (!r.ok) throw new Error(`launch refused: ${r.code}`)
  return [handed, filesUnder(regDir), filesUnder(userData)].join('\n')
}

const machineTreeIo: TreeIo = {
  git: async (dir, args) =>
    (await execFileAsync('git', ['-C', barePath(dir), ...args])).stdout.trimEnd(),
  exists: async (p) => fs.existsSync(barePath(p)),
  real: (p) => p,
  keyed: (listed) => `ssh://${MACHINE}${listed}`
}

async function codexTab(cwd: string, spec: Partial<CreateTabOptions>): Promise<string> {
  if (spec.worktree) seedRepo(repo)
  const argv: string[][] = []
  const tabDirs = path.join(userData, 'tabs')
  const sessions = new CodexSessions(path.join(home, 'sessions.json'), {
    pty: {
      nextId: () => TAB,
      create: (args: { argv: string[] }) => {
        argv.push(args.argv)
        return { id: TAB }
      },
      kill: () => {},
      clearResumeIntent: () => {}
    } as unknown as CodexSessionDeps['pty'],
    runtime: new SessionRuntime(),
    projectInfo: (p) => ({ root: cwd, treeRoot: p }),
    remoteDirExists: async () => true,
    remoteTreeIo: () => machineTreeIo,
    machine: {
      instance: 'table-instance',
      ready: async () => {},
      run: async () => ({ code: 1, stdout: '', stderr: '' }),
      sshArgs: () => [],
      machinePackage: () => ({ dir: home, name: 'm-0000000000000000' }),
      tabDir: (tabId) => path.join(tabDirs, tabId),
      fileExists: async () => false,
      keyed: (machine, p) => `ssh://${machine}${p}`
    },
    changed: () => {},
    events: () => {},
    error: () => {},
    trustFolder: () => {},
    pickHome: () => ({ account: 'work', home: path.join(home, 'codex-home') }),
    assistOf: () => undefined,
    replyLanguageScript: '/koloft/codex-reply-language.sh',
    builtInStatusLine: () => true,
    browserEndpoint: () => '',
    openShimRoot: path.join(home, 'codex-open'),
    playwrightBin: path.join(home, 'commands', 'bin'),
    agent: { enabled: () => true, answer: () => {} },
    gitAccounts: {
      configEnv: (env) => env,
      picked: async () => false,
      ghWrapper: path.join(home, 'shim', 'gh')
    }
  })
  try {
    await sessions.launch({ kind: 'codex', cwd, ...spec })
    const options = codex.transports[codex.transports.length - 1]
    const said = options.sessionEnv?.KOLOFT_CODEX_SAID
    return [
      JSON.stringify({ argv, options }),
      said && fs.existsSync(said) ? fs.readFileSync(said, 'utf8') : '',
      filesUnder(tabDirs)
    ].join('\n')
  } finally {
    await sessions.stopAll()
  }
}

const KINDS = {
  'Claude Code on this Mac': (spec: Partial<CreateTabOptions>) => claudeTab(repo, spec),
  'Claude Code over SSH': (spec: Partial<CreateTabOptions>) =>
    claudeTab(`ssh://${MACHINE}${repo}`, spec),
  'Codex on this Mac': (spec: Partial<CreateTabOptions>) => codexTab(repo, spec),
  'Codex over SSH': (spec: Partial<CreateTabOptions>) => codexTab(`ssh://${MACHINE}${repo}`, spec)
}
type Kind = keyof typeof KINDS

type Landing = { handed: string[]; dropped?: string[] } | { takesNothing: string }

type LaunchFeature = Exclude<keyof ClaudeLaunch, 'root' | 'cwd' | 'fallbackCwd' | 'resumeSessionId'>

const CONDUCTORS_RUN_ON_THIS_MAC: Landing = {
  takesNothing: 'a conductor always runs on this Mac, in a folder under Koloft’s data'
}

const CODEX_TAKES_NO_NAME: Landing = { takesNothing: 'Codex takes no session name when it starts' }

const WORKTREE_OFFSET = String(portOffset('table-wt'))

const FEATURES: Record<
  LaunchFeature,
  { spec: Partial<CreateTabOptions>; marker: string; on: Record<Kind, Landing> }
> = {
  worktree: {
    spec: { worktree: 'table-wt' },
    marker: 'table-wt',
    on: {
      'Claude Code on this Mac': {
        handed: ['-w table-wt', `"KOLOFT_PORT_OFFSET":"${WORKTREE_OFFSET}"`]
      },
      'Claude Code over SSH': {
        handed: ['table-wt', `KOLOFT_PORT_OFFSET=${WORKTREE_OFFSET}`]
      },
      'Codex on this Mac': { handed: [`"KOLOFT_PORT_OFFSET":"${WORKTREE_OFFSET}"`] },
      'Codex over SSH': {
        handed: ['/.claude/worktrees/table-wt', `KOLOFT_PORT_OFFSET='${WORKTREE_OFFSET}'`]
      }
    }
  },
  model: {
    spec: { model: 'table-model' },
    marker: 'table-model',
    on: {
      'Claude Code on this Mac': { handed: ['--model table-model'] },
      'Claude Code over SSH': { handed: ['--model', 'table-model'] },
      'Codex on this Mac': { handed: ['"-m","table-model"'] },
      'Codex over SSH': { handed: ["'-m' 'table-model'"] }
    }
  },
  effort: {
    spec: { effort: 'xhigh' },
    marker: 'xhigh',
    on: {
      'Claude Code on this Mac': { handed: ['--effort xhigh'] },
      'Claude Code over SSH': { handed: ['--effort', 'xhigh'] },
      'Codex on this Mac': { handed: ['model_reasoning_effort=\\"xhigh\\"'] },
      'Codex over SSH': { handed: ['model_reasoning_effort=\\"xhigh\\"'] }
    }
  },
  permission: {
    spec: { permission: 'acceptEdits' },
    marker: 'acceptEdits',
    on: {
      'Claude Code on this Mac': { handed: ['--permission-mode acceptEdits'] },
      'Claude Code over SSH': { handed: ['--permission-mode', 'acceptEdits'] },
      'Codex on this Mac': { handed: ['"-a","on-request","-s","workspace-write"'] },
      'Codex over SSH': { handed: ["'-a' 'on-request' '-s' 'workspace-write'"] }
    }
  },
  firstPrompt: {
    spec: { firstPrompt: 'FIRST-PROMPT-TEXT' },
    marker: 'FIRST-PROMPT-TEXT',
    on: {
      'Claude Code on this Mac': { handed: ['"KOLOFT_FIRST_PROMPT":"FIRST-PROMPT-TEXT"'] },
      'Claude Code over SSH': { handed: ['FIRST-PROMPT-TEXT'] },
      'Codex on this Mac': { handed: ['"FIRST-PROMPT-TEXT"'] },
      'Codex over SSH': { handed: ["'FIRST-PROMPT-TEXT'"] }
    }
  },
  ownerWords: {
    spec: { ownerWords: 'OWNER-WORDS-TEXT' },
    marker: 'OWNER-WORDS-TEXT',
    on: {
      'Claude Code on this Mac': { handed: [`${TAB}.said: OWNER-WORDS-TEXT`] },
      'Claude Code over SSH': { handed: [`${TAB}.said: OWNER-WORDS-TEXT`] },
      'Codex on this Mac': { handed: ['OWNER-WORDS-TEXT'] },
      'Codex over SSH': { handed: [`printf '%s' 'OWNER-WORDS-TEXT' > "$S.said"`] }
    }
  },
  name: {
    spec: { name: 'TableName' },
    marker: 'TableName',
    on: {
      'Claude Code on this Mac': { handed: ['"KOLOFT_SESSION_NAME":"TableName"'] },
      'Claude Code over SSH': { handed: ["'--name' 'TableName'"] },
      'Codex on this Mac': CODEX_TAKES_NO_NAME,
      'Codex over SSH': CODEX_TAKES_NO_NAME
    }
  },
  role: {
    spec: { role: 'ROLE-TEXT' },
    marker: 'ROLE-TEXT',
    on: {
      'Claude Code on this Mac': { handed: [`${TAB}.conductor: `, 'ROLE-TEXT'] },
      'Claude Code over SSH': CONDUCTORS_RUN_ON_THIS_MAC,
      'Codex on this Mac': { handed: ['ROLE-TEXT'] },
      'Codex over SSH': { handed: ['ROLE-TEXT'] }
    }
  },
  conductor: {
    spec: { conductor: true },
    marker: '"conductor":true',
    on: {
      'Claude Code on this Mac': {
        handed: ['"conductor":true'],
        dropped: ['KOLOFT_AGENT_PROMPT']
      },
      'Claude Code over SSH': { handed: ['"conductor":true'] },
      'Codex on this Mac': {
        handed: [],
        dropped: ['HELPERS']
      },
      'Codex over SSH': CONDUCTORS_RUN_ON_THIS_MAC
    }
  }
}

describe('what each of the four kinds of session tab is handed for each launch feature, or why that kind takes nothing from it', () => {
  describe.each(Object.keys(KINDS) as Kind[])('%s', (kind) => {
    let plainLaunch: Promise<string> | undefined
    it.each(Object.keys(FEATURES) as LaunchFeature[])('%s', async (feature) => {
      const { spec, marker, on } = FEATURES[feature]
      const landing = on[kind]
      if ('takesNothing' in landing) {
        expect(await KINDS[kind](spec)).not.toContain(marker)
        return
      }
      plainLaunch ??= KINDS[kind]({})
      const plain = await plainLaunch
      const withFeature = await KINDS[kind](spec)
      for (const s of landing.handed) {
        expect(withFeature).toContain(s)
        expect(plain).not.toContain(s)
      }
      for (const s of landing.dropped ?? []) {
        expect(plain).toContain(s)
        expect(withFeature).not.toContain(s)
      }
    })
  })
})

it("lets a Claude Code tab on this Mac run koloft without asking only when it brings Koloft's plugin", async () => {
  expect(await claudeTab(repo, {})).toContain('"allowKoloft":true')
  expect(await claudeTab(repo, {}, false)).toContain('"allowKoloft":false')
})

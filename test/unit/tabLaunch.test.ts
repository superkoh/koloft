import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
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
              hooks: [
                {
                  key: '/<session-flags>/config.toml:pre_tool_use:0:0',
                  eventName: 'preToolUse',
                  command: CODEX_GATE_HOOK_COMMAND,
                  source: 'sessionFlags',
                  currentHash: 'sha256:' + 'f'.repeat(64),
                  trustStatus: 'trusted'
                }
              ],
              warnings: [],
              errors: []
            }))
          }
        : { data: [], nextCursor: null }
    close = async () => {}
  }
}))

import type { CreateTabOptions } from '@shared/types'
import { portOffset } from '@shared/worktreeName'
import { ClaudeBackend, type ClaudeBackendDeps } from '../../src/main/backends/claude'
import { CodexSessions, type CodexSessionDeps } from '../../src/main/codexSessions'
import { CODEX_GATE_HOOK_COMMAND } from '../../src/main/conductorGate'
import { GithubLookup } from '../../src/main/github'
import type { ClaudeLaunch } from '../../src/main/host/host'
import { Hosts } from '../../src/main/host/hosts'
import { localHost } from '../../src/main/host/localHost'
import { SshHost } from '../../src/main/host/sshHost'
import { SessionBackends } from '../../src/main/sessionBackends'
import { SessionRuntime } from '../../src/main/sessionRuntime'

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

afterEach(() => {
  process.env.HOME = realHome
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

async function claudeTab(cwd: string, spec: Partial<CreateTabOptions>): Promise<string> {
  let handed = ''
  const backend = new ClaudeBackend({
    pty: {
      create: (args: Parameters<ClaudeBackendDeps['pty']['create']>[0]) => {
        const command =
          typeof args.launchCommand === 'function' ? args.launchCommand(TAB) : args.launchCommand
        handed = `${command}\n${JSON.stringify({ conductor: args.conductor, env: args.extraEnv })}`
        return { id: TAB }
      }
    },
    tracker: { track: () => {}, movePick: () => {}, list: () => [] },
    hosts: new Hosts(
      localHost(new GithubLookup(), {
        hookRegDir: () => regDir,
        agentPlugin: () => '/koloft/agent-plugin',
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
    ptysChanged: () => {}
  } as unknown as ClaudeBackendDeps)
  const r = await backend.create({ kind: 'claude', cwd, ...spec })
  if (!r.ok) throw new Error(`launch refused: ${r.code}`)
  return [handed, filesUnder(regDir), filesUnder(userData)].join('\n')
}

async function codexTab(spec: Partial<CreateTabOptions>): Promise<string> {
  if (spec.worktree) seedRepo(repo)
  const allowed: string[][] = []
  const argv: string[][] = []
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
    projectInfo: (p) => ({ root: repo, treeRoot: p }),
    changed: () => {},
    events: () => {},
    error: () => {},
    trustFolder: () => {},
    pickHome: () => ({ account: 'work', home: path.join(home, 'codex-home') }),
    assistOf: () => undefined,
    conductorGate: {
      script: '/koloft/codex-conductor-gate.sh',
      writeAllow: (tabId, allow) => {
        allowed.push([...allow])
        return path.join(regDir, `${tabId}.allow`)
      }
    },
    replyLanguageScript: '/koloft/codex-reply-language.sh',
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
  vi.spyOn(sessions, 'availability').mockResolvedValue({ id: 'codex', available: true })
  try {
    await sessions.launch({ kind: 'codex', cwd: repo, ...spec })
    const options = codex.transports[codex.transports.length - 1]
    const said = options.sessionEnv?.KOLOFT_CODEX_SAID
    return [
      JSON.stringify({ argv, allowed, options }),
      said && fs.existsSync(said) ? fs.readFileSync(said, 'utf8') : ''
    ].join('\n')
  } finally {
    await sessions.stopAll()
  }
}

async function refused(kind: CreateTabOptions['kind'], spec: Partial<CreateTabOptions>) {
  return new SessionBackends({} as ConstructorParameters<typeof SessionBackends>[0])
    .create({ kind, cwd: `ssh://${MACHINE}${repo}`, ...spec })
    .then(
      () => 'started',
      (error: Error) => error.message
    )
}

const KINDS = {
  'Claude Code on this Mac': (spec: Partial<CreateTabOptions>) => claudeTab(repo, spec),
  'Claude Code over SSH': (spec: Partial<CreateTabOptions>) =>
    claudeTab(`ssh://${MACHINE}${repo}`, spec),
  'Codex on this Mac': codexTab,
  'Codex over SSH': (spec: Partial<CreateTabOptions>) => refused('codex', spec)
}
type Kind = keyof typeof KINDS

type Landing = { handed: string[]; dropped?: string[] } | { takesNothing: string }

type LaunchFeature = Exclude<keyof ClaudeLaunch, 'root' | 'cwd' | 'fallbackCwd' | 'resumeSessionId'>

const CODEX_NOT_OVER_SSH: Landing = { takesNothing: 'Codex does not run on a remote machine yet' }
const CONDUCTORS_RUN_ON_THIS_MAC: Landing = {
  takesNothing: 'a conductor always runs on this Mac, in a folder under Koloft’s data'
}

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
      'Codex over SSH': CODEX_NOT_OVER_SSH
    }
  },
  model: {
    spec: { model: 'table-model' },
    marker: 'table-model',
    on: {
      'Claude Code on this Mac': { handed: ['--model table-model'] },
      'Claude Code over SSH': { handed: ['--model', 'table-model'] },
      'Codex on this Mac': { handed: ['"-m","table-model"'] },
      'Codex over SSH': CODEX_NOT_OVER_SSH
    }
  },
  effort: {
    spec: { effort: 'xhigh' },
    marker: 'xhigh',
    on: {
      'Claude Code on this Mac': { handed: ['--effort xhigh'] },
      'Claude Code over SSH': { handed: ['--effort', 'xhigh'] },
      'Codex on this Mac': { handed: ['model_reasoning_effort=\\"xhigh\\"'] },
      'Codex over SSH': CODEX_NOT_OVER_SSH
    }
  },
  permission: {
    spec: { permission: 'acceptEdits' },
    marker: 'acceptEdits',
    on: {
      'Claude Code on this Mac': { handed: ['--permission-mode acceptEdits'] },
      'Claude Code over SSH': { handed: ['--permission-mode', 'acceptEdits'] },
      'Codex on this Mac': { handed: ['"-a","on-request","-s","workspace-write"'] },
      'Codex over SSH': CODEX_NOT_OVER_SSH
    }
  },
  firstPrompt: {
    spec: { firstPrompt: 'FIRST-PROMPT-TEXT' },
    marker: 'FIRST-PROMPT-TEXT',
    on: {
      'Claude Code on this Mac': { handed: ['"KOLOFT_FIRST_PROMPT":"FIRST-PROMPT-TEXT"'] },
      'Claude Code over SSH': { handed: ['FIRST-PROMPT-TEXT'] },
      'Codex on this Mac': { handed: ['"FIRST-PROMPT-TEXT"'] },
      'Codex over SSH': CODEX_NOT_OVER_SSH
    }
  },
  ownerWords: {
    spec: { ownerWords: 'OWNER-WORDS-TEXT' },
    marker: 'OWNER-WORDS-TEXT',
    on: {
      'Claude Code on this Mac': { handed: [`${TAB}.said: OWNER-WORDS-TEXT`] },
      'Claude Code over SSH': { handed: [`${TAB}.said: OWNER-WORDS-TEXT`] },
      'Codex on this Mac': { handed: ['OWNER-WORDS-TEXT'] },
      'Codex over SSH': CODEX_NOT_OVER_SSH
    }
  },
  name: {
    spec: { name: 'TableName' },
    marker: 'TableName',
    on: {
      'Claude Code on this Mac': { handed: ['"KOLOFT_SESSION_NAME":"TableName"'] },
      'Claude Code over SSH': {
        takesNothing: 'over SSH a name goes along only with a first prompt'
      },
      'Codex on this Mac': { takesNothing: 'Codex takes no session name when it starts' },
      'Codex over SSH': CODEX_NOT_OVER_SSH
    }
  },
  role: {
    spec: { role: 'ROLE-TEXT' },
    marker: 'ROLE-TEXT',
    on: {
      'Claude Code on this Mac': { handed: [`${TAB}.conductor: `, 'ROLE-TEXT'] },
      'Claude Code over SSH': CONDUCTORS_RUN_ON_THIS_MAC,
      'Codex on this Mac': { handed: ['ROLE-TEXT'] },
      'Codex over SSH': CODEX_NOT_OVER_SSH
    }
  },
  allow: {
    spec: { conductor: true, allow: ['ALLOW-TOOL'] },
    marker: 'ALLOW-TOOL',
    on: {
      'Claude Code on this Mac': { handed: [`${TAB}.allow: ["ALLOW-TOOL"]`] },
      'Claude Code over SSH': CONDUCTORS_RUN_ON_THIS_MAC,
      'Codex on this Mac': { handed: ['"allowed":[["ALLOW-TOOL"]]'] },
      'Codex over SSH': CODEX_NOT_OVER_SSH
    }
  },
  conductor: {
    spec: { conductor: true },
    marker: '"conductor":true',
    on: {
      'Claude Code on this Mac': {
        handed: ['"conductor":true', `${TAB}.allow: []`],
        dropped: ['KOLOFT_AGENT_PROMPT']
      },
      'Claude Code over SSH': { handed: ['"conductor":true'] },
      'Codex on this Mac': {
        handed: ['"KOLOFT_CODEX_GATE":"/koloft/codex-conductor-gate.sh"'],
        dropped: ['HELPERS']
      },
      'Codex over SSH': CODEX_NOT_OVER_SSH
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

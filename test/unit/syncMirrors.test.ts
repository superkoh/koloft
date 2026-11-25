import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { app } from 'electron'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-sync-mirrors-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(() => fs.rmSync(app.getPath('userData'), { recursive: true, force: true }))

const machineThreads = vi.hoisted(() => ({ listed: [] as unknown[] }))

vi.mock('../../src/main/cliRuntime', () => ({
  resolveCliRuntime: async (spec: {
    command: string
    environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  }) => ({
    binary: `/fixture/${spec.command}`,
    env: spec.environment({ HOME: process.env.HOME, PATH: '/usr/bin:/bin' }),
    version: '999.0.0',
    verified: true
  })
}))

vi.mock('../../src/agents/codex/main/codexTransport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agents/codex/main/codexTransport')>()
  return {
    ...real,
    createCodexTransport: async () => ({
      url: 'unix:///test/rpc.sock',
      stop: async () => {},
      request: async () => ({})
    }),
    CodexRpc: class {
      request = async (
        method: string,
        params: { cwds?: string[]; archived?: boolean }
      ): Promise<{ data: unknown[]; nextCursor?: null }> =>
        method === 'hooks/list'
          ? {
              data: (params.cwds ?? []).map((cwd) => ({
                cwd,
                hooks: [],
                warnings: [],
                errors: []
              }))
            }
          : method === 'thread/list' && !params.archived
            ? { data: machineThreads.listed, nextCursor: null }
            : { data: [], nextCursor: null }

      close = async (): Promise<void> => {}
    }
  }
})

import { RemoteSync, type RemoteTarget } from '../../src/main/remote/sync'
import type { RunResult } from '../../src/main/remote/ssh'
import { syncMirrorsOf } from '../../src/main/remote/syncMirrors'
import { SessionBackends } from '../../src/core/agent/sessionBackends'
import type { ResumeProbes } from '../../src/main/resumePlan'
import { codexBackend } from '../../src/agents/codex/main/backend'
import { agyBackend } from '../../src/agents/agy/main/backend'
import type { CodexSessions } from '../../src/agents/codex/main/codexSessions'
import type { AgySessions } from '../../src/agents/agy/main/agySessions'
import {
  agySessionsIn,
  claudeBackendIn,
  codexSessionsIn,
  makeWorld,
  recordingPty,
  recordingSsh
} from './helpers/agentTabs'
import { lifecycle } from './helpers/sessionBackendStub'

const PINNED = './sync-mirrors'
const MACHINE = 'box'
const OTHER_MACHINE = 'other'
const USER_DATA = '/ud'
const WORKSPACE_ON_THE_MACHINE = '/home/me/api'
const on = (machine: string): string => `ssh://${machine}${WORKSPACE_ON_THE_MACHINE}`
const A_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EVERY_FOLDER_HAS_FILES =
  'transcripts t\nhooks h\n' + Array.from({ length: 12 }, () => 'extra e\n').join('')
const SSH_MASTER_FULL =
  'mux_client_request_session: session request failed: Session open refused by peer'
const ANTIGRAVITY_LISTER = 'agy-list.mjs'

interface Agents {
  codex: CodexSessions
  agy: AgySessions
  codexAnswersOn: Set<string>
  agyListsOn: Set<string>
}

interface Case {
  file: string
  title: string
  codexAndAntigravityBuilt?: false
  has?: (agents: Agents) => Promise<void>
}

const codexTabOn = async (a: Agents, machine: string): Promise<void> => {
  await a.codex.launch({ kind: 'codex', cwd: on(machine), tabId: `codex-on-${machine}` })
}
const codexHistoryOn = async (a: Agents, machine: string): Promise<void> => {
  a.codexAnswersOn.add(machine)
  machineThreads.listed = [
    { id: A_SESSION, cwd: WORKSPACE_ON_THE_MACHINE, name: 'Earlier', createdAt: 1, updatedAt: 1 }
  ]
  await a.codex.refreshMachineHistory(machine, true)
}
const agyRunOn = async (a: Agents, machine: string): Promise<void> => {
  await a.agy.launch({ kind: 'agy', cwd: on(machine), tabId: `agy-on-${machine}` })
}
const agyHistoryOn = async (a: Agents, machine: string): Promise<void> => {
  a.agyListsOn.add(machine)
  await a.agy.refreshHistory()
}

const CASES: Case[] = [
  {
    file: 'nothing',
    title:
      'no agent has a tab or history there; Claude Code answers the same whatever it has there, so this is its list too'
  },
  {
    file: 'codex-tab',
    title: 'a Codex tab is open there',
    has: (a) => codexTabOn(a, MACHINE)
  },
  {
    file: 'codex-tab-elsewhere',
    title: 'a Codex tab is open on another machine only',
    has: (a) => codexTabOn(a, OTHER_MACHINE)
  },
  {
    file: 'codex-history',
    title: 'Codex has history there and no tab',
    has: (a) => codexHistoryOn(a, MACHINE)
  },
  {
    file: 'agy-run-or-history',
    title: 'Antigravity has a run there',
    has: (a) => agyRunOn(a, MACHINE)
  },
  {
    file: 'agy-run-or-history',
    title: 'Antigravity has history there and no run',
    has: (a) => agyHistoryOn(a, MACHINE)
  },
  {
    file: 'agy-elsewhere',
    title: 'Antigravity has a run on another machine only',
    has: (a) => agyRunOn(a, OTHER_MACHINE)
  },
  {
    file: 'agy-elsewhere',
    title: 'Antigravity has history on another machine only',
    has: (a) => agyHistoryOn(a, OTHER_MACHINE)
  },
  {
    file: 'every-agent',
    title: 'Codex has a tab and Antigravity a run there',
    has: async (a) => {
      await codexTabOn(a, MACHINE)
      await agyRunOn(a, MACHINE)
    }
  },
  {
    file: 'not-built',
    title: 'Codex and Antigravity were not built',
    codexAndAntigravityBuilt: false
  }
]

const EVERY_AGENT = CASES.find((c) => c.file === 'every-agent')!

const answered = (stdout = ''): { code: number; stdout: Buffer; stderr: string } => ({
  code: 0,
  stdout: Buffer.from(stdout),
  stderr: ''
})

async function targetOf(c: Case): Promise<RemoteTarget> {
  const world = makeWorld()
  const stops: (() => Promise<void>)[] = []
  try {
    const probes = {} as ResumeProbes
    const backends = new SessionBackends(lifecycle())
    backends.register(
      claudeBackendIn(world, recordingPty('claude-tab').pty, {
        machine: { run: async () => answered() }
      })
    )
    if (c.codexAndAntigravityBuilt !== false) {
      const codexAnswersOn = new Set<string>()
      const agyListsOn = new Set<string>()
      const codex = codexSessionsIn(world, recordingPty('codex-tab').pty, {
        ranOnTheMachine: [],
        run: (machine) => ({ code: codexAnswersOn.has(machine) ? 0 : 1, stdout: '', stderr: '' })
      })
      const listed = JSON.stringify([
        {
          conversation_id: A_SESSION,
          title: 'Earlier',
          preview: '',
          workspace_uris: [`file://${WORKSPACE_ON_THE_MACHINE}`],
          last_modified_time: 1,
          step_count: 1
        }
      ])
      const agy = agySessionsIn(world, recordingPty('agy-tab').pty, {
        pinnedMachines: () => [...agyListsOn],
        machine: {
          run: recordingSsh((readable) =>
            readable.includes(ANTIGRAVITY_LISTER) ? { stdout: Buffer.from(listed) } : {}
          ).run
        }
      })
      stops.push(
        () => codex.stopAll(),
        () => agy.stopAll()
      )
      backends.register(codexBackend(codex, probes, () => probes))
      backends.register(agyBackend(agy, probes, () => probes))
      await c.has?.({ codex, agy, codexAnswersOn, agyListsOn })
    }
    return {
      host: MACHINE,
      ...syncMirrorsOf(MACHINE, USER_DATA, backends),
      paths: [WORKSPACE_ON_THE_MACHINE],
      hasTabs: true,
      agentTabs: false,
      busy: false
    }
  } finally {
    machineThreads.listed = []
    for (const stop of stops) await stop()
    await world.gone()
  }
}

interface Copy {
  from: string
  to: string
  flags: string[]
}

interface Round {
  heartbeat: string
  copies: Copy[]
  problem?: string
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })

const scriptOf = (cmd: string): string =>
  Buffer.from(cmd.split(' ').pop() ?? '', 'base64').toString('utf8')

async function rounds(
  target: RemoteTarget,
  n = 1,
  copyAnswer: (from: string, round: number) => RunResult = () => ok('')
): Promise<Round[]> {
  const done: Round[] = []
  let current: Round | undefined
  const sync = new RemoteSync({
    run: async (_host, cmd) => {
      current = { heartbeat: scriptOf(cmd), copies: [] }
      done.push(current)
      return ok(EVERY_FOLDER_HAS_FILES)
    },
    rsync: async (_host, from, to, flags) => {
      current!.copies.push({ from, to, flags })
      return copyAnswer(from, done.length)
    },
    listen: () => () => {},
    targets: () => [target],
    onChange: () => {}
  })
  sync.start()
  try {
    for (let i = 0; i < n; i++) {
      if (i === 0) await sync.firstRoundDone(MACHINE)
      else {
        const next = sync.nextPullDone(MACHINE)
        sync.pokeNow(MACHINE)
        await next
      }
      done[done.length - 1].problem = sync.problem(MACHINE)
    }
  } finally {
    sync.stop()
  }
  return done
}

async function showsAProblemWhenItFails(target: RemoteTarget, from: string): Promise<boolean> {
  const [round] = await rounds(target, 1, (copied) =>
    copied === from ? { code: 23, stdout: '', stderr: `could not copy ${from}` } : ok('')
  )
  return round.problem !== undefined
}

const heartbeatArguments = (heartbeat: string): string => heartbeat.split('\n')[0]

async function asPinned(target: RemoteTarget): Promise<string> {
  const [round] = await rounds(target)
  const lines = [
    `heartbeat arguments: ${heartbeatArguments(round.heartbeat)}`,
    'copies, in the order they start:'
  ]
  for (const [i, copy] of round.copies.entries()) {
    lines.push(
      `${i + 1}. ${copy.from} -> ${copy.to}`,
      `   flags: ${copy.flags.join(' ')}`,
      `   a failed copy shows a sync problem: ${(await showsAProblemWhenItFails(target, copy.from)) ? 'yes' : 'no'}`
    )
  }
  return lines.join('\n') + '\n'
}

describe("which folders Koloft pulls back from a remote machine, in which order and with which flags, asked of each agent's own sessions and pinned so that moving the code changes no byte", () => {
  it.each(CASES)('$file: $title', async (c) => {
    await expect(await asPinned(await targetOf(c))).toMatchFileSnapshot(`${PINNED}/${c.file}.txt`)
  })

  it('the whole heartbeat script, when Codex and Antigravity both use the machine', async () => {
    const [round] = await rounds(await targetOf(EVERY_AGENT))
    await expect(round.heartbeat).toMatchFileSnapshot(`${PINNED}/heartbeat-every-agent.txt`)
  })

  it('once a full ssh master refuses a copy, the next round copies one folder at a time in this order', async () => {
    const target = await targetOf(EVERY_AGENT)
    const [, oneAtATime] = await rounds(target, 2, (from, round) =>
      round === 1 && from === '.claude/projects'
        ? { code: 255, stdout: '', stderr: SSH_MASTER_FULL }
        : ok('')
    )
    await expect(oneAtATime.copies.map((c) => c.from).join('\n') + '\n').toMatchFileSnapshot(
      `${PINNED}/one-at-a-time-every-agent.txt`
    )
  })
})

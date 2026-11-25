import { describe, expect, it } from 'vitest'
import { RemoteSync, type RemoteTarget } from '../../src/main/remote/sync'
import type { RunResult } from '../../src/main/remote/ssh'
import { syncMirrorsOf } from '../../src/main/remote/syncMirrors'

const PINNED = './sync-mirrors'
const MACHINE = 'box'
const OTHER_MACHINE = 'other'
const USER_DATA = '/ud'
const WORKSPACE_ON_THE_MACHINE = '/home/me/api'
const EVERY_FOLDER_HAS_FILES =
  'transcripts t\nhooks h\n' + Array.from({ length: 12 }, () => 'extra e\n').join('')
const SSH_MASTER_FULL =
  'mux_client_request_session: session request failed: Session open refused by peer'

interface WhatEachAgentHas {
  codex: { tabsOn: string[]; historyOn: string[] } | 'not built'
  agy: { runOrHistoryOn: string[] } | 'not built'
}

const nothing: WhatEachAgentHas = {
  codex: { tabsOn: [], historyOn: [] },
  agy: { runOrHistoryOn: [] }
}

const CASES: { file: string; title: string; has: WhatEachAgentHas }[] = [
  {
    file: 'nothing',
    title:
      'no agent has a tab or history there; Claude Code is never asked, so a tab, history or nothing of its own pulls this same list',
    has: nothing
  },
  {
    file: 'codex-tab',
    title: 'a Codex tab is open there',
    has: { ...nothing, codex: { tabsOn: [MACHINE], historyOn: [] } }
  },
  {
    file: 'codex-tab-elsewhere',
    title: 'a Codex tab is open on another machine only',
    has: { ...nothing, codex: { tabsOn: [OTHER_MACHINE], historyOn: [] } }
  },
  {
    file: 'codex-history',
    title: 'Codex has history there and no tab',
    has: { ...nothing, codex: { tabsOn: [], historyOn: [MACHINE] } }
  },
  {
    file: 'agy-run-or-history',
    title: 'Antigravity has a run or history there',
    has: { ...nothing, agy: { runOrHistoryOn: [MACHINE] } }
  },
  {
    file: 'agy-elsewhere',
    title: 'Antigravity has a run or history on another machine only',
    has: { ...nothing, agy: { runOrHistoryOn: [OTHER_MACHINE] } }
  },
  {
    file: 'every-agent',
    title: 'Codex has a tab and Antigravity a run there',
    has: { codex: { tabsOn: [MACHINE], historyOn: [] }, agy: { runOrHistoryOn: [MACHINE] } }
  },
  {
    file: 'not-built',
    title: 'Codex and Antigravity were not built',
    has: { codex: 'not built', agy: 'not built' }
  }
]

function targetOf(has: WhatEachAgentHas): RemoteTarget {
  const { codex, agy } = has
  const codexSessions =
    codex === 'not built'
      ? null
      : {
          machinesWithTabs: () => codex.tabsOn,
          hasHistoryOn: (host: string) => codex.historyOn.includes(host)
        }
  const agySessions =
    agy === 'not built' ? null : { usesHost: (host: string) => agy.runOrHistoryOn.includes(host) }
  return {
    host: MACHINE,
    ...syncMirrorsOf(
      { host: MACHINE },
      USER_DATA,
      new Set(codexSessions?.machinesWithTabs()),
      codexSessions,
      agySessions
    ),
    paths: [WORKSPACE_ON_THE_MACHINE],
    hasTabs: true,
    agentTabs: false,
    busy: false
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

describe('which folders Koloft pulls back from a remote machine, in which order and with which flags, pinned so that moving the code changes no byte', () => {
  it.each(CASES)('$file: $title', async ({ file, has }) => {
    await expect(await asPinned(targetOf(has))).toMatchFileSnapshot(`${PINNED}/${file}.txt`)
  })

  it('the whole heartbeat script, when Codex and Antigravity both use the machine', async () => {
    const [round] = await rounds(targetOf(CASES.find((c) => c.file === 'every-agent')!.has))
    await expect(round.heartbeat).toMatchFileSnapshot(`${PINNED}/heartbeat-every-agent.txt`)
  })

  it('once a full ssh master refuses a copy, the next round copies one folder at a time in this order', async () => {
    const target = targetOf(CASES.find((c) => c.file === 'every-agent')!.has)
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

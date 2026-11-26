import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { app } from 'electron'
import type { InboxAnswers } from '@shared/inbox'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-ask-text-tools-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(() => fs.rmSync(app.getPath('userData'), { recursive: true, force: true }))

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
  const { CodexRpcThatListsNoHooks } = await import('./helpers/codexRpcStub')
  const { codexWires } = await import('./helpers/codexWires')
  return {
    ...real,
    createCodexTransport: async (options: (typeof codexWires)[number]) => {
      codexWires.push(options)
      return { url: 'unix:///test/rpc.sock', stop: async () => {}, request: async () => ({}) }
    },
    CodexRpc: CodexRpcThatListsNoHooks
  }
})

import {
  A_SITUATION_TAKES_UP_TO_MS,
  heldAskAnsweredFromTheInbox,
  pinSituation,
  pinWhenACardIsPosted,
  pinWhenAMessageAnswers,
  pinWhenARoomOpensAgain,
  titleOf,
  useAskTable
} from './helpers/askTable'

useAskTable()

describe('the words each place shows for an approval of another tool, from each agent’s own raw ask, pinned so that moving the asks behind one interface changes no character', () => {
  for (const file of [
    'use-another-tool-named',
    'use-another-tool-one-sentence',
    'use-another-tool-nothing-said'
  ])
    it(titleOf(file), () => pinSituation(file), A_SITUATION_TAKES_UP_TO_MS)
})

describe('when each kind of tab posts its Discord card, and when a Discord message counts as an answer, as each path does it today', () => {
  it(
    'the moments in order, from the raw ask to the card',
    pinWhenACardIsPosted,
    A_SITUATION_TAKES_UP_TO_MS
  )
  it(
    'a reply "yes" in Discord, with a card posted for the ask, and with none posted',
    pinWhenAMessageAnswers,
    A_SITUATION_TAKES_UP_TO_MS
  )
  it(
    'the room opening again while the same ask is still open',
    pinWhenARoomOpensAgain,
    A_SITUATION_TAKES_UP_TO_MS
  )
})

describe('a Claude Code ask its hook holds is answered from its Inbox card, through the hook', () => {
  const cases: [string, string, string, InboxAnswers, string][] = [
    [
      'Allow',
      'run-a-command-no-reason',
      'allow',
      {},
      '"decision":{"behavior":"allow","updatedInput":{"command":"npm test"}}'
    ],
    [
      'Deny',
      'run-a-command-no-reason',
      'deny',
      {},
      '"decision":{"behavior":"deny","message":"no"}'
    ],
    [
      'a pick',
      'one-question-own-words',
      'answer',
      { q: { q0: ['o1'] } },
      '"answers":{"Which colour do you prefer?":"Green"}'
    ],
    [
      'the owner’s own words',
      'one-question-own-words',
      'answer',
      { q: { q0: { own: 'Blue, please' } } },
      '"answers":{"Which colour do you prefer?":"Blue, please"}'
    ],
    [
      'several picks',
      'one-question-several-picks',
      'answer',
      { q: { q0: ['o0', 'o2'] } },
      '"answers":{"Which toppings?":"Cheese, Olives"}'
    ],
    [
      'Approve on a plan',
      'approve-a-plan',
      'approve',
      {},
      '"decision":{"behavior":"allow","updatedInput":{"plan":"# Plan'
    ]
  ]
  for (const [what, file, action, answers, printed] of cases)
    it(
      `${what}: ${titleOf(file)}`,
      async () => {
        const reached = await heldAskAnsweredFromTheInbox(file, action, answers)
        expect(reached.join('\n')).toContain(
          `the hook printed to Claude Code: {"hookSpecificOutput":{"hookEventName":"PermissionRequest",`
        )
        expect(reached.join('\n')).toContain(printed)
      },
      A_SITUATION_TAKES_UP_TO_MS
    )
})

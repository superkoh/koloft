import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeSessionInfo } from '../../../../src/shared/types'
import type { RemoteTab } from '../../../../src/main/host/host'
import { agyBackend } from '../../../../src/agents/agy/main/backend'
import { codexBackend } from '../../../../src/agents/codex/main/backend'
import {
  agySessionsIn,
  claudeBackendIn,
  codexSessionsIn,
  makeWorld,
  MACHINE,
  recordingPty,
  recordingSsh,
  type World
} from '../../helpers/agentTabs'

const TAB = 'pty-1'
const SID = '1425a153-9a1b-45b1-a727-b05f5a9c490e'
const A_CODEX_PICKER = ['› 1. GPT-6.1-Sol (current)', '  enter select · esc back']
const NO_RESUME_IS_PLANNED_HERE = {} as Parameters<typeof codexBackend>[1]
const nothingRuns = { run: recordingSsh().run }

let world: World
beforeEach(() => {
  world = makeWorld()
})
afterEach(() => world.gone())

describe('whether a tab shows a menu or a panel, as each agent answers it', () => {
  it('Claude Code answers from its session registry, read on the machine its tab runs on', async () => {
    const asked: string[] = []
    const claude = claudeBackendIn(world, recordingPty(TAB).pty, {
      machine: nothingRuns,
      remoteTab: { host: MACHINE } as RemoteTab,
      tracker: { infoOf: () => ({ sessionId: SID }) as ClaudeSessionInfo },
      liveRegistryOn: async (host) => {
        asked.push(host)
        return JSON.stringify({ sessionId: SID, kind: 'interactive', status: 'waiting' }) + '\0'
      }
    })
    expect(await claude.showsAPanel(TAB)).toBe(true)
    expect(asked).toEqual([MACHINE])
  })

  it('Codex answers from its screen, read only when none was handed over', async () => {
    const read: string[] = []
    const codex = codexBackend(
      codexSessionsIn(world, recordingPty(TAB).pty, {
        run: () => ({ code: 1, stdout: '', stderr: '' }),
        ranOnTheMachine: []
      }),
      NO_RESUME_IS_PLANNED_HERE,
      () => NO_RESUME_IS_PLANNED_HERE,
      async (tabId) => (read.push(tabId), A_CODEX_PICKER)
    )
    expect(await codex.showsAPanel(TAB)).toBe(true)
    expect(read).toEqual([TAB])
    expect(await codex.showsAPanel(TAB, ['› Ask Codex to do anything'])).toBeUndefined()
    expect(read).toEqual([TAB])
  })

  it('Antigravity cannot tell, whatever its screen shows', async () => {
    const agy = agyBackend(
      agySessionsIn(world, recordingPty(TAB).pty, { machine: nothingRuns }),
      NO_RESUME_IS_PLANNED_HERE,
      () => NO_RESUME_IS_PLANNED_HERE
    )
    expect(await agy.showsAPanel(TAB, A_CODEX_PICKER)).toBeUndefined()
  })
})

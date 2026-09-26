import { describe, expect, it } from 'vitest'
import {
  handoverPreamble,
  parseNewSessionArgs,
  sessionVerb,
  type AgentLaunch
} from '../../src/main/agentSessions'
import { EXIT_USAGE } from '../../src/main/agentRequests'
import type { BackendId, SessionInfo } from '../../src/shared/types'

const WS = '/work/app'
const CODEX_THREAD = '0199c3f2-7a41-7c30-9e55-1d2b8f6a0c11'
const OTHER_THREAD = '0199c3f2-7a41-7c30-9e55-1d2b8f6a0c22'

function session(
  tabId: string,
  backendId: BackendId,
  over: Partial<SessionInfo> = {}
): SessionInfo {
  return {
    tabId,
    backendId,
    host: 'local',
    sessionId: `${tabId}-session`,
    title: `${tabId} title`,
    cwd: WS,
    treeRoot: WS,
    alive: true,
    updatedAt: 1,
    ...over
  }
}

function harness(
  sessions: SessionInfo[],
  peerNames: Record<string, string> = {}
): {
  verb: ReturnType<typeof sessionVerb>
  launched: AgentLaunch[]
  queued: { tabId: string; text: string }[]
} {
  const launched: AgentLaunch[] = []
  const queued: { tabId: string; text: string }[] = []
  const verb = sessionVerb({
    backendOf: (tabId) => sessions.find((s) => s.tabId === tabId)?.backendId ?? 'claude',
    workspaceOf: (tabId) => (sessions.some((s) => s.tabId === tabId) ? WS : undefined),
    sessionsIn: () => sessions,
    peerName: async (sessionId) => peerNames[sessionId] ?? null,
    launch: async (spec) => {
      launched.push(spec)
      return 'new-tab'
    },
    queue: async (tabId, text) => {
      queued.push({ tabId, text })
    }
  })
  return { verb, launched, queued }
}

const from = (tabId: string): { tabId: string; cwd: string } => ({ tabId, cwd: WS })

describe('koloft session new: reading the command line', () => {
  it('reads the name, worktree and model, and joins the first message after --', () => {
    expect(
      parseNewSessionArgs([
        '--name',
        'docs-fixer',
        '-w',
        'links',
        '--model',
        'haiku',
        '--',
        'Fix',
        'the links'
      ])
    ).toEqual({
      ok: true,
      value: { name: 'docs-fixer', worktree: 'links', model: 'haiku', prompt: 'Fix the links' }
    })
  })

  it('refuses a missing first message, an unknown option, an option with no value and a bad worktree name', () => {
    for (const args of [
      ['--name', 'x'],
      ['--name', 'x', '--'],
      ['--effort', 'high', '--', 'go'],
      ['--model', '--', 'go'],
      ['-w', '../escape', '--', 'go']
    ])
      expect(parseNewSessionArgs(args).ok).toBe(false)
  })
})

describe('the handover put before the first message', () => {
  it('tells a Claude child who started it, to treat its messages as the owner’s, and to answer with SendMessage', () => {
    const text = handoverPreamble({ backend: 'claude', name: 'planner' })
    expect(text).toContain('"planner"')
    expect(text).toContain("the owner's instructions")
    expect(text).toContain('SendMessage')
  })

  it('tells a Codex child to answer with koloft session send and the caller’s id', () => {
    const text = handoverPreamble({ backend: 'codex', id: CODEX_THREAD })
    expect(text).toContain(`koloft session send ${CODEX_THREAD}`)
    expect(text).not.toContain('SendMessage')
  })
})

describe('koloft session list', () => {
  it('shows each session’s state, a Claude session’s name and transcript, a Codex session’s id, and marks the caller', async () => {
    const { verb } = harness(
      [
        session('me', 'claude', {
          status: 'working',
          details: { claude: { jsonlPath: '/home/.claude/projects/app/me.jsonl' } }
        }),
        session('cx', 'codex', { status: 'approval', nativeSessionId: CODEX_THREAD }),
        session('done', 'claude', { status: 'waiting' }),
        session('idle', 'claude', { status: 'idle' })
      ],
      { 'me-session': 'planner' }
    )
    const reply = await verb(['list'], from('me'))
    expect(reply.ok).toBe(true)
    expect(reply.text.split('\n')).toEqual([
      'me title (you) · Claude · working · name: planner · transcript: /home/.claude/projects/app/me.jsonl',
      `cx title · Codex · waiting for the owner · id: ${CODEX_THREAD}`,
      'done title · Claude · waiting for the owner',
      'idle title · Claude · idle'
    ])
  })
})

describe('koloft session new', () => {
  it('a Claude caller starts a named Claude sibling in its workspace whose first message says who to report to', async () => {
    const { verb, launched } = harness([session('me', 'claude')], { 'me-session': 'planner' })
    const reply = await verb(['new', '-w', 'links', '--', 'Fix the links.'], from('me'))
    expect(launched).toHaveLength(1)
    const [spec] = launched
    expect(spec).toMatchObject({ backend: 'claude', cwd: WS, worktree: 'links' })
    expect(spec.name).toMatch(/^helper-/)
    expect(
      spec.firstPrompt.startsWith(handoverPreamble({ backend: 'claude', name: 'planner' }))
    ).toBe(true)
    expect(spec.firstPrompt.endsWith('Fix the links.')).toBe(true)
    expect(reply.text).toContain(`"${spec.name}"`)
  })

  it('a Claude caller with no registry name hands over under its Koloft title', async () => {
    const { verb, launched } = harness([session('me', 'claude')])
    await verb(['new', '--name', 'docs-fixer', '--', 'go'], from('me'))
    expect(launched[0].name).toBe('docs-fixer')
    expect(launched[0].firstPrompt).toContain('"me title"')
  })

  it('a Codex caller starts a Codex sibling told to report back to its thread id, and gets the tab id to reach it by', async () => {
    const { verb, launched } = harness([session('me', 'codex', { nativeSessionId: CODEX_THREAD })])
    const reply = await verb(['new', '--', 'Check the tests.'], from('me'))
    expect(launched[0]).toMatchObject({ backend: 'codex', name: undefined })
    expect(launched[0].firstPrompt).toContain(`koloft session send ${CODEX_THREAD}`)
    expect(reply.text).toContain('new-tab')
  })

  it('a Codex caller cannot name the new session', async () => {
    const { verb, launched } = harness([session('me', 'codex', { nativeSessionId: CODEX_THREAD })])
    const reply = await verb(['new', '--name', 'x', '--', 'go'], from('me'))
    expect(reply).toMatchObject({ ok: false, exit: EXIT_USAGE })
    expect(launched).toEqual([])
  })
})

describe('koloft session send', () => {
  const sessions = (): SessionInfo[] => [
    session('me', 'codex', { nativeSessionId: CODEX_THREAD }),
    session('cx', 'codex', { nativeSessionId: OTHER_THREAD, title: 'Test runner' }),
    session('cc', 'claude', { title: 'Planner' })
  ]

  it('queues the message on the Codex session found by id, tab id or title', async () => {
    const { verb, queued } = harness(sessions())
    for (const ref of [OTHER_THREAD, 'cx', 'Test runner'])
      expect((await verb(['send', ref, 'What', 'did you find?'], from('me'))).ok).toBe(true)
    expect(queued).toEqual(Array(3).fill({ tabId: 'cx', text: 'What did you find?' }))
  })

  it('points a Claude caller, or a Claude target, to SendMessage and sends nothing', async () => {
    const { verb, queued } = harness(sessions())
    const toClaude = await verb(['send', 'Planner', 'hi'], from('me'))
    const fromClaude = await verb(['send', OTHER_THREAD, 'hi'], from('cc'))
    for (const reply of [toClaude, fromClaude]) {
      expect(reply.ok).toBe(false)
      expect(reply.text).toContain('SendMessage')
    }
    expect(queued).toEqual([])
  })

  it('refuses a session that is not open in this workspace, and a missing message', async () => {
    const { verb, queued } = harness(sessions())
    expect((await verb(['send', 'nobody', 'hi'], from('me'))).ok).toBe(false)
    expect(await verb(['send', OTHER_THREAD], from('me'))).toMatchObject({
      ok: false,
      exit: EXIT_USAGE
    })
    expect(queued).toEqual([])
  })
})

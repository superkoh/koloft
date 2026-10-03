import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  handoverPreamble,
  parseNewSessionArgs,
  sessionVerb,
  type ClosableSession,
  type PinnedWorkspace
} from '../../src/main/agentSessions'
import { StartedSessions } from '../../src/main/startedSessions'
import { EXIT_USAGE, type AgentReply } from '../../src/main/agentRequests'
import type { BackendId, CreateTabOptions, SessionInfo } from '../../src/shared/types'

const WS = '/work/app'
const OTHER_WS = '/work/site'
const PINNED: PinnedWorkspace[] = [
  { path: WS, missing: false },
  { path: OTHER_WS, missing: false },
  { path: '/old/site', missing: false },
  { path: '/work/gone', missing: true },
  { path: 'ssh://box/srv/api', missing: false }
]
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

type Launch = CreateTabOptions & { kind: BackendId }

function harness(
  sessions: SessionInfo[],
  peerNames: Record<string, string> = {},
  left: string[] = [],
  cold: ClosableSession[] = []
): {
  verb: (args: string[], from: { tabId: string; cwd: string }) => Promise<AgentReply>
  launched: Launch[]
  queued: { tabId: string; text: string }[]
  closed: string[]
  started: StartedSessions
} {
  const launched: Launch[] = []
  const queued: { tabId: string; text: string }[] = []
  const closed: string[] = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-started-'))
  const started = new StartedSessions(() => path.join(dir, 'started-sessions.json'))
  const inner = sessionVerb({
    workspaceOf: (tabId) => sessions.find((s) => s.tabId === tabId)?.cwd,
    allSessions: () => sessions,
    pinnedWorkspaces: () => PINNED,
    peerNames: () => async (sessionId) => peerNames[sessionId] ?? null,
    launch: async (spec) => {
      launched.push(spec)
      return 'new-tab'
    },
    queue: async (tabId, text) => {
      queued.push({ tabId, text })
    },
    started,
    closable: () => [...sessions, ...cold],
    whatIsLeft: async () => left,
    closeSoon: (target) => {
      closed.push(target.sessionId)
    }
  })
  const verb = async (args: string[], from: { tabId: string; cwd: string }): Promise<AgentReply> =>
    inner(args, { ...from, session: sessions.find((s) => s.tabId === from.tabId)! })
  return { verb, launched, queued, closed, started }
}

const from = (tabId: string): { tabId: string; cwd: string } => ({ tabId, cwd: WS })

describe('koloft session new: reading the command line', () => {
  it('reads the name, workspace, worktree and model, and joins the first message after --', () => {
    expect(
      parseNewSessionArgs([
        '--name',
        'docs-fixer',
        '--workspace',
        'site',
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
      value: {
        name: 'docs-fixer',
        workspace: 'site',
        worktree: 'links',
        model: 'haiku',
        prompt: 'Fix the links'
      }
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
    expect(reply.exit).toBe(0)
    expect(reply.text.split('\n')).toEqual([
      'me title (you) · Claude · working · name: planner · transcript: /home/.claude/projects/app/me.jsonl',
      `cx title · Codex · waiting for the owner · id: ${CODEX_THREAD}`,
      'done title · Claude · waiting for the owner',
      'idle title · Claude · idle'
    ])
  })

  it('--workspace lists another workspace’s sessions, and refuses a name not in the sidebar or any other option', async () => {
    const { verb } = harness([
      session('me', 'claude'),
      session('there', 'claude', { cwd: OTHER_WS, status: 'working' })
    ])
    expect((await verb(['list', '--workspace', OTHER_WS], from('me'))).text).toBe(
      'there title · Claude · working'
    )
    expect((await verb(['list', '--workspace', 'nope'], from('me'))).exit).not.toBe(0)
    expect(await verb(['list', '--all'], from('me'))).toMatchObject({ exit: EXIT_USAGE })
  })
})

describe('koloft session new', () => {
  it('a Claude caller starts a named Claude sibling in its workspace whose first message says who to report to', async () => {
    const { verb, launched } = harness([session('me', 'claude')], { 'me-session': 'planner' })
    const reply = await verb(['new', '-w', 'links', '--', 'Fix the links.'], from('me'))
    expect(launched).toHaveLength(1)
    const [spec] = launched
    expect(spec).toMatchObject({ kind: 'claude', cwd: WS, worktree: 'links' })
    expect(spec.name).toMatch(/^helper-/)
    expect(
      spec.firstPrompt?.startsWith(handoverPreamble({ backend: 'claude', name: 'planner' }))
    ).toBe(true)
    expect(spec.firstPrompt?.endsWith('Fix the links.')).toBe(true)
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
    expect(launched[0]).toMatchObject({ kind: 'codex', name: undefined })
    expect(launched[0].firstPrompt).toContain(`koloft session send ${CODEX_THREAD}`)
    expect(reply.text).toContain('new-tab')
  })

  it('--workspace starts the sibling in another sidebar workspace, found by full path or folder name', async () => {
    const { verb, launched } = harness([session('me', 'claude')])
    for (const ref of [OTHER_WS, 'app'])
      expect((await verb(['new', '--workspace', ref, '--', 'go'], from('me'))).exit).toBe(0)
    expect(launched.map((l) => l.cwd)).toEqual([OTHER_WS, WS])
  })

  it('a Codex caller starting one in another workspace is told how to list that workspace', async () => {
    const { verb } = harness([session('me', 'codex', { nativeSessionId: CODEX_THREAD })])
    const reply = await verb(['new', '--workspace', OTHER_WS, '--', 'go'], from('me'))
    expect(reply.text).toContain(`koloft session list --workspace "${OTHER_WS}"`)
  })

  it('--workspace refuses, starting nothing, a name not in the sidebar (listing what is), a name two workspaces share, a missing folder and a remote workspace', async () => {
    const { verb, launched } = harness([session('me', 'claude')])
    const unknown = await verb(['new', '--workspace', 'nope', '--', 'go'], from('me'))
    expect(unknown.exit).not.toBe(0)
    expect(unknown.text).toContain(`  ${OTHER_WS}\n`)
    expect(unknown.text).toContain('  box:/srv/api')
    const shared = await verb(['new', '--workspace', 'site', '--', 'go'], from('me'))
    expect(shared.exit).not.toBe(0)
    expect(shared.text).toContain('/old/site')
    for (const ref of ['gone', 'api', 'box:/srv/api', 'ssh://box/srv/api'])
      expect((await verb(['new', '--workspace', ref, '--', 'go'], from('me'))).exit).not.toBe(0)
    expect(launched).toEqual([])
  })

  it('a Codex caller cannot name the new session', async () => {
    const { verb, launched } = harness([session('me', 'codex', { nativeSessionId: CODEX_THREAD })])
    const reply = await verb(['new', '--name', 'x', '--', 'go'], from('me'))
    expect(reply).toMatchObject({ exit: EXIT_USAGE })
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
      expect((await verb(['send', ref, 'What', 'did you find?'], from('me'))).exit).toBe(0)
    expect(queued).toEqual(Array(3).fill({ tabId: 'cx', text: 'What did you find?' }))
  })

  it('points a Claude caller, or a Claude target, to SendMessage and sends nothing', async () => {
    const { verb, queued } = harness(sessions())
    const toClaude = await verb(['send', 'Planner', 'hi'], from('me'))
    const fromClaude = await verb(['send', OTHER_THREAD, 'hi'], from('cc'))
    for (const reply of [toClaude, fromClaude]) {
      expect(reply.exit).not.toBe(0)
      expect(reply.text).toContain('SendMessage')
    }
    expect(queued).toEqual([])
  })

  it('reaches a Codex session open in another workspace, so a child started there can report back', async () => {
    const { verb, queued } = harness([
      session('me', 'codex', { nativeSessionId: CODEX_THREAD }),
      session('kid', 'codex', { nativeSessionId: OTHER_THREAD, cwd: OTHER_WS })
    ])
    expect((await verb(['send', CODEX_THREAD, 'done'], from('kid'))).exit).toBe(0)
    expect(queued).toEqual([{ tabId: 'me', text: 'done' }])
  })

  it('refuses a session that is not open anywhere, and a missing message', async () => {
    const { verb, queued } = harness(sessions())
    expect((await verb(['send', 'nobody', 'hi'], from('me'))).exit).not.toBe(0)
    expect(await verb(['send', OTHER_THREAD], from('me'))).toMatchObject({ exit: EXIT_USAGE })
    expect(queued).toEqual([])
  })
})

describe('koloft session close', () => {
  it('closes the calling session, Claude or Codex, when nothing would be lost', async () => {
    const { verb, closed } = harness([
      session('me', 'claude'),
      session('cx', 'codex', { nativeSessionId: CODEX_THREAD })
    ])
    expect((await verb(['close'], from('me'))).exit).toBe(0)
    expect((await verb(['close'], from('cx'))).exit).toBe(0)
    expect(closed).toEqual(['me-session', 'cx-session'])
  })

  it('closes a session it started with koloft session new, by its title or tab id, while it is open', async () => {
    const { verb, closed } = harness([
      session('me', 'claude'),
      session('new-tab', 'claude', { title: 'Docs fixer' })
    ])
    await verb(['new', '--name', 'docs-fixer', '--', 'go'], from('me'))
    expect((await verb(['close', 'Docs fixer'], from('me'))).exit).toBe(0)
    expect((await verb(['close', 'new-tab'], from('me'))).exit).toBe(0)
    expect(closed).toEqual(['new-tab-session', 'new-tab-session'])
  })

  it('closes a session it started that has since ended and left only its sidebar row', async () => {
    const ended: ClosableSession = {
      sessionId: 'kid-session',
      backendId: 'codex',
      title: 'Test runner',
      treeRoot: WS
    }
    const { verb, closed, started } = harness([session('me', 'claude')], {}, [], [ended])
    started.started('gone-tab', 'me-session')
    started.bound('gone-tab', 'kid-session')
    expect((await verb(['close', 'Test runner'], from('me'))).exit).toBe(0)
    expect(closed).toEqual(['kid-session'])
  })

  it('refuses, closing nothing, a session it did not start — open or ended — and a second argument', async () => {
    const someoneElses: ClosableSession = {
      sessionId: 'cold-session',
      backendId: 'claude',
      title: 'Old run',
      treeRoot: WS
    }
    const { verb, closed } = harness(
      [session('me', 'claude'), session('other', 'claude')],
      {},
      [],
      [someoneElses]
    )
    for (const ref of ['other', 'other title', 'Old run', 'cold-session']) {
      const reply = await verb(['close', ref], from('me'))
      expect(reply.exit).not.toBe(0)
      expect(reply.text).toContain('koloft session new')
    }
    expect(await verb(['close', 'a', 'b'], from('me'))).toMatchObject({ exit: EXIT_USAGE })
    expect(closed).toEqual([])
  })

  it('closes nothing and lists what is left when something is not committed or not pushed', async () => {
    const left = ['Changes not committed:\n?? notes.md', 'Commits on no remote branch:\nabc123 wip']
    const { verb, closed } = harness([session('me', 'claude')], {}, left)
    const reply = await verb(['close'], from('me'))
    expect(reply.exit).not.toBe(0)
    expect(reply.text).toContain('nothing was closed')
    for (const line of left) expect(reply.text).toContain(line)
    expect(closed).toEqual([])
  })
})

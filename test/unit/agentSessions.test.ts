import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  NOT_IN_YOUR_WORKSPACE,
  ONLY_THE_GLOBAL_CONDUCTOR,
  ownerSays,
  parseNewSessionArgs,
  sessionVerb,
  THAT_IS_YOU,
  workspaceVerb,
  type ClosableSession,
  type PinnedWorkspace,
  type Target
} from '../../src/main/agentSessions'
import { crossSessionLine } from '../../src/main/crossSessionMessage'
import { handoverPreamble } from '../../src/main/handover'
import { StartedSessions } from '../../src/main/startedSessions'
import { EXIT_USAGE, type AgentReply } from '../../src/main/agentRequests'
import type {
  BackendId,
  CreateTabOptions,
  SessionInfo,
  SessionRow,
  WorkspaceRows
} from '../../src/shared/types'
import type { Turn } from '../../src/shared/turns'

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

interface Conducting {
  scopes?: Record<string, string>
  sidebar?: WorkspaceRows[]
  turns?: Record<string, Turn[]>
  conductors?: Record<string, Target>
  ready?: (tabId: string, turnEnded: boolean, ms: number) => boolean | Promise<boolean>
  bypass?: string[]
  answer?: (tabId: string, reply: string) => string | undefined
  titleReply?: string | null
}

interface Started {
  conductorTab: string
  tabId: string
  name: string
  workspace: string
  backend: BackendId
}

function harness(
  sessions: SessionInfo[],
  peerNames: Record<string, string> = {},
  left: string[] = [],
  conducting: Conducting = {},
  cold: ClosableSession[] = []
): {
  verb: (args: string[], from: { tabId: string; cwd: string }) => Promise<AgentReply>
  launched: Launch[]
  queued: { tabId: string; text: string; clientId?: string }[]
  closed: string[]
  touched: { tabId: string; key: string }[]
  reads: { key: string; n: number }[]
  lines: { tabId: string; line: string }[]
  typed: { tabId: string; text: string }[]
  resumed: string[]
  stopped: string[]
  started: Started[]
  answers: { tabId: string; reply: string }[]
  commands: { callerTab: string; key: string; text: string }[]
  undelivered: { callerTab: string; name: string; why: string }[]
  startedSessions: StartedSessions
} {
  const answers: { tabId: string; reply: string }[] = []
  const commands: { callerTab: string; key: string; text: string }[] = []
  const undelivered: { callerTab: string; name: string; why: string }[] = []
  const launched: Launch[] = []
  const queued: { tabId: string; text: string; clientId?: string }[] = []
  const closed: string[] = []
  const touched: { tabId: string; key: string }[] = []
  const reads: { key: string; n: number }[] = []
  const lines: { tabId: string; line: string }[] = []
  const typed: { tabId: string; text: string }[] = []
  const resumed: string[] = []
  const stopped: string[] = []
  const started: Started[] = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-started-'))
  const startedSessions = new StartedSessions(() => path.join(dir, 'started-sessions.json'))
  const inner = sessionVerb({
    workspaceOf: (tabId) => sessions.find((s) => s.tabId === tabId)?.cwd,
    allSessions: () => sessions,
    pinnedWorkspaces: () => PINNED,
    peerNames: () => async (sessionId) => peerNames[sessionId] ?? null,
    launch: async (spec) => {
      launched.push(spec)
      return 'new-tab'
    },
    assist: async () => conducting.titleReply ?? null,
    queue: async (tabId, text, clientId) => {
      queued.push({ tabId, text, clientId })
    },
    startedSessions,
    closable: () => [...sessions, ...cold],
    whatIsLeft: async () => left,
    closeSoon: (target) => {
      closed.push(target.sessionId)
    },
    conductorScope: (tabId) => conducting.scopes?.[tabId],
    sidebar: () => conducting.sidebar ?? [],
    readTurns: async (key, n) => {
      reads.push({ key, n })
      return (conducting.turns?.[key] ?? []).slice(-n)
    },
    touch: (tabId, key) => {
      if (conducting.scopes?.[tabId]) touched.push({ tabId, key })
    },
    conductorOf: (ref) => conducting.conductors?.[ref],
    resume: async (r) => {
      resumed.push(r.id)
      return `${r.id}-tab`
    },
    ready: async (tabId, ms, turnEnded) => conducting.ready?.(tabId, turnEnded, ms) ?? true,
    sendLine: async (tabId, line) => {
      lines.push({ tabId, line })
    },
    typeInto: async (tabId, text) => {
      typed.push({ tabId, text })
    },
    modeOf: (tabId) => (conducting.bypass?.includes(tabId) ? 'bypass' : 'prompting'),
    stop: (tabId) => {
      stopped.push(tabId)
    },
    started: (conductorTab, tabId, name, workspace, backend) => {
      started.push({ conductorTab, tabId, name, workspace, backend })
    },
    answer: async (tabId, reply) => {
      answers.push({ tabId, reply })
      return conducting.answer?.(tabId, reply)
    },
    undelivered: (callerTab, target, why) => {
      undelivered.push({ callerTab, name: target.name, why })
    },
    command: async (callerTab, target, text) => {
      commands.push({ callerTab, key: target.key, text })
      return `Typing ${text} into ${target.name}.`
    },
    screen: async (tabId) =>
      tabId === 'fix' ? { lines: ['', '$ ls', 'a.txt', '', ''], notes: [] } : { error: 'no window' }
  })
  const verb = async (args: string[], from: { tabId: string; cwd: string }): Promise<AgentReply> =>
    inner(args, { ...from, session: sessions.find((s) => s.tabId === from.tabId)! })
  return {
    verb,
    launched,
    queued,
    closed,
    touched,
    reads,
    lines,
    typed,
    resumed,
    stopped,
    started,
    answers,
    commands,
    undelivered,
    startedSessions
  }
}

function row(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    title: `${id} title`,
    cwd: WS,
    worktree: 'main',
    running: false,
    invalidCwd: false,
    mtime: Date.now(),
    backendId: 'claude',
    host: 'local',
    ...over
  }
}

function sidebar(entries: [string, SessionRow[]][]): WorkspaceRows[] {
  return entries.map(([wsPath, rows]) => ({
    workspace: { path: wsPath, missing: wsPath === '/work/gone', isGit: true, hasHistory: false },
    rows
  }))
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
  it('tells a Claude child of a Claude caller who started it, to treat its messages as the owner’s, and to answer with SendMessage', () => {
    const text = handoverPreamble({ name: 'planner', id: 'planner-id' }, 'claude')
    expect(text).toContain('"planner"')
    expect(text).toContain("the owner's instructions")
    expect(text).toContain('SendMessage')
  })

  it('tells a Codex child to answer with koloft session send and the caller’s id', () => {
    const text = handoverPreamble({ id: CODEX_THREAD }, 'codex')
    expect(text).toContain(`koloft session send ${CODEX_THREAD}`)
    expect(text).not.toContain('SendMessage')
  })

  it('tells a child of the other kind to answer with koloft session send, since SendMessage only joins two Claude sessions', () => {
    const fromClaude = handoverPreamble({ name: 'planner', id: 'planner-id' }, 'codex')
    expect(fromClaude).toContain('the session "planner"')
    expect(fromClaude).toContain('koloft session send planner-id')
    expect(fromClaude).not.toContain('SendMessage')
    expect(handoverPreamble({ id: CODEX_THREAD }, 'claude')).toContain(
      `koloft session send ${CODEX_THREAD}`
    )
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
  it('a Claude caller starts a named Claude sibling in its workspace whose first message says who to report to, since the transcript replays that message on every resume while a SessionStart note lives only as long as its tab', async () => {
    const { verb, launched } = harness([session('me', 'claude')], { 'me-session': 'planner' })
    const reply = await verb(['new', '-w', 'links', '--', 'Fix the links.'], from('me'))
    expect(launched).toHaveLength(1)
    const [spec] = launched
    expect(spec).toMatchObject({ kind: 'claude', cwd: WS, worktree: 'links' })
    expect(
      spec.firstPrompt?.startsWith(
        handoverPreamble({ name: 'planner', id: 'me-session' }, 'claude')
      )
    ).toBe(true)
    expect(spec.firstPrompt?.endsWith('Fix the links.')).toBe(true)
    expect(reply.text).toContain(`"${spec.name}"`)
  })

  it('a Claude sibling with no --name is named by the title model from its task, since --name stops Claude titling the session itself and the name is what every surface shows', async () => {
    const { verb, launched } = harness([session('me', 'claude')], {}, [], {
      titleReply: '「修复侧栏标题」\n'
    })
    const reply = await verb(
      ['new', '--', '修一个问题并发 PR：侧栏标题太长。\n\n背景：…'],
      from('me')
    )
    expect(launched[0].name).toBe('修复侧栏标题')
    expect(reply.text).toContain('"修复侧栏标题"')
  })

  it('a sibling whose title model gives nothing is named by the first line of its task, without the lines after it', async () => {
    const { verb, launched } = harness([session('me', 'claude')])
    await verb(['new', '--', '让 agent 开的会话标题更好读\n背景：PR #357 之后…'], from('me'))
    expect(launched[0].name).toBe('让 agent 开的会话标题更好读')
  })

  it('a made-up name already shown by a live session gets a number, so a message to it reaches one session', async () => {
    const { verb, launched } = harness(
      [session('me', 'claude'), session('rel', 'claude', { title: '发布新版本' })],
      {},
      [],
      { titleReply: '发布新版本' }
    )
    await verb(['new', '--', '发一个新版本。'], from('me'))
    expect(launched[0].name).toBe('发布新版本 2')
  })

  it('a Claude caller with no registry name hands over under its Koloft title, and its own --name is kept', async () => {
    const { verb, launched } = harness([session('me', 'claude')], {}, [], { titleReply: 'other' })
    await verb(['new', '--name', 'docs-fixer', '--', 'go'], from('me'))
    expect(launched[0].name).toBe('docs-fixer')
    expect(launched[0].firstPrompt).toContain('"me title"')
  })

  it('a Codex caller starts a Codex sibling told, beside its first message, to report back to its thread id, so the task alone is what Codex names the thread by; the caller gets the tab id to reach it by', async () => {
    const { verb, launched } = harness([session('me', 'codex', { nativeSessionId: CODEX_THREAD })])
    const reply = await verb(['new', '--', 'Check the tests.'], from('me'))
    expect(launched[0]).toMatchObject({
      kind: 'codex',
      name: undefined,
      firstPrompt: 'Check the tests.'
    })
    expect(launched[0].role).toContain(`koloft session send ${CODEX_THREAD}`)
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
    const { verb, closed, startedSessions } = harness([session('me', 'claude')], {}, [], {}, [
      ended
    ])
    startedSessions.started('gone-tab', 'me-session')
    startedSessions.bound('gone-tab', 'kid-session')
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
      {},
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

describe('a conductor’s view of sessions: its binding sets the scope', () => {
  const CODEX_KEY = `codex:local:${CODEX_THREAD}`
  const conductor = (tabId: string): SessionInfo =>
    session(tabId, 'claude', { cwd: '/conductors/global' })
  const live = [
    conductor('global'),
    conductor('wsCond'),
    session('fix', 'claude', { sessionId: 'fix-id', title: 'fix-login', status: 'working' })
  ]
  const rows = sidebar([
    [
      WS,
      [
        row('fix-id', { running: true }),
        row(CODEX_KEY, {
          backendId: 'codex',
          nativeSessionId: CODEX_THREAD,
          title: 'docs-links',
          mtime: Date.now() - 2 * 3_600_000
        }),
        row('starting-tab', { pending: true })
      ]
    ],
    [OTHER_WS, [row('site-id', { title: 'site-build' })]],
    ['ssh://box/srv/api', [row('api-id', { title: 'api-fix', host: 'ssh' })]]
  ])
  const turns: Record<string, Turn[]> = {
    'fix-id': [
      { said: [{ who: 'owner', text: 'first', at: 1 }], reply: 'one', at: 1 },
      {
        said: [
          { who: 'owner', text: 'fix the login', at: 2 },
          { who: 'peer', text: 'also the tests', at: 3 }
        ],
        reply: 'Looking.\n\nFixed both.',
        at: 4
      }
    ],
    [CODEX_KEY]: [{ said: [{ who: 'owner', text: 'check docs', at: 1 }], reply: 'DONE', at: 2 }]
  }
  const conducting = {
    scopes: { global: 'global', wsCond: WS },
    sidebar: rows,
    turns
  }

  it('a workspace conductor lists its own workspace’s sessions, open and closed, with backend, host, state, last active and id', async () => {
    const { verb } = harness(live, {}, [], conducting)
    const reply = await verb(['list'], from('wsCond'))
    expect(reply.exit).toBe(0)
    expect(reply.text.split('\n')).toEqual([
      'fix-login · Claude · local · working · last active just now · id: fix-id',
      `docs-links · Codex · local · closed · last active 2 h ago · id: ${CODEX_THREAD}`
    ])
  })

  it('the global conductor lists every workspace’s sessions with a workspace column, a remote one under its machine', async () => {
    const { verb } = harness(live, {}, [], conducting)
    const lines = (await verb(['list'], from('global'))).text.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe(
      `fix-login · Claude · local · working · last active just now · id: fix-id · workspace: ${WS}`
    )
    expect(lines[3]).toBe(
      'api-fix · Claude · box · closed · last active just now · id: api-id · workspace: box:/srv/api'
    )
  })

  it('a session that is not a conductor keeps listing only the open sessions of a workspace', async () => {
    const { verb } = harness(live, {}, [], conducting)
    expect((await verb(['list'], from('fix'))).text).toBe('fix-login (you) · Claude · working')
  })

  it('session read prints what the owner, a peer and the session said in the last N turns, found by name or id, and marks the session touched', async () => {
    const { verb, touched } = harness(live, {}, [], conducting)
    expect((await verb(['read', 'fix-login'], from('wsCond'))).text).toBe(
      'owner: fix the login\npeer: also the tests\nassistant: Looking.\n\nFixed both.'
    )
    expect((await verb(['read', 'fix-id', '--last', '2'], from('wsCond'))).text).toBe(
      'owner: first\nassistant: one\n\nowner: fix the login\npeer: also the tests\nassistant: Looking.\n\nFixed both.'
    )
    expect((await verb(['read', CODEX_THREAD], from('global'))).text).toBe(
      'owner: check docs\nassistant: DONE'
    )
    expect(touched).toEqual([
      { tabId: 'wsCond', key: 'fix-id' },
      { tabId: 'wsCond', key: 'fix-id' },
      { tabId: 'global', key: CODEX_KEY }
    ])
  })

  it('a conductor finds an open Claude session by the name it was started under: the list shows the name, read takes it, and answer’s reply calls it by that name, not its title', async () => {
    const { verb } = harness(live, { 'fix-id': 'helper-1a2b3c' }, [], conducting)
    expect((await verb(['list'], from('wsCond'))).text.split('\n')[0]).toBe(
      'fix-login · Claude · local · working · last active just now · id: fix-id · name: helper-1a2b3c'
    )
    expect((await verb(['read', 'helper-1a2b3c'], from('wsCond'))).text).toBe(
      'owner: fix the login\npeer: also the tests\nassistant: Looking.\n\nFixed both.'
    )
    expect((await verb(['answer', 'helper-1a2b3c', '2'], from('wsCond'))).text).toBe(
      'Answered helper-1a2b3c.'
    )
  })

  it('a workspace conductor is told a session in another workspace is not in its workspace, and nothing is read', async () => {
    const { verb, reads, touched } = harness(live, {}, [], conducting)
    for (const ref of ['site-build', 'api-id']) {
      const reply = await verb(['read', ref], from('wsCond'))
      expect(reply.exit).not.toBe(0)
      expect(reply.text).toContain(NOT_IN_YOUR_WORKSPACE)
    }
    expect(reads).toEqual([])
    expect(touched).toEqual([])
  })

  it('read refuses a bad --last, an unknown session and a session still starting', async () => {
    const { verb, reads } = harness(live, {}, [], conducting)
    for (const args of [
      ['read'],
      ['read', 'fix-id', '--last', '0'],
      ['read', 'fix-id', '--last', '21'],
      ['read', 'fix-id', '--first', '2']
    ])
      expect(await verb(args, from('global'))).toMatchObject({ exit: EXIT_USAGE })
    for (const ref of ['nobody', 'starting-tab'])
      expect((await verb(['read', ref], from('global'))).text).toContain('there is no session')
    expect(reads).toEqual([])
  })
})

describe('a conductor acting on the sessions it looks after: send, resume, stop, close and new', () => {
  const CODEX_KEY = `codex:local:${CODEX_THREAD}`
  const live = [
    session('wsCond', 'claude', { sessionId: 'cond-id', title: 'app conductor' }),
    session('global', 'claude', { sessionId: 'global-id', cwd: '/conductors/global' }),
    session('fix', 'claude', { sessionId: 'fix-id', title: 'fix-login', status: 'working' }),
    session('cx', 'codex', {
      sessionId: CODEX_KEY,
      nativeSessionId: CODEX_THREAD,
      title: 'docs-links'
    }),
    session('api', 'claude', {
      sessionId: 'api-id',
      title: 'api-fix',
      host: 'ssh',
      remote: { host: 'box' }
    })
  ]
  const rows = sidebar([
    [
      WS,
      [
        row('fix-id', { running: true }),
        row(CODEX_KEY, { backendId: 'codex', nativeSessionId: CODEX_THREAD, running: true }),
        row('old-id', { title: 'old-work' })
      ]
    ],
    ['ssh://box/srv/api', [row('api-id', { title: 'api-fix', host: 'ssh', running: true })]],
    [OTHER_WS, [row('site-id', { title: 'site-build' })]]
  ])
  const conductorTarget = (over: Partial<Target>): Target => ({
    key: 'conductor:b1',
    name: 'the app conductor',
    backend: 'claude',
    remote: false,
    tabId: 'wsCond',
    open: async () => 'reopened-tab',
    ...over
  })
  const conducting = (over: Partial<Conducting> = {}): Conducting => ({
    scopes: { wsCond: WS, global: 'global' },
    sidebar: rows,
    conductors: {
      'cond-id': conductorTarget({}),
      'global-id': conductorTarget({ tabId: 'global' })
    },
    ...over
  })

  it('send reaches a local Claude session through its message socket with the conductor’s own permission mode, and a Codex one through its queue with a conductor message id; both are touched', async () => {
    const { verb, lines, queued, touched } = harness(
      live,
      {},
      [],
      conducting({ bypass: ['wsCond'] })
    )
    expect((await verb(['send', 'fix-login', 'also', 'the tests'], from('wsCond'))).exit).toBe(0)
    expect((await verb(['send', CODEX_THREAD, 'check docs'], from('wsCond'))).exit).toBe(0)
    expect((await verb(['send', 'fix-id', 'hi'], from('global'))).exit).toBe(0)
    expect(lines).toEqual([
      { tabId: 'fix', line: crossSessionLine('bypass', ownerSays('also the tests')) },
      { tabId: 'fix', line: crossSessionLine('prompting', ownerSays('hi')) }
    ])
    expect(queued).toEqual([
      { tabId: 'cx', text: ownerSays('check docs'), clientId: 'koloft-conductor-1' }
    ])
    expect(touched).toEqual([
      { tabId: 'wsCond', key: 'fix-id' },
      { tabId: 'wsCond', key: CODEX_KEY },
      { tabId: 'global', key: 'fix-id' }
    ])
  })

  it('send types into a Claude session on another machine at once when its turn has ended; while it is busy it answers at once, types when the turn ends, and reports to the conductor a turn that never does', async () => {
    const turnEnds: ((ended: boolean) => void)[] = []
    const busy = harness(
      live,
      {},
      [],
      conducting({
        ready: (_tab, turnEnded, ms) =>
          !turnEnded || (ms > 0 && new Promise<boolean>((resolve) => turnEnds.push(resolve)))
      })
    )
    expect(await busy.verb(['send', 'api-fix', 'hi'], from('global'))).toMatchObject({
      exit: 0,
      text: 'Will deliver when api-fix is ready.'
    })
    expect(busy.typed).toEqual([])
    await vi.waitFor(() => expect(turnEnds).toHaveLength(1))
    turnEnds[0](true)
    await vi.waitFor(() => expect(busy.typed).toEqual([{ tabId: 'api', text: ownerSays('hi') }]))
    await busy.verb(['send', 'api-fix', 'again'], from('global'))
    await vi.waitFor(() => expect(turnEnds).toHaveLength(2))
    turnEnds[1](false)
    await vi.waitFor(() =>
      expect(busy.undelivered).toEqual([
        { callerTab: 'global', name: 'api-fix', why: expect.stringContaining('stayed busy') }
      ])
    )
    expect(busy.typed).toHaveLength(1)
    expect(busy.lines).toEqual([])

    const idle = harness(live, {}, [], conducting())
    expect((await idle.verb(['send', 'api-fix', 'hi'], from('global'))).text).toBe(
      'Typed into api-fix.'
    )
  })

  it('send to a closed session answers at once, resumes it and sends once it is ready; one that never gets ready is reported to the conductor', async () => {
    const ready = harness(live, {}, [], conducting())
    expect((await ready.verb(['send', 'old-work', 'go'], from('wsCond'))).text).toBe(
      'Will deliver when old-work is ready.'
    )
    expect(ready.resumed).toEqual(['old-id'])
    await vi.waitFor(() =>
      expect(ready.lines).toEqual([
        { tabId: 'old-id-tab', line: crossSessionLine('prompting', ownerSays('go')) }
      ])
    )
    const slow = harness(live, {}, [], conducting({ ready: () => false }))
    expect((await slow.verb(['send', 'old-work', 'go'], from('wsCond'))).exit).toBe(0)
    await vi.waitFor(() =>
      expect(slow.undelivered).toEqual([
        { callerTab: 'wsCond', name: 'old-work', why: expect.stringContaining('not get ready') }
      ])
    )
    expect(slow.lines).toEqual([])
  })

  it('answer hands the reply to the dialog the session shows and touches it; a closed session, the conductor itself, a session with no dialog and a non-conductor are refused', async () => {
    const h = harness(
      live,
      {},
      [],
      conducting({
        answer: (tab) => (tab === 'cx' ? 'it shows no question or approval right now.' : undefined)
      })
    )
    expect((await h.verb(['answer', 'fix-login', '2'], from('wsCond'))).text).toBe(
      'Answered fix-login.'
    )
    expect((await h.verb(['answer', CODEX_THREAD, 'yes'], from('wsCond'))).text).toBe(
      'koloft session answer: docs-links: it shows no question or approval right now.'
    )
    expect((await h.verb(['answer', 'old-work', 'yes'], from('wsCond'))).text).toContain(
      'it is not open'
    )
    expect((await h.verb(['answer', 'cond-id', '1'], from('wsCond'))).text).toContain(THAT_IS_YOU)
    expect((await h.verb(['answer', 'fix-login', '1'], from('fix'))).exit).not.toBe(0)
    expect(await h.verb(['answer', 'fix-login'], from('wsCond'))).toMatchObject({
      exit: EXIT_USAGE
    })
    expect(h.answers).toEqual([
      { tabId: 'fix', reply: '2' },
      { tabId: 'cx', reply: 'yes' }
    ])
    expect(h.touched.map((t) => t.key)).toEqual(['fix-id', CODEX_KEY, 'old-id'])
  })

  it('command hands one slash command to Koloft for a session it looks after, or for itself with "me", and touches the session', async () => {
    const h = harness(live, {}, [], conducting())
    expect(
      (await h.verb(['command', 'fix-login', '/compact', 'keep', 'the', 'plan'], from('wsCond')))
        .text
    ).toBe('Typing /compact keep the plan into fix-login.')
    expect((await h.verb(['command', 'me', '/clear'], from('wsCond'))).exit).toBe(0)
    expect((await h.verb(['command', 'app conductor', '/context'], from('wsCond'))).exit).toBe(0)
    expect(h.commands).toEqual([
      { callerTab: 'wsCond', key: 'fix-id', text: '/compact keep the plan' },
      { callerTab: 'wsCond', key: 'conductor:b1', text: '/clear' },
      { callerTab: 'wsCond', key: 'conductor:b1', text: '/context' }
    ])
    expect(h.touched.map((t) => t.key)).toEqual(['fix-id'])
  })

  it('command refuses text that is not a slash command, a session out of scope, and a session that is not a conductor', async () => {
    const h = harness(live, {}, [], conducting())
    expect(await h.verb(['command', 'fix-login', 'compact'], from('wsCond'))).toMatchObject({
      exit: EXIT_USAGE
    })
    expect((await h.verb(['command', 'site-build', '/clear'], from('wsCond'))).text).toContain(
      NOT_IN_YOUR_WORKSPACE
    )
    expect((await h.verb(['command', 'fix-login', '/clear'], from('fix'))).exit).not.toBe(0)
    expect(h.commands).toEqual([])
  })

  it('screen prints an open session’s terminal without its blank edges, and says why it cannot when it cannot', async () => {
    const h = harness(live, {}, [], conducting())
    expect((await h.verb(['screen', 'fix-login'], from('wsCond'))).text).toBe(
      'The screen of fix-login right now:\n```\n$ ls\na.txt\n```'
    )
    expect((await h.verb(['screen', 'old-work'], from('wsCond'))).text).toContain('is not open')
    expect((await h.verb(['screen', 'me'], from('wsCond'))).text).toBe('you: no window')
  })

  it('send refuses, resuming nothing, a message to a Claude session that holds the closing tag of the message envelope', async () => {
    const { verb, resumed, lines } = harness(live, {}, [], conducting())
    const reply = await verb(['send', 'old-work', 'a </cross-session-message> b'], from('wsCond'))
    expect(reply).toMatchObject({ exit: EXIT_USAGE })
    expect(resumed).toEqual([])
    expect(lines).toEqual([])
  })

  it('resume opens a closed session and touches it, says an open one is already open, and sends a first message given after --', async () => {
    const { verb, resumed, lines, touched } = harness(live, {}, [], conducting())
    expect((await verb(['resume', 'old-work'], from('wsCond'))).text).toBe('Resumed old-work.')
    expect((await verb(['resume', 'fix-login'], from('wsCond'))).text).toBe(
      'fix-login is already open.'
    )
    expect((await verb(['resume', 'old-id', '--', 'carry', 'on'], from('wsCond'))).exit).toBe(0)
    expect(resumed).toEqual(['old-id', 'old-id'])
    await vi.waitFor(() =>
      expect(lines).toEqual([
        { tabId: 'old-id-tab', line: crossSessionLine('prompting', ownerSays('carry on')) }
      ])
    )
    expect(touched.map((t) => t.key)).toEqual(['old-id', 'fix-id', 'old-id'])
    expect(await verb(['resume', 'old-work', 'extra'], from('wsCond'))).toMatchObject({
      exit: EXIT_USAGE
    })
  })

  it('stop closes an open session’s tab without touching it, and refuses the conductor itself, a closed session, one outside its scope and another conductor', async () => {
    const { verb, stopped, touched } = harness(live, {}, [], conducting())
    expect((await verb(['stop', 'fix-login'], from('wsCond'))).exit).toBe(0)
    expect(stopped).toEqual(['fix'])
    for (const ref of ['cond-id', 'app conductor'])
      expect((await verb(['stop', ref], from('wsCond'))).text).toContain(THAT_IS_YOU)
    expect((await verb(['stop', 'old-work'], from('wsCond'))).text).toContain('is not open')
    expect((await verb(['stop', 'site-build'], from('wsCond'))).text).toContain(
      NOT_IN_YOUR_WORKSPACE
    )
    expect((await verb(['stop', 'global-id'], from('wsCond'))).text).toContain(
      'there is no session'
    )
    expect(stopped).toEqual(['fix'])
    expect(touched).toEqual([])
  })

  const ENDED_CODEX = `codex:local:${OTHER_THREAD}`
  const ended = (sessionId: string, backendId: BackendId, title: string): ClosableSession => ({
    sessionId,
    backendId,
    title,
    treeRoot: WS
  })
  const ENDED = [
    ended('old-id', 'claude', 'old-work'),
    ended(ENDED_CODEX, 'codex', 'docs-check'),
    ended('api-old', 'claude', 'api-old'),
    ended('site-id', 'claude', 'site-build')
  ]

  it('close takes an ended session on this computer, Claude or Codex, off the list, and refuses, closing nothing, an open one, one on another machine and one outside its scope', async () => {
    const withEnded = sidebar([
      [
        WS,
        [
          row('fix-id', { running: true }),
          row('old-id', { title: 'old-work' }),
          row(ENDED_CODEX, { backendId: 'codex', nativeSessionId: OTHER_THREAD })
        ]
      ],
      ['ssh://box/srv/api', [row('api-old', { title: 'api-old', host: 'ssh' })]],
      [OTHER_WS, [row('site-id', { title: 'site-build' })]]
    ])
    const { verb, closed } = harness(live, {}, [], conducting({ sidebar: withEnded }), ENDED)
    expect((await verb(['close', 'old-work'], from('wsCond'))).exit).toBe(0)
    expect((await verb(['close', OTHER_THREAD], from('global'))).exit).toBe(0)
    expect(closed).toEqual(['old-id', ENDED_CODEX])
    expect((await verb(['close', 'fix-login'], from('wsCond'))).text).toContain('is open')
    expect((await verb(['close', 'api-old'], from('global'))).text).toContain('another machine')
    expect((await verb(['close', 'site-build'], from('wsCond'))).text).toContain(
      NOT_IN_YOUR_WORKSPACE
    )
    expect(closed).toEqual(['old-id', ENDED_CODEX])
    expect((await verb(['close'], from('wsCond'))).exit).toBe(0)
    expect(closed).toEqual(['old-id', ENDED_CODEX, 'cond-id'])
  })

  it('close from a conductor closes nothing and lists what is left when an ended session’s worktree holds work', async () => {
    const left = ['Changes not committed:\n?? notes.md']
    const { verb, closed } = harness(live, {}, left, conducting(), ENDED)
    const reply = await verb(['close', 'old-work'], from('wsCond'))
    expect(reply.exit).not.toBe(0)
    expect(reply.text).toContain(left[0])
    expect(closed).toEqual([])
  })

  it('a session that is not a conductor cannot resume, stop or pick --backend', async () => {
    const { verb, stopped, resumed, launched } = harness(live, {}, [], conducting())
    for (const args of [
      ['resume', 'old-work'],
      ['stop', 'api-fix']
    ])
      expect((await verb(args, from('fix'))).exit).not.toBe(0)
    expect(await verb(['new', '--backend', 'codex', '--', 'go'], from('fix'))).toMatchObject({
      exit: EXIT_USAGE
    })
    expect([...stopped, ...resumed, ...launched]).toEqual([])
  })

  it('new from a conductor: --backend picks the kind, the global conductor must name a workspace, a workspace conductor stays in its own, and each start is announced', async () => {
    const { verb, launched, started } = harness(
      live,
      { 'cond-id': 'app-conductor' },
      [],
      conducting()
    )
    expect((await verb(['new', '--', 'go'], from('global'))).exit).not.toBe(0)
    expect(
      (await verb(['new', '--workspace', OTHER_WS, '--', 'go'], from('wsCond'))).exit
    ).not.toBe(0)
    expect(launched).toEqual([])

    await verb(
      ['new', '--workspace', OTHER_WS, '--backend', 'codex', '--', 'check'],
      from('global')
    )
    await verb(['new', '--', 'fix it'], from('wsCond'))
    expect(launched.map((l) => [l.kind, l.cwd])).toEqual([
      ['codex', OTHER_WS],
      ['claude', WS]
    ])
    expect(launched[0].role).toContain('koloft session send global-id')
    expect(launched[1].firstPrompt).toContain('"app-conductor" with your SendMessage tool')
    expect(started).toEqual([
      {
        conductorTab: 'global',
        tabId: 'new-tab',
        name: 'a Codex session',
        workspace: OTHER_WS,
        backend: 'codex'
      },
      {
        conductorTab: 'wsCond',
        tabId: 'new-tab',
        name: launched[1].name,
        workspace: WS,
        backend: 'claude'
      }
    ])
  })

  it('a session a conductor starts gets the conductor’s own permission: bypass under a bypass conductor, the default otherwise', async () => {
    const { verb, launched } = harness(live, {}, [], conducting({ bypass: ['global'] }))
    await verb(['new', '--workspace', WS, '--backend', 'codex', '--', 'go'], from('global'))
    await verb(['new', '--', 'go'], from('wsCond'))
    expect(launched.map((l) => l.permission)).toEqual(['bypass', 'default'])
  })

  it('any session reports back to the conductor that started it by the conductor’s id, which is hidden from every list, with its own mode and no owner label', async () => {
    const opened: string[] = []
    const { verb, lines, queued } = harness(
      live,
      {},
      [],
      conducting({
        conductors: {
          'cond-id': conductorTarget({}),
          'codex-cond': conductorTarget({ backend: 'codex', tabId: 'cc' }),
          'closed-cond': conductorTarget({
            key: 'conductor:b3',
            tabId: undefined,
            open: async () => {
              opened.push('b3')
              return 'b3-tab'
            }
          })
        }
      })
    )
    expect((await verb(['send', 'cond-id', 'done'], from('fix'))).exit).toBe(0)
    expect((await verb(['send', 'codex-cond', 'done'], from('cx'))).exit).toBe(0)
    expect((await verb(['send', 'closed-cond', 'done'], from('fix'))).exit).toBe(0)
    await vi.waitFor(() =>
      expect(lines).toEqual([
        { tabId: 'wsCond', line: crossSessionLine('prompting', 'done') },
        { tabId: 'b3-tab', line: crossSessionLine('prompting', 'done') }
      ])
    )
    expect(queued).toEqual([{ tabId: 'cc', text: 'done', clientId: 'koloft-conductor-1' }])
    expect(opened).toEqual(['b3'])
  })
})

describe('koloft workspace list', () => {
  const rows = sidebar([
    [WS, [row('a', { running: true }), row('b')]],
    ['/work/gone', []],
    ['ssh://box/srv/api', [row('c', { running: true, host: 'ssh' })]]
  ])
  const verb = workspaceVerb({
    conductorScope: (tabId) => ({ global: 'global', wsCond: WS })[tabId],
    sidebar: () => rows
  })
  const caller = (tabId: string) => ({ tabId, cwd: WS, session: session(tabId, 'claude') })

  it('the global conductor gets every sidebar workspace with its path and how many sessions are open', async () => {
    expect((await verb(['list'], caller('global'))).text.split('\n')).toEqual([
      `app · ${WS} · 1 open`,
      'gone · /work/gone · 0 open · folder missing',
      'api · box:/srv/api · 1 open'
    ])
  })

  it('a workspace conductor and a plain session are refused', async () => {
    for (const tabId of ['wsCond', 'plain'])
      expect(await verb(['list'], caller(tabId))).toMatchObject({
        exit: 1,
        text: ONLY_THE_GLOBAL_CONDUCTOR
      })
  })
})

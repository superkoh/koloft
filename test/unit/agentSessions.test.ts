import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  parseNewSessionArgs,
  sessionSays,
  sessionVerb,
  THAT_IS_YOU,
  workspaceVerb,
  type ClosableSession,
  type PinnedWorkspace,
  type Target
} from '../../src/main/agentSessions'
import { crossSessionLine } from '../../src/main/crossSessionMessage'
import { ownerSays } from '../../src/shared/agentGuide'
import { handoverPreamble } from '../../src/main/handover'
import { StartedSessions } from '../../src/main/startedSessions'
import { EXIT_USAGE, type AgentReply } from '../../src/main/agentRequests'
import type {
  BackendId,
  CreateTabOptions,
  QueuedLaunch,
  SessionInfo,
  SessionRow,
  WorkspaceRows
} from '../../src/shared/types'
import type { Turn } from '../../src/shared/turns'

const WS = '/work/app'
const BUTLER_FOLDER = '/data/conductors/global'
const BUTLER_HELPER_ROLE = 'You help Alfred.'
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
const MUSE_ID = '01a13795-6b09-7531-bdd6-84ce54f976ea'

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
  quotedPrompts?: Record<string, string>
  conductors?: Record<string, Target>
  ready?: (tabId: string, turnEnded: boolean, ms: number) => boolean | Promise<boolean>
  bypass?: string[]
  answer?: (tabId: string, reply: string) => string | undefined
  titleReply?: string | null
  translation?: string | null
  asking?: string[]
  worktrees?: string[]
  busy?: boolean
}

function harness(
  sessions: SessionInfo[],
  peerNames: Record<string, string> = {},
  left: string[] = [],
  conducting: Conducting = {},
  cold: ClosableSession[] = []
): {
  verb: (args: string[], from: { tabId: string; cwd: string }) => Promise<AgentReply>
  turnEnded: (tabId: string, reply: string, said?: string) => void
  waitsOnAnother: (sessionId: string) => boolean
  launched: Launch[]
  queued: { tabId: string; text: string; clientId?: string }[]
  closed: string[]
  reads: { key: string; n: number }[]
  lines: { tabId: string; line: string }[]
  pressed: { tabId: string; keys: string[] }[]
  resumed: string[]
  stopped: string[]
  answers: { tabId: string; reply: string }[]
  commands: { callerTab: string; key: string; text: string }[]
  tells: ((said: string) => void)[]
  undelivered: { callerTab: string; name: string; why: string }[]
  startedSessions: StartedSessions
  waiting: QueuedLaunch[]
  held: { tabId: string; send: () => Promise<unknown> }[]
} {
  const answers: { tabId: string; reply: string }[] = []
  const commands: { callerTab: string; key: string; text: string }[] = []
  const tells: ((said: string) => void)[] = []
  const undelivered: { callerTab: string; name: string; why: string }[] = []
  const launched: Launch[] = []
  const queued: { tabId: string; text: string; clientId?: string }[] = []
  const closed: string[] = []
  const reads: { key: string; n: number }[] = []
  const lines: { tabId: string; line: string }[] = []
  const pressed: { tabId: string; keys: string[] }[] = []
  const resumed: string[] = []
  const stopped: string[] = []
  const waiting: QueuedLaunch[] = []
  const held: { tabId: string; send: () => Promise<unknown> }[] = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-started-'))
  const startedSessions = new StartedSessions(() => path.join(dir, 'started-sessions.json'))
  const inner = sessionVerb({
    workspaceOf: (tabId) => sessions.find((s) => s.tabId === tabId)?.cwd,
    allSessions: () => sessions,
    pinnedWorkspaces: () => PINNED,
    peerNames:
      () =>
      async ({ sessionId }) =>
        peerNames[sessionId] ?? null,
    launch: async (spec) => {
      launched.push(spec)
      if (conducting.busy)
        waiting.push({
          tabId: 'new-tab',
          kind: spec.kind,
          cwd: spec.cwd ?? '',
          title: spec.name ?? 'untitled',
          since: Date.now()
        })
      return 'new-tab'
    },
    waiting: {
      list: () => waiting,
      notStartedYet: () => waiting,
      hold: (tabId, send) => {
        if (!waiting.some((q) => q.tabId === tabId)) return false
        held.push({ tabId, send })
        return true
      },
      drop: (tabId) => {
        const before = waiting.length
        waiting.splice(0, waiting.length, ...waiting.filter((q) => q.tabId !== tabId))
        return waiting.length < before
      }
    },
    assist: async (job) =>
      (job.system === 'You translate.' ? conducting.translation : conducting.titleReply) ?? null,
    queue: async (tabId, text, clientId) => {
      queued.push({ tabId, text, clientId })
    },
    startedSessions,
    closable: () => [...sessions, ...cold],
    whatIsLeft: async () => left,
    closeSoon: (target) => {
      closed.push(target.sessionId)
    },
    isButler: (tabId) => !!conducting.scopes?.[tabId],
    speaksForTheOwner: (tabId) =>
      !!conducting.scopes?.[tabId] ||
      sessions.find((s) => s.tabId === tabId)?.cwd === BUTLER_FOLDER,
    butlerFolder: () => BUTLER_FOLDER,
    butlerHelperRole: () => BUTLER_HELPER_ROLE,
    sidebar: () => conducting.sidebar ?? [],
    worktrees: async () => (conducting.worktrees ?? []).map((name) => ({ name, dir: name })),
    readTurns: async (key, n) => {
      reads.push({ key, n })
      return (conducting.turns?.[key] ?? []).slice(-n)
    },
    quotedPrompt: (tabId) => conducting.quotedPrompts?.[tabId],
    butlerTarget: (ref) => conducting.conductors?.[ref],
    resume: async (r) => {
      resumed.push(r.id)
      return `${r.id}-tab`
    },
    ready: async (tabId, ms, turnEnded) => conducting.ready?.(tabId, turnEnded, ms) ?? true,
    asking: (tabId) => conducting.asking?.includes(tabId) ?? false,
    sendLine: async (tabId, line) => {
      lines.push({ tabId, line })
    },
    press: async (tabId, keys) => {
      pressed.push({ tabId, keys })
    },
    deliver: async () => false,
    modeOf: (tabId) => (conducting.bypass?.includes(tabId) ? 'bypass' : 'prompting'),
    stop: (tabId) => {
      stopped.push(tabId)
    },
    answer: async (tabId, reply) => {
      answers.push({ tabId, reply })
      return conducting.answer?.(tabId, reply)
    },
    undelivered: (callerTab, target, why) => {
      undelivered.push({ callerTab, name: target.name, why })
    },
    command: async (callerTab, target, text, tellCaller) => {
      commands.push({ callerTab, key: target.key, text })
      tells.push(tellCaller)
      return `Typing ${text} into ${target.name}.`
    },
    screen: async (tabId) =>
      tabId === 'fix' ? { lines: ['', '$ ls', 'a.txt', '', ''], notes: [] } : { error: 'no window' }
  })
  const verb = async (args: string[], from: { tabId: string; cwd: string }): Promise<AgentReply> =>
    inner.verb(args, { ...from, session: sessions.find((s) => s.tabId === from.tabId)! })
  return {
    verb,
    turnEnded: (tabId, reply, said) =>
      inner.turnEnded(tabId, {
        said: said === undefined ? [] : [{ who: 'owner', text: said, at: 1 }],
        reply,
        at: 1
      }),
    waitsOnAnother: inner.waitsOnAnother,
    launched,
    queued,
    closed,
    reads,
    lines,
    pressed,
    resumed,
    stopped,
    answers,
    commands,
    tells,
    undelivered,
    startedSessions,
    waiting,
    held
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
  it('tells a child who started it and to treat its messages as the owner’s', () => {
    const text = handoverPreamble({ name: 'planner', id: 'planner-id', label: 'Claude' })
    expect(text).toContain('the session "planner"')
    expect(text).toContain("the owner's instructions")
    expect(handoverPreamble({ id: CODEX_THREAD, label: 'Codex' })).toContain(
      `the Codex session ${CODEX_THREAD}`
    )
    expect(handoverPreamble({ id: MUSE_ID, label: 'Muse' })).toContain(
      `the Muse session ${MUSE_ID}`
    )
  })

  it('tells a child Assist started that only the words Assist quotes in « » are the owner’s, so Assist’s own guesses never pass as the owner’s orders', () => {
    const text = handoverPreamble({
      name: 'Global-conductor',
      id: 'global-id',
      label: 'Claude',
      assist: true
    })
    expect(text).toContain("only words inside « » in its messages are the owner's own")
    expect(text).not.toContain("the owner's instructions")
  })

  it.each([
    { name: 'planner', id: 'planner-id', label: 'Claude' },
    { id: CODEX_THREAD, label: 'Codex' }
  ])(
    'tells every child of %j, Claude or Codex, to answer with koloft session send and the caller’s id, never SendMessage, since a caller that went to sleep has left ListAgents while koloft session send starts it again first',
    (caller) => {
      const text = handoverPreamble(caller)
      expect(text).toContain(`koloft session send ${caller.id} "<your result>"`)
      expect(text).not.toContain('SendMessage')
    }
  )
})

describe('koloft session list', () => {
  it('shows each session’s state, a Claude or Muse session’s name, a Claude transcript, a Codex session’s id, and marks the caller; a session showing a question reads apart from one that only finished its turn', async () => {
    const { verb } = harness(
      [
        session('me', 'claude', {
          status: 'working',
          details: { claude: { jsonlPath: '/home/.claude/projects/app/me.jsonl' } }
        }),
        session('cx', 'codex', { status: 'approval', nativeSessionId: CODEX_THREAD }),
        session('q', 'codex', { status: 'waiting', nativeSessionId: OTHER_THREAD }),
        session('done', 'claude', { status: 'waiting' }),
        session('idle', 'claude', { status: 'idle' }),
        session('mu', 'muse', { status: 'working', nativeSessionId: MUSE_ID })
      ],
      { 'me-session': 'planner', 'mu-session': 'iron-libra' },
      [],
      { asking: ['q'] }
    )
    const reply = await verb(['list'], from('me'))
    expect(reply.exit).toBe(0)
    expect(reply.text.split('\n')).toEqual([
      'me title (you) · Claude · working · name: planner · transcript: /home/.claude/projects/app/me.jsonl',
      `cx title · Codex · asking the owner a question · id: ${CODEX_THREAD}`,
      `q title · Codex · asking the owner a question · id: ${OTHER_THREAD}`,
      'done title · Claude · finished its turn',
      'idle title · Claude · idle',
      `mu title · Muse · working · id: ${MUSE_ID} · name: iron-libra`
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

describe('koloft session new from a Muse session', () => {
  it('starts a Muse sibling under the name it was given, or a short title from its task, and says to reach it by its tab id', async () => {
    const { verb, launched } = harness([session('me', 'muse', { nativeSessionId: MUSE_ID })])
    const named = await verb(['new', '--name', 'Fix links', '--', 'Fix the links.'], from('me'))
    expect(named.exit).toBe(0)
    expect(launched[0]).toMatchObject({ kind: 'muse', name: 'Fix links' })
    expect(launched[0].firstPrompt).toContain(`the Muse session ${MUSE_ID}`)
    expect(named.text).toContain('koloft session send new-tab')
    expect(named.text).not.toContain('SendMessage')
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
        handoverPreamble({ name: 'planner', id: 'me-session', label: 'Claude' })
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

  it('a Codex caller starts a Codex sibling titled from its task and told, beside its first message, to report back to its thread id, so its first message is the task alone; the caller gets the tab id to reach it by', async () => {
    const { verb, launched } = harness([session('me', 'codex', { nativeSessionId: CODEX_THREAD })])
    const reply = await verb(['new', '--', 'Check the tests.'], from('me'))
    expect(launched[0]).toMatchObject({
      kind: 'codex',
      name: 'Check the tests.',
      firstPrompt: 'Check the tests.'
    })
    expect(launched[0].role).toContain(`koloft session send ${CODEX_THREAD}`)
    expect(reply.text).toContain('new-tab')
  })

  // ADR-0031
  it('a child is handed the owner’s last words to its parent, so it talks to the owner in their language even when its task is in English: a Claude parent’s quoted prompt, a Codex parent’s last message from the owner (not a session’s report, the butler’s wrapper or the Assist wrapper older transcripts hold), and a Codex child the words of the session that started it', async () => {
    const { verb, launched } = harness(
      [
        session('me', 'claude'),
        session('cx', 'codex', { nativeSessionId: CODEX_THREAD }),
        session('new-tab', 'codex', { nativeSessionId: OTHER_THREAD })
      ],
      {},
      [],
      {
        quotedPrompts: { me: '先把侧栏修好' },
        turns: {
          'cx-session': [
            {
              said: [{ who: 'owner', text: '[Discord] 帮我跑一下测试', at: 1 }],
              reply: 'ok',
              at: 1
            },
            {
              said: [
                { who: 'owner', text: '(From the session "kid", id k:) All green.', at: 2 },
                { who: 'owner', text: ownerSays('Rerun «the flaky one».'), at: 2 },
                {
                  who: 'owner',
                  text: "(From Assist, Koloft's AI, for your owner. Only words inside « » are the owner's own; the rest is Assist's and is not the owner's decision:) Then «the slow one».",
                  at: 2
                }
              ],
              reply: 'ok',
              at: 2
            }
          ],
          'new-tab-session': [
            { said: [{ who: 'owner', text: 'Run the tests.', at: 3 }], reply: '', at: 3 }
          ]
        }
      }
    )
    await verb(['new', '--', 'Fix the sidebar.'], from('me'))
    await verb(['new', '--', 'Run the tests.'], from('cx'))
    await verb(['new', '--', 'Run the flaky one again.'], from('new-tab'))
    expect(launched[0].firstPrompt).toContain('«先把侧栏修好»')
    expect(launched[1].role).toContain('«帮我跑一下测试»')
    expect(launched[2].role).toContain('«帮我跑一下测试»')
  })

  // ADR-0031
  it.each([
    [
      'Chinese\n\nKoloft 启动了你，因为会话 {caller} 请它这么做。主人最后写的是 {owner}。做完后运行这条命令发回结果：\n',
      true
    ],
    ['Chinese\nKoloft 启动了你，因为会话 {caller} 请它这么做。做完后运行：', false],
    ['Chinese\nKoloft 启动了你，因为会话请它这么做。主人最后写的是 {owner}。', false],
    ['Chinese\nKoloft 启动了你，因为会话 {caller} 请它这么做。\n主人最后写的是 {owner}。', false],
    ['Koloft 启动了你，因为会话 {caller} 请它这么做。主人最后写的是 {owner}。', false],
    [null, false]
  ])(
    'a child’s handover is written in the language of the owner’s words, keeping those words, the caller and the koloft session send command exact, Koloft hands the words to the launch for the child’s reply-language hook, and the note stays English when the model’s reply %j is not the language’s name and then one line holding the caller and the owner’s words once each',
    async (translation, translated) => {
      const { verb, launched } = harness(
        [session('me', 'claude'), session('cx', 'codex', { nativeSessionId: CODEX_THREAD })],
        { 'me-session': 'planner' },
        [],
        {
          quotedPrompts: { me: '先把侧栏修好' },
          turns: {
            'cx-session': [
              { said: [{ who: 'owner', text: '先把侧栏修好', at: 1 }], reply: 'ok', at: 1 }
            ]
          },
          translation
        }
      )
      await verb(['new', '--', 'Fix the sidebar.'], from('me'))
      await verb(['new', '--', 'Fix the sidebar.'], from('cx'))
      const [claudeCaller, codexCaller] = translated
        ? [
            'Koloft 启动了你，因为会话 "planner" 请它',
            `Koloft 启动了你，因为会话 ${CODEX_THREAD} 请它`
          ]
        : [
            'Koloft started you because the session "planner" asked it',
            `Koloft started you because the Codex session ${CODEX_THREAD} asked it`
          ]
      expect(launched[0].firstPrompt).toMatch(
        new RegExp(
          `^${claudeCaller}[^\\n]*«先把侧栏修好»[^\\n]* koloft session send me-session "<your result>"\\n\\nFix the sidebar\\.$`
        )
      )
      expect(launched[1].firstPrompt).toBe('Fix the sidebar.')
      expect(launched[1].role).toMatch(
        new RegExp(
          `^${codexCaller}[^\\n]*«先把侧栏修好»[^\\n]* koloft session send ${CODEX_THREAD} "<your result>"$`
        )
      )
      expect(launched.map((l) => l.ownerWords)).toEqual(['先把侧栏修好', '先把侧栏修好'])
    }
  )

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

  it('a Codex or Antigravity sibling takes its --name, or a title made from its task; one in a remote workspace, Antigravity, cannot be named and gets no made-up title, since Koloft cannot reach that agy’s local API', async () => {
    const REMOTE = 'ssh://box/srv/api'
    const { verb, launched } = harness([
      session('cx', 'codex', { nativeSessionId: CODEX_THREAD }),
      session('ag', 'agy'),
      session('far', 'agy', { host: 'ssh', cwd: REMOTE, treeRoot: REMOTE })
    ])
    expect((await verb(['new', '--name', 'x', '--', 'go'], from('cx'))).exit).toBe(0)
    expect((await verb(['new', '--', 'Look around.'], from('ag'))).exit).toBe(0)
    const refused = await verb(['new', '--name', 'x', '--', 'go'], from('far'))
    expect(refused).toMatchObject({ exit: EXIT_USAGE })
    expect(refused.text).toContain('an Antigravity session in a remote workspace has no name')
    expect((await verb(['new', '--', 'Look around.'], from('far'))).exit).toBe(0)
    expect(launched.map((l) => [l.kind, l.name])).toEqual([
      ['codex', 'x'],
      ['agy', 'Look around.'],
      ['agy', undefined]
    ])
  })
})

describe('koloft session send', () => {
  const sessions = (): SessionInfo[] => [
    session('me', 'codex', { nativeSessionId: CODEX_THREAD }),
    session('cx', 'codex', { nativeSessionId: OTHER_THREAD, title: 'Test runner' }),
    session('cc', 'claude', { title: 'Planner' })
  ]

  it('queues the message, marked with who sent it, on the Codex session found by id, tab id or title, a title with spaces quoted or not', async () => {
    const { verb, queued } = harness(sessions())
    for (const ref of [[OTHER_THREAD], ['cx'], ['Test runner'], ['Test', 'runner']])
      expect((await verb(['send', ...ref, 'What', 'did you find?'], from('me'))).exit).toBe(0)
    expect(queued.map((q) => [q.tabId, q.text])).toEqual(
      Array(4).fill([
        'cx',
        expect.stringMatching(/^\(From the session "me title".*\) What did you find\?$/)
      ])
    )
  })

  it('the sender waits on another session while the one it wrote to works, until that one ends its turn or closes', async () => {
    const all = sessions()
    const cx = all.find((s) => s.tabId === 'cx')!
    cx.status = 'working'
    const me = all.find((s) => s.tabId === 'me')!.sessionId
    const { verb, turnEnded, waitsOnAnother } = harness(all)
    expect(waitsOnAnother(me)).toBe(false)
    expect((await verb(['send', 'cx', 'Run', 'the tests'], from('me'))).exit).toBe(0)
    expect(waitsOnAnother(me)).toBe(true)
    cx.alive = false
    expect(waitsOnAnother(me)).toBe(false)
    cx.alive = true
    turnEnded('cx', 'All green.')
    expect(waitsOnAnother(me)).toBe(false)
  })

  it('a Muse session reaches an open Muse or Codex session: typed into a Muse one once it is idle, queued on a Codex one, both marked with who sent it', async () => {
    const { verb, pressed, queued } = harness([
      session('me', 'muse', { nativeSessionId: MUSE_ID, title: 'Docs fixer' }),
      session('mu', 'muse', { title: 'Test runner' }),
      session('cx', 'codex', { nativeSessionId: OTHER_THREAD, title: 'Linter' })
    ])
    expect((await verb(['send', 'Test runner', 'Run', 'it'], from('me'))).exit).toBe(0)
    expect((await verb(['send', 'cx', 'Lint', 'it'], from('me'))).exit).toBe(0)
    expect(pressed).toHaveLength(1)
    expect(pressed[0]).toMatchObject({
      tabId: 'mu',
      keys: [expect.stringContaining('Run it'), '\r']
    })
    expect(pressed[0].keys[0]).toContain('Docs fixer')
    expect(queued.map((q) => [q.tabId, q.text])).toEqual([
      ['cx', expect.stringContaining('Lint it')]
    ])
  })

  it('points a Claude caller to SendMessage for a Claude target and sends nothing', async () => {
    const { verb, lines } = harness([
      ...sessions(),
      session('cc2', 'claude', { title: 'Reviewer' })
    ])
    const reply = await verb(['send', 'Reviewer', 'hi'], from('cc'))
    expect(reply.exit).not.toBe(0)
    expect(reply.text).toContain('SendMessage')
    expect(lines).toEqual([])
  })

  it('a Codex or Muse session reaches an open Claude session on its message line, marked with who sent it, and the Claude session answers it with koloft session send', async () => {
    const { verb, lines, queued, pressed } = harness([
      ...sessions(),
      session('mu', 'muse', { nativeSessionId: MUSE_ID, title: 'Docs fixer' })
    ])
    expect((await verb(['send', 'Planner', 'Check', 'it'], from('mu'))).exit).toBe(0)
    expect((await verb(['send', 'Planner', 'Lint', 'it'], from('me'))).exit).toBe(0)
    expect(lines.map((l) => l.tabId)).toEqual(['cc', 'cc'])
    expect(lines[0].line).toContain('from-mode=')
    expect(lines[0].line).toContain(`(From the session \\"Docs fixer\\", id ${MUSE_ID}:) Check it`)
    expect((await verb(['send', MUSE_ID, 'Done'], from('cc'))).exit).toBe(0)
    expect((await verb(['send', CODEX_THREAD, 'Done'], from('cc'))).exit).toBe(0)
    expect(pressed.map((p) => p.tabId)).toEqual(['mu'])
    expect(queued.map((q) => q.tabId)).toEqual(['me'])
  })

  it('a Claude or Codex child reports to the session that started it by its id or name, starting it again first if it is closed or asleep, marked with who sent it', async () => {
    const PARENT_KEY = `codex:local:${OTHER_THREAD}`
    const { verb, lines, queued, resumed, startedSessions } = harness(
      [
        session('kid', 'claude', { sessionId: 'kid-id', title: 'Fix docs' }),
        session('cxkid', 'codex', { sessionId: CODEX_THREAD, title: 'Check docs' })
      ],
      {},
      [],
      {
        sidebar: sidebar([
          [
            WS,
            [
              row('planner-id', { title: 'Planner' }),
              row(PARENT_KEY, { backendId: 'codex', nativeSessionId: OTHER_THREAD }),
              row('other-id', { title: 'Other' })
            ]
          ]
        ])
      }
    )
    startedSessions.started('kid', 'planner-id')
    startedSessions.bound('kid', 'kid-id')
    startedSessions.started('cxkid', PARENT_KEY)
    startedSessions.bound('cxkid', CODEX_THREAD)

    for (const ref of ['planner-id', 'Planner'])
      expect((await verb(['send', ref, 'done'], from('kid'))).text).toMatch(/Will deliver/)
    expect((await verb(['send', OTHER_THREAD, 'checked'], from('cxkid'))).exit).toBe(0)

    await vi.waitFor(() => expect([...new Set(resumed)]).toEqual(['planner-id', PARENT_KEY]))
    const line = (id: string): string | null =>
      crossSessionLine('prompting', '(From the session "Fix docs", id kid-id:) done', id)
    await vi.waitFor(() =>
      expect(lines).toEqual([
        { tabId: 'planner-id-tab', line: line('koloft-session-1') },
        { tabId: 'planner-id-tab', line: line('koloft-session-2') }
      ])
    )
    await vi.waitFor(() =>
      expect(queued.map((q) => [q.tabId, q.text])).toEqual([
        [`${PARENT_KEY}-tab`, `(From the session "Check docs", id ${CODEX_THREAD}:) checked`]
      ])
    )
  })

  it('a child that ends its first turn without reporting has its reply handed by Koloft to the Codex or Claude session that started it, so a parent never waits on a child that forgot; a child that reported itself is not repeated', async () => {
    const h = harness(
      [
        session('me', 'codex', { nativeSessionId: CODEX_THREAD, title: 'Lead' }),
        session('cc', 'claude', { title: 'Planner' }),
        session('new-tab', 'codex', { nativeSessionId: OTHER_THREAD, title: 'Check docs' })
      ],
      {},
      [],
      {
        sidebar: sidebar([
          [
            WS,
            [
              row('me-session', { backendId: 'codex', running: true }),
              row('cc-session', { running: true })
            ]
          ]
        ])
      }
    )
    const handed = `(From the session "Check docs", id ${OTHER_THREAD}:) Found it.`

    await h.verb(['new', '--', 'find it'], from('me'))
    h.turnEnded('new-tab', 'Found it.')
    h.turnEnded('new-tab', 'A later turn.')
    await vi.waitFor(() => expect(h.queued.map((q) => [q.tabId, q.text])).toEqual([['me', handed]]))

    await h.verb(['new', '--', 'find it'], from('cc'))
    h.turnEnded('new-tab', 'Found it.')
    await vi.waitFor(() =>
      expect(h.lines).toEqual([
        { tabId: 'cc', line: crossSessionLine('prompting', handed, 'koloft-session-1') }
      ])
    )

    await h.verb(['new', '--', 'find it'], from('me'))
    h.startedSessions.bound('new-tab', 'new-tab-session')
    await h.verb(['send', 'me-session', 'Found it myself.'], from('new-tab'))
    h.turnEnded('new-tab', 'Found it myself, again.')
    await vi.waitFor(() => expect(h.queued).toHaveLength(2))
    expect(h.queued[1].text).toContain('Found it myself.')
    expect(h.lines).toHaveLength(1)
  })

  it('reaches a Codex session open in another workspace, so a child started there can report back', async () => {
    const { verb, queued } = harness([
      session('me', 'codex', { nativeSessionId: CODEX_THREAD }),
      session('kid', 'codex', { nativeSessionId: OTHER_THREAD, cwd: OTHER_WS })
    ])
    expect((await verb(['send', CODEX_THREAD, 'done'], from('kid'))).exit).toBe(0)
    expect(queued.map((q) => [q.tabId, q.text])).toEqual([
      ['me', expect.stringMatching(/^\(From the session .*\) done$/)]
    ])
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

  it('closes a session it started with koloft session new, by its title, quoted or not, or tab id, while it is open', async () => {
    const { verb, closed } = harness([
      session('me', 'claude'),
      session('new-tab', 'claude', { title: 'Docs fixer' })
    ])
    await verb(['new', '--name', 'docs-fixer', '--', 'go'], from('me'))
    expect((await verb(['close', 'Docs fixer'], from('me'))).exit).toBe(0)
    expect((await verb(['close', 'Docs', 'fixer'], from('me'))).exit).toBe(0)
    expect((await verb(['close', 'new-tab'], from('me'))).exit).toBe(0)
    expect(closed).toEqual(Array(3).fill('new-tab-session'))
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

  it('closes a session one of its own sessions started, since the sidebar shows it under the caller, while that session is there and after it is closed', async () => {
    const grandkid: ClosableSession = {
      sessionId: 'grand-session',
      backendId: 'claude',
      title: 'Grand task',
      treeRoot: WS
    }
    const { verb, closed, startedSessions } = harness([session('me', 'claude')], {}, [], {}, [
      grandkid
    ])
    startedSessions.started('kid-tab', 'me-session')
    startedSessions.bound('kid-tab', 'kid-session')
    startedSessions.started('grand-tab', 'kid-session')
    startedSessions.bound('grand-tab', 'grand-session')
    expect((await verb(['close', 'Grand task'], from('me'))).exit).toBe(0)
    startedSessions.forget('kid-session')
    expect((await verb(['close', 'grand-session'], from('me'))).exit).toBe(0)
    expect(closed).toEqual(['grand-session', 'grand-session'])
  })

  it('closes an ended session it did not start, in any workspace, and refuses, closing nothing, an open one it did not start', async () => {
    const someoneElses: ClosableSession = {
      sessionId: 'cold-session',
      backendId: 'claude',
      title: 'Old run',
      treeRoot: OTHER_WS
    }
    const { verb, closed } = harness(
      [session('me', 'claude'), session('other', 'claude')],
      {},
      [],
      {
        sidebar: sidebar([
          [WS, [row('other-session', { running: true })]],
          [OTHER_WS, [row('cold-session', { title: 'Old run', cwd: OTHER_WS })]]
        ])
      },
      [someoneElses]
    )
    for (const ref of ['other', 'other title', '']) {
      const reply = await verb(['close', ref], from('me'))
      expect(reply.exit).not.toBe(0)
    }
    expect((await verb(['close', 'other title'], from('me'))).text).toContain('is open')
    expect(closed).toEqual([])
    expect((await verb(['close', 'Old run'], from('me'))).exit).toBe(0)
    expect(closed).toEqual(['cold-session'])
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

describe('the butler’s view of sessions: every workspace', () => {
  const CODEX_KEY = `codex:local:${CODEX_THREAD}`
  const live = [
    session('butler', 'claude', { cwd: '/conductors/global' }),
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
    scopes: { butler: 'global' },
    sidebar: rows,
    turns
  }

  it('the butler lists every workspace’s sessions, open and closed, with backend, host, state, last active, id and a workspace column, a remote one under its machine', async () => {
    const { verb } = harness(live, {}, [], conducting)
    const reply = await verb(['list'], from('butler'))
    expect(reply.exit).toBe(0)
    const lines = reply.text.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines.slice(0, 2)).toEqual([
      `fix-login · Claude · local · working · last active just now · id: fix-id · workspace: ${WS}`,
      `docs-links · Codex · local · closed · last active 2 h ago · id: ${CODEX_THREAD} · workspace: ${WS}`
    ])
    expect(lines[3]).toBe(
      'api-fix · Claude · box · closed · last active just now · id: api-id · workspace: box:/srv/api'
    )
    expect(await verb(['list', '--workspace', WS], from('butler'))).toMatchObject({
      exit: EXIT_USAGE
    })
  })

  it('a helper in the butler’s own folder is listed under that folder, not under its path on disk', async () => {
    const helper = row('helper-id', {
      title: 'Set up Discord',
      cwd: BUTLER_FOLDER,
      mtime: Date.now() - 2 * 3600_000
    })
    const butlerFolder: WorkspaceRows = {
      workspace: {
        path: BUTLER_FOLDER,
        missing: false,
        isGit: false,
        hasHistory: false,
        butler: true
      },
      rows: [helper]
    }
    const withHelper = [...rows, butlerFolder]
    const { verb } = harness(live, {}, [], { ...conducting, sidebar: withHelper })
    expect((await verb(['list'], from('butler'))).text).toContain(
      "Set up Discord · Claude · local · closed · last active 2 h ago · id: helper-id · workspace: the butler's own folder"
    )
  })

  it('the butler sees an open session that shows the owner a question as asking, not as working or done', async () => {
    const { verb } = harness(live, {}, [], { ...conducting, asking: ['fix'] })
    expect((await verb(['list'], from('butler'))).text.split('\n')[0]).toBe(
      `fix-login · Claude · local · asking the owner a question · last active just now · id: fix-id · workspace: ${WS}`
    )
  })

  it('a session that is not a conductor sees every session its workspace shows in the sidebar: the open ones, then the asleep and closed ones with last active and id, each with who started it', async () => {
    const { verb, startedSessions } = harness(live, {}, [], {
      ...conducting,
      sidebar: sidebar([
        [
          WS,
          [
            ...rows[0].rows,
            row('nap-id', { title: 'nap', running: true }),
            row('grand-id', { title: 'grandkid', mtime: Date.now() - 3 * 86_400_000 })
          ]
        ]
      ])
    })
    startedSessions.started('docs-tab', 'fix-id')
    startedSessions.bound('docs-tab', CODEX_KEY)
    startedSessions.started('grand-tab', CODEX_KEY)
    startedSessions.bound('grand-tab', 'grand-id')
    expect((await verb(['list'], from('fix'))).text.split('\n')).toEqual([
      'fix-login (you) · Claude · working',
      `docs-links · Codex · local · closed · last active 2 h ago · id: ${CODEX_THREAD} · started by: you`,
      'nap · Claude · local · idle · last active just now · id: nap-id',
      'grandkid · Claude · local · closed · last active 3 days ago · id: grand-id · started by: docs-links'
    ])
  })

  it('session read prints what the owner, a peer and the session said in the last N turns, found by name or id', async () => {
    const { verb } = harness(live, {}, [], conducting)
    expect((await verb(['read', 'fix-login'], from('butler'))).text).toBe(
      'owner: fix the login\npeer: also the tests\nassistant: Looking.\n\nFixed both.'
    )
    expect((await verb(['read', 'fix-id', '--last', '2'], from('butler'))).text).toBe(
      'owner: first\nassistant: one\n\nowner: fix the login\npeer: also the tests\nassistant: Looking.\n\nFixed both.'
    )
    expect((await verb(['read', CODEX_THREAD], from('butler'))).text).toBe(
      'owner: check docs\nassistant: DONE'
    )
  })

  it('the butler finds an open Claude session by the name it was started under: the list shows the name, read takes it, and answer’s reply calls it by that name, not its title', async () => {
    const { verb } = harness(live, { 'fix-id': 'helper-1a2b3c' }, [], conducting)
    expect((await verb(['list'], from('butler'))).text.split('\n')[0]).toContain(
      'fix-login · Claude · local · working · last active just now · id: fix-id · name: helper-1a2b3c'
    )
    expect((await verb(['read', 'helper-1a2b3c'], from('butler'))).text).toBe(
      'owner: fix the login\npeer: also the tests\nassistant: Looking.\n\nFixed both.'
    )
    expect((await verb(['answer', 'helper-1a2b3c', '2'], from('butler'))).text).toBe(
      'Answered helper-1a2b3c.'
    )
  })

  it('read refuses a bad --last, an unknown session and a session still starting', async () => {
    const { verb, reads } = harness(live, {}, [], conducting)
    for (const args of [
      ['read'],
      ['read', 'fix-id', '--last', '0'],
      ['read', 'fix-id', '--last', '21'],
      ['read', 'fix-id', '--last', '2', 'more'],
      ['read', '--last', '2']
    ])
      expect(await verb(args, from('butler'))).toMatchObject({ exit: EXIT_USAGE })
    for (const ref of ['nobody', 'starting-tab'])
      expect((await verb(['read', ref], from('butler'))).text).toContain('there is no session')
    expect(reads).toEqual([])
  })
})

describe('the butler, and any session, acting on sessions: send, resume, stop, close and new', () => {
  const CODEX_KEY = `codex:local:${CODEX_THREAD}`
  const live = [
    session('butler', 'claude', {
      sessionId: 'cond-id',
      title: 'Alfred',
      cwd: '/conductors/global'
    }),
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
    key: 'butler',
    name: 'Alfred',
    backend: 'claude',
    remote: false,
    tabId: 'butler',
    butler: true,
    open: async () => 'reopened-tab',
    ...over
  })
  const conducting = (over: Partial<Conducting> = {}): Conducting => ({
    scopes: { butler: 'global' },
    sidebar: rows,
    conductors: { 'cond-id': conductorTarget({}) },
    ...over
  })

  it('send reaches a local Claude session through its message socket with the butler’s own permission mode, and a Codex one through its queue with a conductor message id', async () => {
    const { verb, lines, queued } = harness(live, {}, [], conducting({ bypass: ['butler'] }))
    expect((await verb(['send', 'fix-login', 'also', 'the tests'], from('butler'))).exit).toBe(0)
    expect((await verb(['send', CODEX_THREAD, 'check docs'], from('butler'))).exit).toBe(0)
    expect(lines).toEqual([
      {
        tabId: 'fix',
        line: crossSessionLine('bypass', ownerSays('also the tests'), 'koloft-session-1')
      }
    ])
    expect(queued).toEqual([
      { tabId: 'cx', text: ownerSays('check docs'), clientId: 'koloft-conductor-1' }
    ])
  })

  it('a helper in the butler’s own folder passes the owner’s word on the way the butler does, to any workspace session, a Claude one too; what it says to the butler or to another helper stays its own', async () => {
    const helper = session('helper', 'claude', {
      sessionId: 'helper-id',
      title: 'Sort out to-dos',
      cwd: BUTLER_FOLDER
    })
    const other = session('other', 'codex', {
      sessionId: 'other-id',
      title: 'Look into logs',
      cwd: BUTLER_FOLDER
    })
    const h = harness(
      [...live, helper, other],
      {},
      [],
      conducting({
        sidebar: [
          ...rows,
          {
            workspace: { path: BUTLER_FOLDER, missing: false, isGit: false, hasHistory: true },
            rows: [
              row('other-id', {
                title: 'Look into logs',
                cwd: BUTLER_FOLDER,
                backendId: 'codex',
                running: true
              })
            ]
          }
        ]
      })
    )
    h.startedSessions.started('helper', 'cond-id')
    expect((await h.verb(['send', 'fix-login', 'merge it'], from('helper'))).exit).toBe(0)
    expect((await h.verb(['send', 'cond-id', 'Done: 3 merged.'], from('helper'))).exit).toBe(0)
    expect((await h.verb(['send', 'other-id', 'what did you find?'], from('helper'))).exit).toBe(0)
    expect(h.queued.map((q) => q.text)).toEqual([sessionSays(helper, 'what did you find?')])
    expect(h.lines).toEqual([
      {
        tabId: 'fix',
        line: crossSessionLine('prompting', ownerSays('merge it'), 'koloft-session-1')
      },
      {
        tabId: 'butler',
        line: crossSessionLine(
          'prompting',
          sessionSays(helper, 'Done: 3 merged.'),
          'koloft-session-2'
        )
      }
    ])
  })

  it('send to a session showing the owner a question still delivers, and its answer says the message waits until the question is answered and how to see it, so Assist never reports it as working', async () => {
    const { verb, lines, queued } = harness(live, {}, [], conducting({ asking: ['fix', 'cx'] }))
    for (const [ref, name] of [
      ['fix-login', 'fix-login'],
      [CODEX_THREAD, 'docs-links']
    ]) {
      const reply = await verb(['send', ref, 'go on'], from('butler'))
      expect(reply.exit).toBe(0)
      expect(reply.text).toBe(
        `Sent to ${name}. But ${name} is asking the owner a question, so it reads your message only once that is answered. See the question with koloft session screen ${name} and pass it on to the owner.`
      )
    }
    expect(lines).toHaveLength(1)
    expect(queued).toHaveLength(1)
    expect((await verb(['send', 'api-fix', 'hi'], from('butler'))).text).toBe('Typed into api-fix.')
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
    expect(await busy.verb(['send', 'api-fix', 'hi'], from('butler'))).toMatchObject({
      exit: 0,
      text: 'Will deliver when api-fix is ready.'
    })
    expect(busy.pressed).toEqual([])
    await vi.waitFor(() => expect(turnEnds).toHaveLength(1))
    turnEnds[0](true)
    await vi.waitFor(() =>
      expect(busy.pressed).toEqual([{ tabId: 'api', keys: [ownerSays('hi'), '\r'] }])
    )
    await busy.verb(['send', 'api-fix', 'again'], from('butler'))
    await vi.waitFor(() => expect(turnEnds).toHaveLength(2))
    turnEnds[1](false)
    await vi.waitFor(() =>
      expect(busy.undelivered).toEqual([
        { callerTab: 'butler', name: 'api-fix', why: expect.stringContaining('stayed busy') }
      ])
    )
    expect(busy.pressed).toHaveLength(1)
    expect(busy.lines).toEqual([])

    const idle = harness(live, {}, [], conducting())
    expect((await idle.verb(['send', 'api-fix', 'hi'], from('butler'))).text).toBe(
      'Typed into api-fix.'
    )
  })

  it('send to a closed session answers at once, resumes it and sends once it is ready; one that never gets ready is reported to the conductor', async () => {
    const ready = harness(live, {}, [], conducting())
    expect((await ready.verb(['send', 'old-work', 'go'], from('butler'))).text).toBe(
      'Will deliver when old-work is ready.'
    )
    expect(ready.resumed).toEqual(['old-id'])
    await vi.waitFor(() =>
      expect(ready.lines).toEqual([
        {
          tabId: 'old-id-tab',
          line: crossSessionLine('prompting', ownerSays('go'), 'koloft-session-1')
        }
      ])
    )
    const slow = harness(live, {}, [], conducting({ ready: () => false }))
    expect((await slow.verb(['send', 'old-work', 'go'], from('butler'))).exit).toBe(0)
    await vi.waitFor(() =>
      expect(slow.undelivered).toEqual([
        { callerTab: 'butler', name: 'old-work', why: expect.stringContaining('not get ready') }
      ])
    )
    expect(slow.lines).toEqual([])
  })

  it('answer hands the reply to the dialog the session shows and touches it; a closed session, the caller itself and a session with no dialog are refused, and an open session Koloft cannot answer is refused with how to see its screen and press its keys', async () => {
    const h = harness(
      live,
      {},
      [],
      conducting({
        answer: (tab) => (tab === 'cx' ? 'Koloft sees no question.' : undefined)
      })
    )
    expect((await h.verb(['answer', 'fix-login', '2'], from('butler'))).text).toBe(
      'Answered fix-login.'
    )
    expect((await h.verb(['answer', CODEX_THREAD, 'yes'], from('butler'))).text).toBe(
      `koloft session answer: docs-links: Koloft sees no question. To answer it anyway, see what it shows with koloft session screen ${CODEX_THREAD}, then press the keys with koloft session keys ${CODEX_THREAD} <keys>.`
    )
    expect((await h.verb(['answer', 'old-work', 'yes'], from('butler'))).text).toContain(
      'it is not open'
    )
    expect((await h.verb(['answer', 'cond-id', '1'], from('butler'))).text).toContain(THAT_IS_YOU)
    expect((await h.verb(['answer', 'fix-login', '1'], from('fix'))).exit).not.toBe(0)
    expect(await h.verb(['answer', 'fix-login'], from('butler'))).toMatchObject({
      exit: EXIT_USAGE
    })
    expect(h.answers).toEqual([
      { tabId: 'fix', reply: '2' },
      { tabId: 'cx', reply: 'yes' }
    ])
  })

  it('command hands one slash command to Koloft for any session, in any workspace, or for the caller itself with "me"', async () => {
    const h = harness(live, {}, [], conducting())
    expect(
      (await h.verb(['command', 'fix-login', '/compact', 'keep', 'the', 'plan'], from('butler')))
        .text
    ).toBe('Typing /compact keep the plan into fix-login.')
    expect((await h.verb(['command', 'me', '/clear'], from('butler'))).exit).toBe(0)
    expect((await h.verb(['command', 'Alfred', '/context'], from('butler'))).exit).toBe(0)
    expect((await h.verb(['command', 'site-build', '/clear'], from('fix'))).exit).toBe(0)
    expect((await h.verb(['command', 'me', '/compact'], from('fix'))).exit).toBe(0)
    expect(h.commands).toEqual([
      { callerTab: 'butler', key: 'fix-id', text: '/compact keep the plan' },
      { callerTab: 'butler', key: 'butler', text: '/clear' },
      { callerTab: 'butler', key: 'butler', text: '/context' },
      { callerTab: 'fix', key: 'site-id', text: '/clear' },
      { callerTab: 'fix', key: 'fix-id', text: '/compact' }
    ])
  })

  it('what a command printed is handed back to the session that ran it as a message from Koloft, for a Claude and a Codex caller', async () => {
    const h = harness(live, {}, [], conducting())
    await h.verb(['command', 'site-build', '/context'], from('fix'))
    await h.verb(['command', 'fix-login', '/compact'], from('cx'))
    h.tells[0]('Context: 12% used')
    h.tells[1]('Compacted.')
    await vi.waitFor(() => {
      expect(h.lines.find((l) => l.tabId === 'fix')?.line).toContain(
        '(From Koloft:) Context: 12% used'
      )
      expect(h.queued).toContainEqual(
        expect.objectContaining({ tabId: 'cx', text: '(From Koloft:) Compacted.' })
      )
    })
    expect(h.undelivered).toEqual([])
  })

  it('command refuses text that is not a slash command', async () => {
    const h = harness(live, {}, [], conducting())
    expect(await h.verb(['command', 'fix-login', 'compact'], from('butler'))).toMatchObject({
      exit: EXIT_USAGE
    })
    expect(await h.verb(['command', 'fix-login', 'compact'], from('cx'))).toMatchObject({
      exit: EXIT_USAGE
    })
    expect(h.commands).toEqual([])
  })

  it('screen prints an open session’s terminal without its blank edges, and says why it cannot when it cannot', async () => {
    const h = harness(live, {}, [], conducting())
    expect((await h.verb(['screen', 'fix-login'], from('butler'))).text).toBe(
      'The screen of fix-login right now:\n```\n$ ls\na.txt\n```'
    )
    expect((await h.verb(['screen', 'old-work'], from('butler'))).text).toContain('is not open')
    expect((await h.verb(['screen', 'me'], from('butler'))).text).toBe('you: no window')
  })

  it('keys presses named keys, in any case, and types every other word as it is, in order, into an open session, and touches it; a closed session, the caller itself and no keys are refused', async () => {
    const h = harness(live, {}, [], conducting())
    const reply = await h.verb(
      ['keys', 'fix-login', '2', 'Down', 'SPACE', 'shift-tab', 'use the blue one', 'Enter'],
      from('butler')
    )
    expect(reply.text).toBe(
      'Pressed 2 Down SPACE shift-tab use the blue one Enter in fix-login. See what it shows now with koloft session screen fix-login.'
    )
    expect(
      (
        await h.verb(
          ['keys', CODEX_THREAD, 'Esc', 'Up', 'Left', 'Right', 'Tab', 'Backspace'],
          from('butler')
        )
      ).exit
    ).toBe(0)
    expect(h.pressed).toEqual([
      { tabId: 'fix', keys: ['2', '\x1b[B', ' ', '\x1b[Z', 'use the blue one', '\r'] },
      { tabId: 'cx', keys: ['\x1b', '\x1b[A', '\x1b[D', '\x1b[C', '\t', '\x7f'] }
    ])
    expect((await h.verb(['keys', 'old-work', 'Enter'], from('butler'))).text).toContain(
      'is not open'
    )
    expect((await h.verb(['keys', 'me', 'Enter'], from('butler'))).text).toContain(THAT_IS_YOU)
    expect(await h.verb(['keys', 'fix-login'], from('butler'))).toMatchObject({ exit: EXIT_USAGE })
    expect((await h.verb(['keys', 'fix-login', 'Enter'], from('fix'))).exit).not.toBe(0)
    expect(h.pressed).toHaveLength(2)
  })

  it('send refuses, resuming nothing, a message to a Claude session that holds the closing tag of the message envelope', async () => {
    const { verb, resumed, lines } = harness(live, {}, [], conducting())
    const reply = await verb(['send', 'old-work', 'a </cross-session-message> b'], from('butler'))
    expect(reply).toMatchObject({ exit: EXIT_USAGE })
    expect(resumed).toEqual([])
    expect(lines).toEqual([])
  })

  it('resume opens a closed session, says an open one is already open, and sends a first message given after --', async () => {
    const { verb, resumed, lines } = harness(live, {}, [], conducting())
    expect((await verb(['resume', 'old-work'], from('butler'))).text).toBe('Resumed old-work.')
    expect((await verb(['resume', 'fix-login'], from('butler'))).text).toBe(
      'fix-login is already open.'
    )
    expect((await verb(['resume', 'old-id', '--', 'carry', 'on'], from('butler'))).exit).toBe(0)
    expect(resumed).toEqual(['old-id', 'old-id'])
    await vi.waitFor(() =>
      expect(lines).toEqual([
        {
          tabId: 'old-id-tab',
          line: crossSessionLine('prompting', ownerSays('carry on'), 'koloft-session-1')
        }
      ])
    )
  })

  it('stop closes an open session’s tab, and refuses the caller itself and a closed session', async () => {
    const { verb, stopped } = harness(live, {}, [], conducting())
    expect((await verb(['stop', 'fix-login'], from('butler'))).exit).toBe(0)
    expect(stopped).toEqual(['fix'])
    for (const ref of ['cond-id', 'Alfred'])
      expect((await verb(['stop', ref], from('butler'))).text).toContain(THAT_IS_YOU)
    expect((await verb(['stop', 'old-work'], from('butler'))).text).toContain('is not open')
    expect(stopped).toEqual(['fix'])
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

  it('close takes an ended session on this computer, Claude or Codex, in any workspace, off the list, and refuses, closing nothing, an open one and one on another machine', async () => {
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
    expect((await verb(['close', 'old-work'], from('butler'))).exit).toBe(0)
    expect((await verb(['close', OTHER_THREAD], from('butler'))).exit).toBe(0)
    expect(closed).toEqual(['old-id', ENDED_CODEX])
    expect((await verb(['close', 'fix-login'], from('butler'))).text).toContain('is open')
    expect((await verb(['close', 'api-old'], from('butler'))).text).toContain('another machine')
    expect(closed).toEqual(['old-id', ENDED_CODEX])
    expect((await verb(['close', 'site-build'], from('butler'))).exit).toBe(0)
    expect((await verb(['close'], from('butler'))).exit).toBe(0)
    expect(closed).toEqual(['old-id', ENDED_CODEX, 'site-id', 'cond-id'])
  })

  it('close from the butler closes nothing and lists what is left when an ended session’s worktree holds work', async () => {
    const left = ['Changes not committed:\n?? notes.md']
    const { verb, closed } = harness(live, {}, left, conducting(), ENDED)
    const reply = await verb(['close', 'old-work'], from('butler'))
    expect(reply.exit).not.toBe(0)
    expect(reply.text).toContain(left[0])
    expect(closed).toEqual([])
  })

  it('a session that is not the butler sees, stops, resumes, picks --backend and messages a closed session in another workspace, its message marked as from that session, never as the owner’s', async () => {
    const { verb, stopped, resumed, launched, lines } = harness(live, {}, [], conducting())
    expect((await verb(['screen', 'fix-login'], from('cx'))).text).toBe(
      'The screen of fix-login right now:\n```\n$ ls\na.txt\n```'
    )
    expect((await verb(['stop', 'api-fix'], from('fix'))).exit).toBe(0)
    expect((await verb(['resume', 'old-work'], from('fix'))).text).toBe('Resumed old-work.')
    expect((await verb(['send', 'site-build', 'hi'], from('fix'))).text).toBe(
      'Will deliver when site-build is ready.'
    )
    expect((await verb(['new', '--backend', 'codex', '--', 'go'], from('fix'))).exit).toBe(0)
    expect(stopped).toEqual(['api'])
    expect(launched.map((l) => [l.kind, l.cwd])).toEqual([['codex', WS]])
    await vi.waitFor(() =>
      expect(lines).toEqual([
        {
          tabId: 'site-id-tab',
          line: crossSessionLine(
            'prompting',
            '(From the session "fix-login", id fix-id:) hi',
            'koloft-session-1'
          )
        }
      ])
    )
    expect(resumed).toEqual(['old-id', 'site-id'])
  })

  it('new from the butler without --workspace starts a helper in its own folder, told the butler’s goals before the handover, and takes no worktree there', async () => {
    const { verb, launched } = harness(live, { 'cond-id': 'Alfred' }, [], conducting())
    const refused = await verb(['new', '-w', 'x', '--', 'go'], from('butler'))
    expect(refused.exit).not.toBe(0)
    expect(refused.text).toContain('--workspace')
    expect(launched).toEqual([])

    expect((await verb(['new', '--', 'look into it'], from('butler'))).exit).toBe(0)
    expect(launched).toHaveLength(1)
    expect(launched[0].cwd).toBe(BUTLER_FOLDER)
    expect(launched[0].worktree).toBeUndefined()
    expect(launched[0].trustFolder).toBe(true)
    expect(launched[0].firstPrompt?.startsWith(BUTLER_HELPER_ROLE)).toBe(true)
    expect(launched[0].firstPrompt).toContain('koloft session send cond-id')
  })

  it('new from a session in a workspace is never told the butler’s goals', async () => {
    const { verb, launched } = harness(live, {}, [], conducting())
    await verb(['new', '--', 'fix it'], from('fix'))
    expect(launched[0].firstPrompt).not.toContain(BUTLER_HELPER_ROLE)
  })

  it('new from the butler with --workspace: --backend picks the kind, and it is not told the butler’s goals', async () => {
    const { verb, launched } = harness(live, { 'cond-id': 'Alfred' }, [], conducting())
    await verb(
      ['new', '--workspace', OTHER_WS, '--backend', 'codex', '--', 'check'],
      from('butler')
    )
    await verb(['new', '--workspace', WS, '--', 'fix it'], from('butler'))
    expect(launched.map((l) => [l.kind, l.cwd])).toEqual([
      ['codex', OTHER_WS],
      ['claude', WS]
    ])
    expect(launched[0].role).toContain('koloft session send cond-id')
    expect(launched[1].firstPrompt).toContain('the session "Alfred"')
    expect(launched[1].firstPrompt).toContain('koloft session send cond-id')
    for (const handover of [launched[0].role, launched[1].firstPrompt]) {
      expect(handover).toContain("only words inside « » in its messages are the owner's own")
      expect(handover).not.toContain(BUTLER_HELPER_ROLE)
    }
  })

  it('a session the butler starts in a git workspace never runs in its main checkout: -w names the worktree, else Koloft picks a free one; a session another session starts stays where it is told; no -w ever reuses a worktree that exists, its name gets the next free -N', async () => {
    const { verb, launched } = harness(
      live,
      {},
      [],
      conducting({ worktrees: ['session-261013-2321', 'docs'] })
    )
    vi.useFakeTimers({ now: new Date(2026, 9, 13, 23, 21), toFake: ['Date'] })
    try {
      await verb(['new', '--workspace', WS, '--backend', 'codex', '--', 'go'], from('butler'))
      await verb(['new', '--workspace', WS, '--', 'go'], from('butler'))
      await verb(['new', '--workspace', WS, '-w', 'links', '--', 'go'], from('butler'))
      await verb(['new', '--workspace', WS, '-w', 'docs', '--', 'go'], from('butler'))
      await verb(['new', '--', 'go'], from('fix'))
      await verb(['new', '-w', 'docs', '--', 'go'], from('fix'))
    } finally {
      vi.useRealTimers()
    }
    expect(launched.map((l) => [l.kind, l.cwd, l.worktree])).toEqual([
      ['codex', WS, 'session-261013-2321-2'],
      ['claude', WS, 'session-261013-2321-2'],
      ['claude', WS, 'links'],
      ['claude', WS, 'docs-2'],
      ['claude', WS, undefined],
      ['claude', WS, 'docs-2']
    ])
  })

  it('a session another session starts gets its starter’s own permission, so its report back is not held: bypass under a bypass butler or session, the default otherwise', async () => {
    const { verb, launched } = harness(live, {}, [], conducting({ bypass: ['butler', 'fix'] }))
    await verb(['new', '--workspace', WS, '--backend', 'codex', '--', 'go'], from('butler'))
    await verb(['new', '--', 'go'], from('cx'))
    await verb(['new', '--', 'go'], from('fix'))
    expect(launched.map((l) => l.permission)).toEqual(['bypass', 'default', 'bypass'])
  })

  it('any session reports back to the butler that started it by the butler’s id, which is hidden from every list, with its own mode, no owner label, and the name and id of the session it is from; a butler showing a question gets the report without the child being told to look at its screen', async () => {
    const opened: string[] = []
    const { verb, lines, queued } = harness(
      live,
      {},
      [],
      conducting({
        asking: ['butler'],
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
    expect(await verb(['send', 'cond-id', 'done'], from('fix'))).toMatchObject({
      exit: 0,
      text: 'Sent to Alfred.'
    })
    expect((await verb(['send', 'codex-cond', 'done'], from('cx'))).exit).toBe(0)
    expect((await verb(['send', 'closed-cond', 'done'], from('fix'))).exit).toBe(0)
    const fromFix = '(From the session "fix-login", id fix-id:) done'
    await vi.waitFor(() =>
      expect(lines).toEqual([
        { tabId: 'butler', line: crossSessionLine('prompting', fromFix, 'koloft-session-1') },
        { tabId: 'b3-tab', line: crossSessionLine('prompting', fromFix, 'koloft-session-2') }
      ])
    )
    expect(queued).toEqual([
      {
        tabId: 'cc',
        text: `(From the session "docs-links", id ${CODEX_THREAD}:) done`,
        clientId: 'koloft-conductor-1'
      }
    ])
    expect(opened).toEqual(['b3'])
  })

  it('a session the butler messaged, started or answered the question of (with answer, or keys pressed while it asks) hands the butler its reply when that turn ends, once, so the owner hears the result without asking; a session the butler only read or moved through a menu of, a turn with no reply and a child that already reported this turn are not passed on, and a reply that cannot be carried is reported as not delivered', async () => {
    const asking: string[] = []
    const h = harness(
      [...live, session('new-tab', 'claude', { sessionId: 'new-id', title: 'new-work' })],
      {},
      [],
      conducting({ asking, answer: (_tab, reply) => (reply === 'bad' ? 'no dialog' : undefined) })
    )
    const toAssist = (): { tabId: string; said: string }[] =>
      h.lines
        .filter((l) => l.tabId === 'butler')
        .map((l) => ({
          tabId: l.tabId,
          said: (JSON.parse(l.line) as { message: { content: string } }).message.content
        }))
    const handed = (tabId: string, text: string): { tabId: string; said: string } => ({
      tabId,
      said: expect.stringContaining(text) as string
    })

    await h.verb(['send', 'fix-login', 'run the tests'], from('butler'))
    h.turnEnded('fix', 'All tests pass.')
    h.turnEnded('fix', 'Something later the owner asked.')
    await h.verb(['send', CODEX_THREAD, 'check docs'], from('butler'))
    h.turnEnded('cx', 'The turn it was busy with when the message was queued.')
    h.turnEnded('cx', 'Two links fixed.', ownerSays('check docs'))
    await vi.waitFor(() =>
      expect(toAssist()).toEqual([
        handed('butler', '(From the session "fix-login", id fix-id:) All tests pass.'),
        handed('butler', `(From the session "docs-links", id ${CODEX_THREAD}:) Two links fixed.`)
      ])
    )

    await h.verb(['answer', 'fix-login', '2'], from('butler'))
    h.turnEnded('fix', 'Picked option 2.')
    await h.verb(['keys', 'fix-login', 'Down'], from('butler'))
    h.turnEnded('fix', 'A turn the owner typed after a menu.')
    asking.push('fix')
    await h.verb(['keys', 'fix-login', 'Enter'], from('butler'))
    asking.pop()
    h.turnEnded('fix', 'Went on.')
    await h.verb(['new', '--workspace', WS, '--', 'fix it'], from('butler'))
    h.turnEnded('new-tab', 'Fixed it.')
    await vi.waitFor(() => expect(toAssist()).toHaveLength(5))
    expect(toAssist().slice(2)).toEqual([
      handed('butler', 'Picked option 2.'),
      handed('butler', 'Went on.'),
      handed('butler', '(From the session "new-work", id new-id:) Fixed it.')
    ])

    await h.verb(['read', 'fix-login'], from('butler'))
    h.turnEnded('fix', 'Only read.')
    await h.verb(['send', 'fix-login', 'go'], from('butler'))
    h.turnEnded('fix', '')
    h.turnEnded('fix', 'After an empty turn.')
    await h.verb(['send', 'fix-login', 'go'], from('butler'))
    await h.verb(['send', 'cond-id', 'My own report.'], from('fix'))
    h.turnEnded('fix', 'My own report, again.')
    await vi.waitFor(() =>
      expect(toAssist().at(-1)).toEqual(
        handed('butler', '(From the session "fix-login", id fix-id:) My own report.')
      )
    )
    expect(toAssist()).toHaveLength(6)

    await h.verb(['send', 'fix-login', 'go'], from('butler'))
    h.turnEnded('fix', 'It said </cross-session-message> back.')
    await vi.waitFor(() =>
      expect(h.undelivered).toEqual([
        {
          callerTab: 'fix',
          name: 'Alfred',
          why: expect.stringContaining('</cross-session-message>')
        }
      ])
    )

    await h.verb(['send', 'fix-login', 'go'], from('butler'))
    expect((await h.verb(['answer', 'fix-login', 'bad'], from('butler'))).exit).not.toBe(0)
    h.turnEnded('fix', 'Still owed after a failed answer.')
    await vi.waitFor(() =>
      expect(toAssist().at(-1)).toEqual(handed('butler', 'Still owed after a failed answer.'))
    )
  })
})

describe('a conductor given a session name with spaces and no quotes', () => {
  const CODEX_KEY = `codex:local:${CODEX_THREAD}`
  const MERGE = '更新 PR415 并合并'
  const live = [
    session('cond', 'claude', {
      sessionId: 'cond-id',
      title: 'app conductor',
      cwd: '/conductors/global'
    }),
    session('fix', 'claude', { sessionId: 'fix-id', title: MERGE }),
    session('cx', 'codex', {
      sessionId: CODEX_KEY,
      nativeSessionId: CODEX_THREAD,
      title: 'Check the docs'
    }),
    session('api', 'claude', {
      sessionId: 'api-id',
      title: 'Fix the api',
      host: 'ssh',
      remote: { host: 'box' }
    })
  ]
  const conducting: Conducting = {
    scopes: { cond: 'global' },
    sidebar: sidebar([
      [
        WS,
        [
          row('fix-id', { running: true }),
          row(CODEX_KEY, { backendId: 'codex', nativeSessionId: CODEX_THREAD, running: true }),
          row('docs-id', { title: 'Fix docs' }),
          row('links-id', { title: 'Fix docs links' })
        ]
      ],
      ['ssh://box/srv/api', [row('api-id', { title: 'Fix the api', host: 'ssh', running: true })]]
    ]),
    conductors: {
      'cond-id': {
        key: 'conductor:b1',
        name: 'the conductor',
        backend: 'claude',
        remote: false,
        tabId: 'cond',
        open: async () => 'cond'
      }
    }
  }
  const words = (text: string): string[] => text.split(' ')

  it('send, answer, command and keys take the first words that make up a session’s name as the name and the rest as the text, for a local and a remote Claude session and a Codex one', async () => {
    const h = harness(live, {}, [], conducting)
    for (const line of [
      `send ${MERGE} fix the tests`,
      'send Check the docs check the links',
      'send Fix the api go on',
      `answer ${MERGE} 2`,
      `command ${MERGE} /compact keep it`
    ])
      expect((await h.verb(words(line), from('cond'))).exit).toBe(0)
    expect(h.lines).toEqual([
      {
        tabId: 'fix',
        line: crossSessionLine('prompting', ownerSays('fix the tests'), 'koloft-session-1')
      }
    ])
    expect(h.queued).toEqual([
      { tabId: 'cx', text: ownerSays('check the links'), clientId: 'koloft-conductor-1' }
    ])
    expect(h.answers).toEqual([{ tabId: 'fix', reply: '2' }])
    expect(h.commands).toEqual([{ callerTab: 'cond', key: 'fix-id', text: '/compact keep it' }])
    const keys = await h.verb(words('keys Check the docs Down Enter'), from('cond'))
    expect(keys.text).toBe(
      'Pressed Down Enter in Check the docs. See what it shows now with koloft session screen "Check the docs".'
    )
    expect(h.pressed).toEqual([
      { tabId: 'api', keys: [ownerSays('go on'), '\r'] },
      { tabId: 'cx', keys: ['\x1b[B', '\r'] }
    ])
  })

  it('stop, screen, resume, read and close take every word before -- or --last as the name', async () => {
    const cold: ClosableSession[] = [
      { sessionId: 'links-id', backendId: 'claude', title: 'Fix docs links', treeRoot: WS }
    ]
    const h = harness(live, {}, [], conducting, cold)
    expect((await h.verb(words(`screen ${MERGE}`), from('cond'))).text).toBe(
      `The screen of ${MERGE} right now:\n\`\`\`\n$ ls\na.txt\n\`\`\``
    )
    expect((await h.verb(words('read Fix docs links --last 2'), from('cond'))).exit).toBe(0)
    expect(h.reads).toEqual([{ key: 'links-id', n: 2 }])
    expect((await h.verb(words('resume Fix docs -- carry on'), from('cond'))).exit).toBe(0)
    expect(h.resumed).toEqual(['docs-id'])
    expect((await h.verb(words('close Fix docs links'), from('cond'))).exit).toBe(0)
    expect(h.closed).toEqual(['links-id'])
    expect((await h.verb(words(`stop ${MERGE}`), from('cond'))).exit).toBe(0)
    expect((await h.verb(words('stop app conductor'), from('cond'))).text).toContain(THAT_IS_YOU)
    expect((await h.verb(words('stop No such one'), from('cond'))).text).toContain(
      'there is no session "No such one"'
    )
    expect(h.stopped).toEqual(['fix'])
  })

  it('a message whose first words fit two sessions’ names is sent nowhere and the id is asked for; quoting the name and the message makes it clear', async () => {
    const h = harness(live, {}, [], conducting)
    const reply = await h.verb(words('send Fix docs links please'), from('cond'))
    expect(reply).toMatchObject({ exit: EXIT_USAGE })
    expect(reply.text).toContain('"Fix docs" and "Fix docs links"')
    expect(reply.text).toContain('id')
    expect(h.resumed).toEqual([])
    for (const quoted of [
      ['send', 'Fix docs links', 'please'],
      ['send', 'Fix docs', 'links please']
    ])
      expect((await h.verb(quoted, from('cond'))).exit).toBe(0)
    await vi.waitFor(() => expect(h.resumed).toEqual(['links-id', 'docs-id']))
  })
})

describe('koloft workspace list', () => {
  const rows = sidebar([
    [WS, [row('a', { running: true }), row('b')]],
    ['/work/gone', []],
    ['ssh://box/srv/api', [row('c', { running: true, host: 'ssh' })]]
  ])
  const verb = workspaceVerb({ sidebar: () => rows })
  const caller = (tabId: string) => ({ tabId, cwd: WS, session: session(tabId, 'claude') })

  it('any session, the butler or a plain one, gets every sidebar workspace with its path and how many sessions are open', async () => {
    for (const tabId of ['butler', 'plain'])
      expect((await verb(['list'], caller(tabId))).text.split('\n')).toEqual([
        `app · ${WS} · 1 open`,
        'gone · /work/gone · 0 open · folder missing',
        'api · box:/srv/api · 1 open'
      ])
  })
})

describe('a session started while the machine is busy waits in a queue', () => {
  it('the caller hears it is queued and not to start it again, and the list shows it waiting', async () => {
    const h = harness([session('me', 'claude')], {}, [], { busy: true })
    const reply = await h.verb(['new', '--name', 'tests', '--', 'Run the tests.'], from('me'))
    expect(reply.text).toMatch(/^Queued session "tests" \(new-tab\)/)
    expect(reply.text).toContain('Do not start it again.')
    const list = await h.verb(['list'], from('me'))
    expect(list.text).toMatch(
      /"tests" \(new-tab\): queued, waiting for the machine to have room \(since just now\) — started by: you/
    )
  })

  it('a message to it is kept and, once it has started, sent the way any message to an open session is', async () => {
    const sessions = [session('me', 'codex')]
    const h = harness(sessions, {}, [], { busy: true })
    await h.verb(['new', '--', 'Run the tests.'], from('me'))
    const sent = await h.verb(['send', 'new-tab', 'Also lint.'], from('me'))
    expect(sent.text).toContain('is still queued for the machine; your message is kept')
    expect(h.queued).toEqual([])
    h.waiting.splice(0)
    sessions.push(session('new-tab', 'codex'))
    await h.held[0].send()
    expect(h.queued).toHaveLength(1)
    expect(h.queued[0].tabId).toBe('new-tab')
    expect(h.queued[0].text).toContain('Also lint.')
  })

  it('a message to a queued session whose name has several words is kept for it too', async () => {
    const h = harness([session('me', 'muse')], {}, [], { busy: true })
    await h.verb(['new', '--name', 'fix login', '--', 'Fix the login.'], from('me'))
    const sent = await h.verb(['send', 'fix', 'login', 'Also lint.'], from('me'))
    expect(sent.text).toContain('your message is kept')
    expect(h.held.map((x) => x.tabId)).toEqual(['new-tab'])
  })

  it('a Claude session starting or messaging a queued Claude session is told to use SendMessage once it starts, nothing is kept', async () => {
    const h = harness([session('me', 'claude')], {}, [], { busy: true })
    const reply = await h.verb(['new', '--name', 'tests', '--', 'Run the tests.'], from('me'))
    expect(reply.text).toContain('once it starts, talk to it with SendMessage to "tests"')
    expect(reply.text).not.toContain('koloft session send')
    const sent = await h.verb(['send', 'tests', 'Also lint.'], from('me'))
    expect(sent.text).toContain('once it starts, talk to it with SendMessage to "tests"')
    expect(h.held).toEqual([])
  })

  it('closing a queued session takes it off the queue', async () => {
    const h = harness([session('me', 'claude')], {}, [], { busy: true })
    await h.verb(['new', '--name', 'tests', '--', 'Run the tests.'], from('me'))
    const closed = await h.verb(['close', 'tests'], from('me'))
    expect(closed.text).toBe('Took "tests" off the queue; it will not start.')
    expect(h.waiting).toEqual([])
    expect(h.closed).toEqual([])
  })

  it('a session the butler starts is placed under the butler even when it has to queue', async () => {
    const h = harness([session('butler', 'claude')], {}, [], {
      busy: true,
      scopes: { butler: 'global' }
    })
    const reply = await h.verb(['new', '--name', 'tests', '--', 'Run the tests.'], from('butler'))
    expect(reply.text).toMatch(/^Queued session "tests"/)
    expect(h.startedSessions.startersOf({ sessionId: '', tabId: 'new-tab' })).toEqual([
      'butler-session'
    ])
  })

  it('a queued session another session started is not this caller’s to message or close', async () => {
    const h = harness([session('me', 'claude'), session('other', 'claude')], {}, [], { busy: true })
    await h.verb(['new', '--name', 'tests', '--', 'Run the tests.'], from('other'))
    await h.verb(['send', 'tests', 'hi'], from('me'))
    expect(h.held).toEqual([])
    await h.verb(['close', 'tests'], from('me'))
    expect(h.waiting).toHaveLength(1)
  })
})

import { describe, it, expect } from 'vitest'
import { todoVerb, TODO_ONLY_FOR_THE_BUTLER, type TodoVerbDeps } from '../../src/main/agentTodo'
import type { TodoPull, TodoPulls } from '../../src/main/github'
import type { McpServer } from '../../src/main/mcpServers'
import { formatRemoteKey } from '../../src/shared/remoteKey'
import type { BackendId, SessionInfo, SessionRow, WorkspaceRows } from '../../src/shared/types'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const DAY = 86_400_000
const SHOP = '/work/shop'
const SHOP_COPY = '/work/shop-2'
const NOTES_WS = '/work/notes'
const REMOTE = formatRemoteKey('box', '/srv/app')
const BUTLER_FOLDER = '/data/conductors/global'
const BUTLER_TAB = 'tab-butler'

function row(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    title: `${id} title`,
    cwd: SHOP,
    worktree: 'main',
    running: false,
    invalidCwd: false,
    mtime: NOW - 2 * DAY,
    backendId: 'claude',
    host: 'local',
    ...over
  }
}

function live(r: SessionRow, status: SessionInfo['status']): SessionInfo {
  return {
    tabId: `tab-${r.id}`,
    backendId: r.backendId,
    host: 'local',
    sessionId: r.id,
    title: r.title,
    cwd: r.cwd,
    treeRoot: r.cwd,
    alive: true,
    updatedAt: 1,
    status
  }
}

function pull(number: number, over: Partial<TodoPull> = {}): TodoPull {
  return {
    number,
    title: `PR ${number}`,
    author: 'alice',
    reviewers: [],
    branch: `branch-${number}`,
    draft: false,
    checks: 'passing',
    files: 1,
    closes: [],
    openedAt: new Date(NOW - 5 * DAY).toISOString(),
    ...over
  }
}

interface World {
  sidebar: WorkspaceRows[]
  sessions: SessionInfo[]
  asking?: string[]
  asleep?: string[]
  left?: Record<string, string[] | null>
  checkFails?: string[]
  worktrees?: Record<string, { dir: string; branch?: string }[]>
  repos?: Record<string, string>
  pulls?: TodoPulls
  files?: Record<string, Record<string, string>>
  servers?: McpServer[]
  notes?: Record<string, string>
}

function harness(world: World) {
  const notes = { ...(world.notes ?? {}) }
  const checked: string[] = []
  const deps: TodoVerbDeps = {
    allowed: (tabId) => tabId === BUTLER_TAB,
    sidebar: () => world.sidebar,
    pinnedWorkspaces: () =>
      world.sidebar
        .filter((w) => !w.workspace.butler)
        .map((w) => ({ path: w.workspace.path, missing: w.workspace.missing })),
    sessions: () => world.sessions,
    asking: (tabId) => world.asking?.includes(tabId) ?? false,
    asleep: (sessionId) => world.asleep?.includes(sessionId) ?? false,
    workLeft: async (r) => {
      checked.push(r.id)
      if (world.checkFails?.includes(r.id)) throw new Error('git timed out')
      return world.left && r.id in world.left ? world.left[r.id] : []
    },
    worktrees: async (ws) => world.worktrees?.[ws] ?? [],
    repoOf: async (ws) => world.repos?.[ws] ?? null,
    pulls: async () => world.pulls ?? null,
    notes: () => ({ ...notes }),
    saveNote: (key, text) => {
      if (text) notes[key] = text
      else delete notes[key]
    },
    projectFiles: async (ws) =>
      Object.keys(world.files?.[ws] ?? {}).map((name) => ({ name, path: `${ws}/${name}` })),
    readText: async (file) => {
      const [ws, name] = [file.slice(0, file.lastIndexOf('/')), file.split('/').at(-1)!]
      return world.files?.[ws]?.[name] ?? ''
    },
    servers: async () => world.servers ?? [],
    butlerFolder: () => BUTLER_FOLDER,
    now: () => NOW
  }
  const verb = todoVerb(deps)
  const run = (args: string[], tabId = BUTLER_TAB, backendId: BackendId = 'codex') =>
    Promise.resolve(
      verb(args, {
        tabId,
        cwd: BUTLER_FOLDER,
        session: { ...live(row('butler'), 'waiting'), tabId, backendId }
      })
    )
  return { run, notes, checked }
}

function sidebarOf(
  entries: [string, SessionRow[]][],
  butlerRows: SessionRow[] = []
): WorkspaceRows[] {
  return [
    ...entries.map(([path, rows]) => ({
      workspace: { path, missing: false, isGit: true, hasHistory: true },
      rows
    })),
    {
      workspace: {
        path: BUTLER_FOLDER,
        missing: false,
        isGit: false,
        hasHistory: true,
        butler: true
      },
      rows: butlerRows
    }
  ]
}

function section(text: string, title: string): string {
  const start = text.indexOf(`\n${title}`)
  const rest = text.slice(start + 1)
  const end = rest.search(/\n\n[A-Z][A-Z -]+[A-Z](\s\(|\n)/)
  return end < 0 ? rest : rest.slice(0, end)
}

describe('koloft todo', () => {
  it('is only for the butler and the helpers in its folder; anyone else is refused', async () => {
    const { run } = harness({ sidebar: sidebarOf([]), sessions: [] })
    expect(await run([], 'tab-project-session')).toEqual({
      text: TODO_ONLY_FOR_THE_BUTLER,
      exit: 1
    })
  })

  it('prints the way to sort out to-dos, then the sessions waiting on the owner by kind, leaving out working ones and the butler’s own folder; a session whose tab is asleep is listed, on this Mac or another machine, while one running with no tab here is left out as working; every idle local open or asleep session is checked for work left, a closed one only in a listed worktree, and an open or asleep one not asking the owner says when nothing is left in its worktree or closing it deletes no worktree', async () => {
    const asking = row('asking', { running: true, mtime: NOW - DAY })
    const done = row('done', { running: true, backendId: 'codex' })
    const clean = row('clean', { running: true, cwd: `${SHOP}/.claude/worktrees/tidy` })
    const rested = row('rested', {
      running: true,
      backendId: 'codex',
      cwd: `${SHOP}/.claude/worktrees/rest`
    })
    const working = row('working', { running: true, cwd: `${SHOP}/.claude/worktrees/busy` })
    const asleep = row('asleep', {
      running: true,
      backendId: 'muse',
      cwd: `${SHOP}/.claude/worktrees/nap`
    })
    const dirty = row('dirty', { cwd: `${SHOP}/.claude/worktrees/fix`, mtime: NOW - 3 * DAY })
    const old = row('old', { mtime: NOW - 40 * DAY })
    const helper = row('helper', { cwd: BUTLER_FOLDER })
    const onBox = row('on-box', { running: true, backendId: 'agy', cwd: '/srv/app' })
    const noTabHere = row('no-tab-here', { running: true, cwd: `${SHOP}/.claude/worktrees/away` })
    const { run, checked } = harness({
      sidebar: sidebarOf(
        [
          [SHOP, [asking, done, clean, working, asleep, rested, noTabHere, dirty, old]],
          [REMOTE, [onBox]]
        ],
        [helper]
      ),
      sessions: [
        live(asking, 'waiting'),
        live(done, 'idle'),
        live(clean, 'idle'),
        live(working, 'working')
      ],
      asking: ['tab-asking'],
      asleep: ['asleep', 'rested', 'on-box'],
      worktrees: {
        [SHOP]: [
          { dir: `${SHOP}/.claude/worktrees/tidy`, branch: 'tidy' },
          { dir: `${SHOP}/.claude/worktrees/rest`, branch: 'rest' },
          { dir: `${SHOP}/.claude/worktrees/busy`, branch: 'busy' },
          { dir: `${SHOP}/.claude/worktrees/nap`, branch: 'nap' },
          { dir: `${SHOP}/.claude/worktrees/away`, branch: 'away' },
          { dir: `${SHOP}/.claude/worktrees/fix`, branch: 'fix' }
        ]
      },
      left: {
        done: null,
        asleep: ['Changes not committed:\n M c.ts'],
        dirty: [
          'Changes not committed:\n M a.ts\n?? b.ts',
          'Commits on no other branch and no remote branch:\nabc1 fix'
        ]
      }
    })
    const { text } = await run([])
    expect(text.startsWith('SORTING OUT THE TO-DOS')).toBe(true)
    const sessions = section(text, 'SESSIONS')
    expect(sessions).toContain('Asking the owner a question:\n- "asking title" · Claude')
    expect(sessions).toMatch(
      /Open, finished its turn:\n- "done title" · Codex .* · id: done · closing it deletes no worktree\n- "clean title" · Claude .* · branch: tidy · nothing left in its worktree\n/
    )
    expect(sessions).toMatch(
      /Closed, with work left in its worktree.*:\n- "dirty title" .* · Changes not committed: 2; Commits on no other branch and no remote branch: 1/
    )
    expect(sessions).toMatch(
      /Closed, nothing left in a worktree .*\n- "old title" .*last active 40 days ago · id: old/
    )
    expect(sessions).toMatch(
      /Open, asleep: .*\n- "asleep title" · Muse .* · branch: nap · Changes not committed: 1\n- "rested title" · Codex .* · branch: rest · nothing left in its worktree\n- "on-box title" · Antigravity · .* · box · /
    )
    expect(sessions).not.toContain('working title')
    expect(sessions).not.toContain('no-tab-here title')
    expect(sessions).not.toContain('helper title')
    expect(sessions.match(/nothing left in its worktree/g)).toHaveLength(2)
    expect([...checked].sort()).toEqual(['asking', 'asleep', 'clean', 'dirty', 'done', 'rested'])
  })

  it('never calls a worktree clean, or a closed session’s worktree empty, when Koloft could not check it', async () => {
    const stuck = row('stuck', { running: true, cwd: `${SHOP}/.claude/worktrees/stuck` })
    const gone = row('gone', { cwd: `${SHOP}/.claude/worktrees/gone` })
    const { run } = harness({
      sidebar: sidebarOf([[SHOP, [stuck, gone]]]),
      sessions: [live(stuck, 'idle')],
      worktrees: {
        [SHOP]: [
          { dir: `${SHOP}/.claude/worktrees/stuck`, branch: 'stuck' },
          { dir: `${SHOP}/.claude/worktrees/gone`, branch: 'gone' }
        ]
      },
      checkFails: ['stuck', 'gone']
    })
    const sessions = section((await run([])).text, 'SESSIONS')
    expect(sessions).toContain(
      'branch: stuck · Koloft could not check what is left in its worktree'
    )
    expect(sessions).toMatch(
      /Closed, with work left in its worktree, or Koloft could not check it:\n- "gone title" .* · branch: gone · Koloft could not check/
    )
    expect(sessions).not.toContain('nothing left')
  })

  it('lists the owner’s open pull requests with what decides them; one on a listed worktree session’s branch goes with that session, one on a working session’s stays here and says so, the others are only counted, and the issues pull requests close are named', async () => {
    const fixing = row('fixing', { running: true, cwd: `${SHOP}/.claude/worktrees/fix-login` })
    const busy = row('busy', { running: true, cwd: `${SHOP}/.claude/worktrees/busy` })
    const asleep = row('asleep', { running: true, cwd: `${SHOP}/.claude/worktrees/refine` })
    const { run } = harness({
      sidebar: sidebarOf([
        [SHOP, [fixing, busy, asleep]],
        [SHOP_COPY, []]
      ]),
      sessions: [live(fixing, 'waiting'), live(busy, 'working')],
      asleep: ['asleep'],
      worktrees: {
        [SHOP]: [
          { dir: `${SHOP}/.claude/worktrees/fix-login`, branch: 'fix-login' },
          { dir: `${SHOP}/.claude/worktrees/busy`, branch: 'busy' },
          { dir: `${SHOP}/.claude/worktrees/refine`, branch: 'refine' }
        ]
      },
      repos: { [SHOP]: 'octo/shop', [SHOP_COPY]: 'octo/shop' },
      pulls: {
        state: 'ok',
        me: 'alice',
        closesUnknown: false,
        pulls: [
          pull(41, { title: 'Bump vite', closes: [12] }),
          pull(42, { author: 'bob', reviewers: ['alice'], checks: 'failing', files: 3 }),
          pull(43, { author: 'bob' }),
          pull(44, { branch: 'fix-login' }),
          pull(45, { branch: 'busy' }),
          pull(46, { branch: 'refine' })
        ]
      }
    })
    const { text } = await run([])
    expect(section(text, 'SESSIONS')).toMatch(
      /"fixing title" .* · branch: fix-login · .*its pull request: #44 /
    )
    expect(section(text, 'SESSIONS')).toMatch(
      /"asleep title" .* · branch: refine · .*its pull request: #46 /
    )
    const pulls = section(text, 'PULL REQUESTS')
    expect(pulls).not.toMatch(/- #46/)
    expect(pulls.match(/octo\/shop \(/g)).toHaveLength(1)
    expect(pulls).toContain(
      '- #41 "Bump vite" · opened by the owner · checks: passing · 1 file changed · open 5 days · closes #12'
    )
    expect(pulls).toContain(
      '- #42 "PR 42" · opened by bob · asks the owner to review · checks: failing · 3 files changed'
    )
    expect(pulls).toContain('other open pull requests, not tied to a session: #43 ')
    expect(pulls).not.toMatch(/- #44/)
    expect(pulls).toMatch(/- #45 .* · its session "busy title" is working/)
    expect(pulls).toContain('issues an open pull request says it closes: #12 (#41)')
  })

  it('says so when the gh that lists pull requests cannot tell which issues they close', async () => {
    const { run } = harness({
      sidebar: sidebarOf([[SHOP, []]]),
      sessions: [],
      repos: { [SHOP]: 'octo/shop' },
      pulls: { state: 'ok', me: 'alice', closesUnknown: true, pulls: [pull(41)] }
    })
    expect(section((await run([])).text, 'PULL REQUESTS')).toContain('too old to tell')
  })

  it('shows each workspace with its to-do note, or, with none yet, the instruction and TODO files to look at', async () => {
    const { run } = harness({
      sidebar: sidebarOf([
        [SHOP, [row('s', { mtime: NOW - DAY })]],
        [NOTES_WS, []]
      ]),
      sessions: [],
      repos: { [SHOP]: 'octo/shop' },
      notes: { 'octo/shop': 'Issues assigned to alice.' },
      files: { [NOTES_WS]: { 'AGENTS.md': '', 'TODO.md': '', 'README.md': '' } }
    })
    const workspaces = section((await run([])).text, 'WORKSPACES')
    expect(workspaces).toContain(
      'shop · /work/shop · GitHub octo/shop · last used 1 day ago · to-do note (for every workspace of octo/shop): "Issues assigned to alice."'
    )
    expect(workspaces).toContain(
      'notes · /work/notes · no GitHub repository · no sessions yet · no to-do note yet · files: AGENTS.md, TODO.md'
    )
  })

  it('names each MCP server, which agents reach it and from where, and which ones the butler’s own agent can use from its folder', async () => {
    const { run } = harness({
      sidebar: sidebarOf([]),
      sessions: [],
      servers: [
        { name: 'linear', backend: 'codex' },
        { name: 'linear', backend: 'claude' },
        { name: 'jira', backend: 'claude', onlyIn: SHOP }
      ]
    })
    const tools = section((await run([])).text, 'TOOLS SET UP')
    expect(tools).toContain('- jira: Claude (only in /work/shop)')
    expect(tools).toContain('- linear: Claude (everywhere), Codex (everywhere)')
    expect(tools).toContain('You and your helpers run on Codex, so you can use: linear.')
  })
})

describe('koloft todo note', () => {
  it('keeps one note per GitHub repository, shared by its workspaces, and one per workspace otherwise; an empty note removes it', async () => {
    const { run, notes } = harness({
      sidebar: sidebarOf([
        [SHOP, []],
        [SHOP_COPY, []],
        [NOTES_WS, []]
      ]),
      sessions: [],
      repos: { [SHOP]: 'octo/shop', [SHOP_COPY]: 'octo/shop' }
    })
    expect((await run(['note', 'shop'])).text).toBe(
      'The repository octo/shop has no to-do note yet.'
    )
    expect((await run(['note', 'shop', '--', 'Issues assigned to alice.'])).text).toBe(
      'Saved the to-do note of the repository octo/shop.'
    )
    expect((await run(['note', 'shop-2'])).text).toBe('Issues assigned to alice.')
    await run(['note', 'notes', '--', 'The TODO.md file.'])
    expect(notes).toEqual({
      'octo/shop': 'Issues assigned to alice.',
      [NOTES_WS]: 'The TODO.md file.'
    })
    await run(['note', 'notes', '--'])
    expect(notes).toEqual({ 'octo/shop': 'Issues assigned to alice.' })
  })
})

describe('koloft todo file', () => {
  it('prints an instruction or TODO file of a workspace, and nothing else', async () => {
    const { run } = harness({
      sidebar: sidebarOf([[NOTES_WS, []]]),
      sessions: [],
      files: {
        [NOTES_WS]: { 'CLAUDE.md': 'Mark decisions with Needs decision.', '.env': 'SECRET=1' }
      }
    })
    expect((await run(['file', 'notes', 'CLAUDE.md'])).text).toBe(
      'Mark decisions with Needs decision.'
    )
    expect(await run(['file', 'notes', '.env'])).toMatchObject({ exit: 1 })
  })
})

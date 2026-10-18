import { describe, it, expect } from 'vitest'
import { SessionSync, type SyncSession, type DefaultMove } from '../../src/main/sessionSync'
import { FROM_KOLOFT } from '../../src/main/crossSessionMessage'

const HOLDS_THE_TIP = '/r/held'
const ON_MAIN = '/r/root'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const SUBJECTS: Record<string, string> = { [`${A}..${B}`]: 'fix: login', [`${B}..${C}`]: 'feat: y' }

function rig(repos: Record<string, string>, busy: Set<string> = new Set()) {
  const got: { tabId: string; how: string; text: string }[] = []
  const sync = new SessionSync({
    idle: (tabId) => !busy.has(tabId),
    modeOf: () => 'bypass',
    repoOf: async (dir) => repos[dir] ?? null,
    gitOut: async (dir, args) => {
      if (args[0] === 'merge-base') return dir === HOLDS_THE_TIP ? '' : null
      if (args[0] === 'rev-parse') return dir === ON_MAIN ? 'main\n' : 'fix-login\n'
      if (args[0] === 'log') return `${SUBJECTS[args[2]]}\n`
      return 'src/store.ts\nREADME.md\n'
    },
    queue: async (tabId, text) => void got.push({ tabId, how: 'queue', text }),
    sendLine: async (tabId, line) =>
      void got.push({
        tabId,
        how: 'peerLine',
        text: JSON.parse(line).message.content.split('\n')[1]
      }),
    type: async (tabId, keys) => void got.push({ tabId, how: 'typed', text: keys.join('') })
  })
  return { sync, got }
}

function session(
  tabId: string,
  treeRoot: string,
  writes: [string, number][] = [],
  live = 0,
  backendId: 'claude' | 'codex' = 'claude'
): SyncSession {
  return {
    tabId,
    sessionId: `s-${tabId}`,
    backendId,
    title: `Session ${tabId}`,
    treeRoot,
    files: writes.map(([src, wroteAt]) => ({ src, label: src, access: 'wrote', wroteAt })),
    liveWrites: live
  }
}

const MOVE: DefaultMove = { wsPath: '/r/ws', defRef: 'origin/main', from: A, to: B }

describe('telling open sessions what changed around them', () => {
  it('main moving tells every open session of that repository whose branch lacks the new tip, naming the files it changed too; a session holding the tip, one on main itself (Koloft’s own pull serves it), or one in another repository hears nothing', async () => {
    const { sync, got } = rig({
      '/r/ws': 'repo',
      '/r/a': 'repo',
      [HOLDS_THE_TIP]: 'repo',
      [ON_MAIN]: 'repo',
      '/x/other': 'elsewhere'
    })
    await sync.defaultMoved(MOVE, [
      session('a', '/r/a', [['/r/a/src/store.ts', 5]]),
      session('held', HOLDS_THE_TIP),
      session('root', ON_MAIN),
      session('other', '/x/other')
    ])
    expect(got.map((g) => g.tabId)).toEqual(['a'])
    expect(got[0].text).toBe(
      `${FROM_KOLOFT}origin/main moved from aaaaaaa to bbbbbbb, with 1 new commit: "fix: login". It changed files you changed too: src/store.ts. Whether your work needs it now is your call; nobody asks you to merge or rebase.`
    )
    await sync.defaultMoved(MOVE, [session('a', '/r/a')])
    expect(got).toHaveLength(1)
  })

  it('a local Claude session hears at once even mid-turn; a busy Codex or ssh Claude session hears when its turn ends, in one message however often main moved meanwhile', async () => {
    const ssh = 'ssh://box/r/ssh'
    const busy = new Set(['cc', 'cx', 'ssh'])
    const { sync, got } = rig(
      { '/r/ws': 'repo', '/r/cc': 'repo', '/r/cx': 'repo', [ssh]: 'repo' },
      busy
    )
    const all = [
      session('cc', '/r/cc'),
      session('cx', '/r/cx', [], 0, 'codex'),
      session('ssh', ssh)
    ]
    await sync.defaultMoved(MOVE, all)
    await sync.defaultMoved({ ...MOVE, from: B, to: C }, all)
    expect(got.map((g) => `${g.tabId} ${g.how}`)).toEqual(['cc peerLine', 'cc peerLine'])

    sync.flush('cx')
    expect(got).toHaveLength(2)
    busy.clear()
    sync.flush('cx')
    sync.flush('ssh')
    expect(got.slice(2).map((g) => `${g.tabId} ${g.how}`)).toEqual(['cx queue', 'ssh typed'])
    expect(got[2].text).toContain(
      'origin/main moved from aaaaaaa to ccccccc, with 2 new commits: "feat: y", "fix: login".'
    )
    expect(got[3].text.endsWith('\r')).toBe(true)
    sync.flush('cx')
    expect(got).toHaveLength(4)
  })

  it('a write made while open tells each other open session of the same repository that changed the same file, both ways and once; writes a resumed session brings back from its history never count', async () => {
    const { sync, got } = rig({ '/r/a': 'repo', '/r/b': 'repo', '/x/c': 'elsewhere' })
    const a = (wroteAt: number, live: number) =>
      session('a', '/r/a', [['/r/a/src/store.ts', wroteAt]], live, 'codex')
    const b = (wroteAt: number, live: number) =>
      session('b', '/r/b', [['/r/b/src/store.ts', wroteAt]], live, 'codex')
    const c = session('c', '/x/c', [['/x/c/src/store.ts', 10]], 1, 'codex')
    await sync.observe([a(1, 0), session('b', '/r/b'), session('c', '/x/c')])
    await sync.observe([a(1, 0), b(10, 1), c])
    expect(got).toEqual([])

    await sync.observe([a(20, 1), b(10, 1), c])
    expect(got.map((g) => `${g.tabId}: ${g.text}`)).toEqual([
      `b: ${FROM_KOLOFT}The session "Session a" changed files you changed too: src/store.ts. It works in another worktree of this repository, so your two branches may conflict when both reach main.`,
      `a: ${FROM_KOLOFT}The session "Session b" changed files you changed too: src/store.ts. It works in another worktree of this repository, so your two branches may conflict when both reach main.`
    ])

    await sync.observe([a(20, 1), b(30, 2), c])
    expect(got).toHaveLength(2)
  })

  it('two sessions in one folder are told to read the file again before editing it', async () => {
    const { sync, got } = rig({ '/r': 'repo' })
    await sync.observe([session('a', '/r'), session('b', '/r')])
    await sync.observe([session('a', '/r'), session('b', '/r', [['/r/x.ts', 5]], 1)])
    await sync.observe([
      session('a', '/r', [['/r/x.ts', 9]], 1),
      session('b', '/r', [['/r/x.ts', 5]], 1)
    ])
    expect(got[0].text).toMatch(
      /It works in your folder, so read them again before you edit them\.$/
    )
  })
})

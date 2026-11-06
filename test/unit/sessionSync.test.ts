import { describe, it, expect } from 'vitest'
import { SessionSync, type SyncSession, type DefaultMove } from '../../src/main/sessionSync'
import { FROM_KOLOFT } from '../../src/main/crossSessionMessage'

const HOLDS_THE_TIP = '/r/held'
const ON_MAIN = '/r/root'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)
const SUBJECTS: Record<string, string> = {
  [`${A}..${B}`]: 'fix: login',
  [`${B}..${C}`]: 'feat: y',
  [`${C}..${D}`]: 'feat: z'
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

function rig(repos: Record<string, string>) {
  const got: { tabId: string; text: string }[] = []
  const left = new Map<string, string>()
  const sync = new SessionSync({
    repoOf: async (dir) => repos[dir] ?? null,
    gitOut: async (dir, args) => {
      if (args[0] === 'merge-base') return dir === HOLDS_THE_TIP ? '' : null
      if (args[0] === 'rev-parse') return dir === ON_MAIN ? 'main\n' : 'fix-login\n'
      if (args[0] === 'log') return `${SUBJECTS[args[2]]}\n`
      return 'src/store.ts\nREADME.md\n'
    },
    notice: (tabId) => ({
      leave: async (fresh, merged) => {
        const kept = merged !== undefined && left.has(tabId) ? 'merged' : 'fresh'
        const text = kept === 'merged' ? merged! : fresh
        left.set(tabId, text)
        got.push({ tabId, text })
        return kept
      },
      drop: async () => void left.delete(tabId)
    })
  })
  return { sync, got, left }
}

function session(
  tabId: string,
  treeRoot: string,
  writes: [string, number][] = [],
  live = 0,
  sessionId = `s-${tabId}`
): SyncSession {
  return {
    tabId,
    sessionId,
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
    await settled()
    expect(got.map((g) => g.tabId)).toEqual(['a'])
    expect(got[0].text).toBe(
      `${FROM_KOLOFT}origin/main moved from aaaaaaa to bbbbbbb, with 1 new commit: "fix: login". It changed files you changed too: src/store.ts. Whether your work needs it now is your call; nobody asks you to merge or rebase.`
    )
    await sync.defaultMoved(MOVE, [session('a', '/r/a')])
    await settled()
    expect(got).toHaveLength(1)
  })

  it('a move of main is left for the session at once; while it is still unread a later move folds into it, from the first tip to the last, and once the session has read it the next move starts a new one', async () => {
    const { sync, left } = rig({ '/r/ws': 'repo', '/r/a': 'repo' })
    const all = [session('a', '/r/a')]
    await sync.defaultMoved(MOVE, all)
    await settled()
    await sync.defaultMoved({ ...MOVE, from: B, to: C }, all)
    await settled()
    expect(left.get('a')).toContain(
      'origin/main moved from aaaaaaa to ccccccc, with 2 new commits: "feat: y", "fix: login".'
    )

    left.delete('a')
    await sync.defaultMoved({ ...MOVE, from: C, to: D }, all)
    await settled()
    expect(left.get('a')).toContain(
      'origin/main moved from ccccccc to ddddddd, with 1 new commit: "feat: z".'
    )
  })

  it('a write made while open tells each other open session of the same repository that changed the same file, both ways and once; writes a resumed session brings back from its history never count', async () => {
    const { sync, got } = rig({ '/r/a': 'repo', '/r/b': 'repo', '/x/c': 'elsewhere' })
    const a = (wroteAt: number, live: number) =>
      session('a', '/r/a', [['/r/a/src/store.ts', wroteAt]], live)
    const b = (wroteAt: number, live: number) =>
      session('b', '/r/b', [['/r/b/src/store.ts', wroteAt]], live)
    const c = session('c', '/x/c', [['/x/c/src/store.ts', 10]], 1)
    await sync.observe([a(1, 0), session('b', '/r/b'), session('c', '/x/c')])
    await sync.observe([a(1, 0), b(10, 1), c])
    await settled()
    expect(got).toEqual([])

    await sync.observe([a(20, 1), b(10, 1), c])
    await settled()
    expect(got.map((g) => `${g.tabId}: ${g.text}`)).toEqual([
      `b: ${FROM_KOLOFT}The session "Session a" changed files you changed too: src/store.ts. It works in another worktree of this repository, so your two branches may conflict when both reach main.`,
      `a: ${FROM_KOLOFT}The session "Session b" changed files you changed too: src/store.ts. It works in another worktree of this repository, so your two branches may conflict when both reach main.`
    ])

    await sync.observe([a(20, 1), b(30, 2), c])
    await settled()
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
    await settled()
    expect(got[0].text).toMatch(
      /It works in your folder, so read them again before you edit them\.$/
    )
  })

  it('when another session takes over the tab (/clear, a resume), what was left unread for the one before goes', async () => {
    const { sync, left } = rig({ '/r': 'repo' })
    const b = session('b', '/r', [['/r/x.ts', 5]], 1)
    await sync.observe([session('a', '/r'), session('b', '/r')])
    await sync.observe([session('a', '/r', [['/r/x.ts', 9]], 1), b])
    await settled()
    expect(left.has('b')).toBe(true)

    await sync.observe([session('a', '/r', [['/r/x.ts', 9]], 1), { ...b, sessionId: 's-new' }])
    await settled()
    expect(left.has('b')).toBe(false)
  })
})

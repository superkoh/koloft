import { describe, it, expect } from 'vitest'
import { SessionSync, type SyncSession, type DefaultMove } from '../../src/main/sessionSync'
import { FROM_KOLOFT } from '../../src/main/crossSessionMessage'
import type { BackendId } from '@shared/types'

interface Tab {
  backend: BackendId
  remote?: boolean
  idle?: boolean
}

const HOLDS_THE_TIP = '/r/held'

function rig(tabs: Record<string, Tab>, repos: Record<string, string>) {
  const got: { tabId: string; how: string; text: string }[] = []
  const sync = new SessionSync({
    backendOf: (tabId) => tabs[tabId]?.backend,
    remote: (tabId) => !!tabs[tabId]?.remote,
    idle: (tabId) => tabs[tabId]?.idle ?? true,
    modeOf: () => 'bypass',
    repoOf: async (treeRoot) => repos[treeRoot] ?? null,
    hasCommit: async (treeRoot) => treeRoot === HOLDS_THE_TIP,
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
  live = 0
): SyncSession {
  return {
    tabId,
    sessionId: `s-${tabId}`,
    title: `Session ${tabId}`,
    treeRoot,
    files: writes.map(([src, wroteAt]) => ({ src, label: src, access: 'wrote', wroteAt })),
    liveWrites: live
  }
}

const MOVE: DefaultMove = {
  defRef: 'origin/main',
  from: 'a'.repeat(40),
  to: 'b'.repeat(40),
  subjects: ['fix: login'],
  changed: ['src/store.ts', 'README.md']
}

describe('telling open sessions what changed around them', () => {
  it('main moving tells every open session of that repository whose HEAD lacks the new tip, naming the files it changed too; a session holding the tip, or in another repository, hears nothing', async () => {
    const { sync, got } = rig(
      { a: { backend: 'claude' }, held: { backend: 'claude' }, other: { backend: 'claude' } },
      { '/r/a': 'repo', [HOLDS_THE_TIP]: 'repo', '/x/other': 'elsewhere' }
    )
    await sync.defaultMoved('repo', MOVE, [
      session('a', '/r/a', [['/r/a/src/store.ts', 5]]),
      session('held', HOLDS_THE_TIP),
      session('other', '/x/other')
    ])
    expect(got.map((g) => g.tabId)).toEqual(['a'])
    expect(got[0].text).toBe(
      `${FROM_KOLOFT}origin/main moved from aaaaaaa to bbbbbbb, with 1 new commit: "fix: login". It changed files you changed too: src/store.ts. Whether your work needs it now is your call; nobody asks you to merge or rebase.`
    )
    await sync.defaultMoved('repo', MOVE, [session('a', '/r/a')])
    expect(got).toHaveLength(1)
  })

  it('a local Claude session hears at once even mid-turn; a busy Codex or ssh Claude session hears when its turn ends, in one message however often main moved meanwhile', async () => {
    const tabs: Record<string, Tab> = {
      cc: { backend: 'claude', idle: false },
      cx: { backend: 'codex', idle: false },
      ssh: { backend: 'claude', remote: true, idle: false }
    }
    const { sync, got } = rig(tabs, { '/r/cc': 'repo', '/r/cx': 'repo', '/r/ssh': 'repo' })
    const all = [session('cc', '/r/cc'), session('cx', '/r/cx'), session('ssh', '/r/ssh')]
    await sync.defaultMoved('repo', MOVE, all)
    await sync.defaultMoved(
      'repo',
      { ...MOVE, from: MOVE.to, to: 'c'.repeat(40), subjects: ['feat: y'] },
      all
    )
    expect(got.map((g) => `${g.tabId} ${g.how}`)).toEqual(['cc peerLine', 'cc peerLine'])

    sync.flush('cx')
    expect(got).toHaveLength(2)
    tabs.cx.idle = true
    tabs.ssh.idle = true
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
    const { sync, got } = rig(
      { a: { backend: 'codex' }, b: { backend: 'codex' }, c: { backend: 'codex' } },
      { '/r/a': 'repo', '/r/b': 'repo', '/x/c': 'elsewhere' }
    )
    await sync.observe([
      session('a', '/r/a', [['/r/a/src/store.ts', 1]]),
      session('b', '/r/b'),
      session('c', '/x/c')
    ])
    await sync.observe([
      session('a', '/r/a', [['/r/a/src/store.ts', 1]]),
      session('b', '/r/b', [['/r/b/src/store.ts', 10]], 1),
      session('c', '/x/c', [['/x/c/src/store.ts', 10]], 1)
    ])
    expect(got).toEqual([])

    await sync.observe([
      session('a', '/r/a', [['/r/a/src/store.ts', 20]], 1),
      session('b', '/r/b', [['/r/b/src/store.ts', 10]], 1),
      session('c', '/x/c', [['/x/c/src/store.ts', 10]], 1)
    ])
    expect(got.map((g) => `${g.tabId}: ${g.text}`)).toEqual([
      `b: ${FROM_KOLOFT}The session "Session a" changed files you changed too: src/store.ts. It works in another worktree of this repository, so your two branches may conflict when both reach main.`,
      `a: ${FROM_KOLOFT}The session "Session b" changed files you changed too: src/store.ts. It works in another worktree of this repository, so your two branches may conflict when both reach main.`
    ])

    await sync.observe([
      session('a', '/r/a', [['/r/a/src/store.ts', 20]], 1),
      session('b', '/r/b', [['/r/b/src/store.ts', 30]], 2),
      session('c', '/x/c', [['/x/c/src/store.ts', 10]], 1)
    ])
    expect(got).toHaveLength(2)
  })

  it('two sessions in one folder are told to read the file again before editing it', async () => {
    const { sync, got } = rig(
      { a: { backend: 'claude' }, b: { backend: 'claude' } },
      { '/r': 'repo' }
    )
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

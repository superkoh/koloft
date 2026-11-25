import { describe, expect, it } from 'vitest'
import { worktreeExitFollow, type WorktreeExitFollowDeps } from '../../src/main/worktreeExitFollow'
import { WorktreeRemovalWatch } from '../../src/agents/claude/main/claudeWorktreeExit'
import { CH } from '../../src/shared/ipcChannels'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import type { HostId } from '../../src/shared/types'

const STARTS_REMOVING = '\x1b[?25h\x1b7\x1b[r\x1b8\x1b]0;\x07Removing worktree…\r\n'
const FAILED_LINE =
  'Could not finish removing the worktree at /r/.claude/worktrees/x; it may be partly deleted.'
const HOSTS: HostId[] = ['local', 'ssh']

interface Tab {
  kind: string
  host: HostId
  pid: number
  session?: { sessionId: string; treeRoot: string }
}

function follow(tabs: Record<string, Tab>): {
  f: ReturnType<typeof worktreeExitFollow>
  sent: [string, unknown][]
  store: unknown[][]
  finished: [number, string][]
} {
  const sent: [string, unknown][] = []
  const store: unknown[][] = []
  const finished: [number, string][] = []
  const deps: WorktreeExitFollowDeps = {
    ptyMgr: {
      get: (id: string) => (tabs[id] ? { kind: tabs[id].kind } : undefined),
      pidOf: (id: string) => tabs[id]?.pid
    } as unknown as WorktreeExitFollowDeps['ptyMgr'],
    tracker: { infoOf: (id) => tabs[id]?.session },
    claudeStore: () => ({
      leavingWorktree: (...args) => void store.push(['leaving', ...args]),
      leftWorktree: (...args) => void store.push(['left', ...args])
    }),
    hostOfTab: (id) => tabs[id].host,
    sendToRenderer: (channel, ...args) => {
      sent.push([channel, args[0]])
      return true
    },
    newWatch: () => new WorktreeRemovalWatch(),
    finishAfterKoloftQuits: (pid, root) => void finished.push([pid, root])
  }
  return { f: worktreeExitFollow(deps), sent, store, finished }
}

const claudeTab = (host: HostId, sessionId = 's-1'): Tab => ({
  kind: 'claude',
  host,
  pid: 4242,
  session: { sessionId, treeRoot: '/r/.claude/worktrees/x' }
})

// CC§4
describe('following an agent as it removes its own worktree at /exit', () => {
  it('closes the tab of a Claude Code session on this Mac and on a machine once it starts removing its worktree, and never a Codex or Antigravity tab that prints the same bytes', () => {
    const tabs: Record<string, Tab> = {}
    for (const kind of SESSION_BACKENDS)
      for (const host of HOSTS)
        tabs[`${kind}/${host}`] = {
          kind,
          host,
          pid: 1,
          session: { sessionId: `${kind}-${host}`, treeRoot: '/r' }
        }
    const { f, sent } = follow(tabs)
    for (const id of Object.keys(tabs)) f.watchForWorktreeRemoval(id, STARTS_REMOVING)
    expect(sent.filter(([channel]) => channel === CH.tab.killedByMain).map(([, id]) => id)).toEqual(
      ['claude/local', 'claude/ssh']
    )
  })

  it('tells the session store the session is leaving its worktree, and that it left it once the terminal ends after "Worktree removed", with no toast and nothing left to finish at quit', () => {
    const { f, sent, store, finished } = follow({ t: claudeTab('local') })
    f.watchForWorktreeRemoval('t', STARTS_REMOVING)
    expect(store).toEqual([['leaving', 's-1', 't']])
    f.watchForWorktreeRemoval('t', 'Worktree removed (no changes)\r\n')
    f.tabExited({ id: 't' })
    expect(store).toEqual([
      ['leaving', 's-1', 't'],
      ['left', 's-1', true]
    ])
    expect(sent).toEqual([[CH.tab.killedByMain, 't']])
    f.koloftQuits()
    expect(finished).toEqual([])
  })

  it('shows the line Claude Code printed when it could not remove the worktree, and tells the store the worktree was not removed', () => {
    const { f, sent, store } = follow({ t: claudeTab('ssh') })
    f.watchForWorktreeRemoval('t', STARTS_REMOVING)
    f.watchForWorktreeRemoval('t', FAILED_LINE + '\r\n')
    f.tabExited({ id: 't' })
    expect(store.at(-1)).toEqual(['left', 's-1', false])
    expect(sent.at(-1)).toEqual([
      CH.toast.show,
      `Claude Code did not remove the worktree: ${FAILED_LINE}`
    ])
  })

  it('a terminal that ends without a removal having started says nothing and tells the store nothing', () => {
    const { f, sent, store } = follow({ t: claudeTab('local') })
    f.watchForWorktreeRemoval('t', 'hello\r\n')
    f.tabExited({ id: 't' })
    expect(sent).toEqual([])
    expect(store).toEqual([])
  })

  it('a tab with no session yet still closes, and the store hears nothing of it', () => {
    const { f, sent, store } = follow({ t: { kind: 'claude', host: 'local', pid: 7 } })
    f.watchForWorktreeRemoval('t', STARTS_REMOVING)
    f.tabExited({ id: 't' })
    expect(sent).toEqual([[CH.tab.killedByMain, 't']])
    expect(store).toEqual([])
  })

  it('when Koloft quits mid-removal it finishes the removal on this Mac after that claude is gone, but not on a machine, where the removal outlives the quit, and only once', () => {
    const { f, finished } = follow({
      here: claudeTab('local', 'a'),
      there: { ...claudeTab('ssh', 'b'), pid: 5353 }
    })
    f.watchForWorktreeRemoval('here', STARTS_REMOVING)
    f.watchForWorktreeRemoval('there', STARTS_REMOVING)
    f.koloftQuits()
    expect(finished).toEqual([[4242, '/r/.claude/worktrees/x']])
    f.koloftQuits()
    expect(finished).toHaveLength(1)
  })
})

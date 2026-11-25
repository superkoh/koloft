import { describe, expect, it, vi } from 'vitest'

const finished: [number, string][] = []
vi.mock('../../src/agents/claude/main/claudeWorktreeExit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/agents/claude/main/claudeWorktreeExit')>()),
  finishAfterKoloftQuits: (pid: number, root: string) => void finished.push([pid, root])
}))

const { worktreeExitFollow } = await import('../../src/main/worktreeExitFollow')
const { ClaudeBackend } = await import('../../src/agents/claude/main/backend')
const { codexBackend } = await import('../../src/agents/codex/main/backend')
const { agyBackend } = await import('../../src/agents/agy/main/backend')
const { agentManifest } = await import('../../src/core/agent/registry')
const { KEEPS_NO_WORKTREE_RECORDS } = await import('../../src/core/agent/worktreeRecords')
const { CH } = await import('../../src/shared/ipcChannels')
const { SESSION_BACKENDS } = await import('../../src/shared/sessionBackend')
import type { ClaudeBackendDeps } from '../../src/agents/claude/main/backend'
import type { SessionBackend } from '../../src/core/agent/sessionBackends'
import type { BackendId, HostId } from '../../src/shared/types'

const STARTS_REMOVING = '\x1b[?25h\x1b7\x1b[r\x1b8\x1b]0;\x07Removing worktree…\r\n'
const FAILED_LINE =
  'Could not finish removing the worktree at /r/.claude/worktrees/x; it may be partly deleted.'
const HOSTS: HostId[] = ['local', 'ssh']
const NO_RESUME_IS_PLANNED_HERE = {} as Parameters<typeof codexBackend>[1]
const SESSIONS_NOT_ASKED_HERE = {
  worktrees: { records: KEEPS_NO_WORKTREE_RECORDS }
}

interface Tab {
  kind: string
  host: HostId
  pid: number
  session?: { sessionId: string; treeRoot: string }
}

function everyAgent(
  tabs: Record<string, Tab>,
  store: unknown[][]
): Record<BackendId, SessionBackend> {
  const claude = new ClaudeBackend({
    pty: { pidOf: (id: string) => tabs[id]?.pid },
    tracker: { infoOf: (id: string) => tabs[id]?.session },
    store: () => ({
      leavingWorktree: (...args: unknown[]) => void store.push(['leaving', ...args]),
      leftWorktree: (...args: unknown[]) => void store.push(['left', ...args])
    })
  } as unknown as ClaudeBackendDeps)
  const codex = codexBackend(
    { id: 'codex', ...SESSIONS_NOT_ASKED_HERE } as unknown as Parameters<typeof codexBackend>[0],
    NO_RESUME_IS_PLANNED_HERE,
    () => NO_RESUME_IS_PLANNED_HERE
  )
  const agy = agyBackend(
    { id: 'agy', ...SESSIONS_NOT_ASKED_HERE } as unknown as Parameters<typeof agyBackend>[0],
    NO_RESUME_IS_PLANNED_HERE,
    () => NO_RESUME_IS_PLANNED_HERE
  )
  return { claude, codex, agy }
}

function follow(tabs: Record<string, Tab>) {
  const sent: [string, unknown][] = []
  const store: unknown[][] = []
  finished.length = 0
  const agents = everyAgent(tabs, store)
  const f = worktreeExitFollow({
    ptyMgr: {
      get: (id: string) => (tabs[id] ? { kind: tabs[id].kind } : undefined)
    } as unknown as Parameters<typeof worktreeExitFollow>[0]['ptyMgr'],
    watchOf: (backend, tabId, host) => agents[backend].worktreeExitWatch(tabId, host),
    hostOfTab: (id) => tabs[id].host,
    sendToRenderer: (channel, ...args) => {
      sent.push([channel, args[0]])
      return true
    }
  })
  return { f, sent, store, agents }
}

const claudeTab = (host: HostId, sessionId = 's-1'): Tab => ({
  kind: 'claude',
  host,
  pid: 4242,
  session: { sessionId, treeRoot: '/r/.claude/worktrees/x' }
})

// CC§4 CODEX§6 AGY§35
describe('following an agent as it removes its own worktree at /exit', () => {
  it('each agent that its manifest says removes its worktree as it exits, and only such an agent, hands Koloft a watch for its tab, on this Mac and on a machine', () => {
    const { agents } = follow({})
    for (const id of SESSION_BACKENDS)
      for (const host of HOSTS)
        expect(`${id}/${host}: ${!!agents[id].worktreeExitWatch('t', () => host)}`).toBe(
          `${id}/${host}: ${agentManifest(id).flags.removesItsWorktreeAsItExits}`
        )
  })

  // PLATFORM§35
  it('closes the tab of a Claude Code session on this Mac and on a machine, where its tmux passes the title code on, once it starts removing its worktree, and never a Codex or Antigravity tab, which removes no worktree at exit, that prints the same bytes', () => {
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
    const { f, sent, store } = follow({ t: claudeTab('local') })
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
    const { f } = follow({
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

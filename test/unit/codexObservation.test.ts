import { describe, expect, it } from 'vitest'
import { CodexObservation, userThread, type CodexEvent } from '../../src/main/codexObservation'
import { SessionRuntime, turnOf, type StatusEdge } from '../../src/main/sessionRuntime'
import { AttentionTracker } from '../../src/main/attention'
import type { AttentionKind, BackgroundItem } from '../../src/shared/types'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const thread = (id = A) => ({ id, cwd: '/repo', status: { type: 'idle' }, source: 'cli' })

const TAB = 'tab'

function fixture() {
  const runtime = new SessionRuntime()
  const events: CodexEvent[] = []
  const edges: StatusEdge[] = []
  const raised: AttentionKind[] = []
  const attention = new AttentionTracker((_pending, event) => {
    if (event) raised.push(event.kind)
  })
  runtime.on('status', (edge: StatusEdge) => {
    edges.push(edge)
    attention.onStatusChange(edge.tabId, edge.prev, edge.next, {
      windowFocused: false,
      activeTabId: null
    })
  })
  const observer = new CodexObservation((event) => {
    events.push(event)
    if (event.type === 'bound') return runtime.forget(TAB)
    const turn = turnOf(event)
    if (turn) runtime.recordTurn(TAB, turn)
    else if (event.type === 'background-changed') runtime.setBackground(TAB, event.items)
  })
  const bound = () =>
    events.flatMap((e) => (e.type === 'bound' ? [{ thread: e.thread, change: e.change }] : []))
  const background = (): BackgroundItem[] | undefined =>
    events.flatMap((e) => (e.type === 'background-changed' ? [e.items] : [])).at(-1)
  const status = () => runtime.statusOf(TAB)
  const files = () => events.flatMap((e) => (e.type === 'files-changed' ? [e] : [])).at(-1)
  const turnDone = () => raised.filter((kind) => kind === 'turn-done').length
  const bind = (id = A, requestId = 1, method = 'thread/start', cwd?: string) => {
    observer.receive('client', { id: requestId, method, params: { cwd } })
    observer.receive('server', { id: requestId, result: { thread: thread(id) } })
  }
  const server = (method: string, params: object, id?: number) =>
    observer.receive('server', { id, method, params: { threadId: A, ...params } })
  return {
    events,
    edges,
    raised,
    attention,
    observer,
    bind,
    server,
    bound,
    background,
    files,
    status,
    turnDone
  }
}

describe('CodexObservation', () => {
  it('binds only foreground user threads with valid identities', () => {
    for (const extra of [
      { ephemeral: true },
      { parentThreadId: B },
      { threadSource: 'system' },
      { canAcceptDirectInput: false },
      { source: { subAgent: 'review' } },
      { id: 'not-a-uuid' },
      { cwd: 'relative' }
    ]) {
      expect(userThread({ ...thread(), ...extra })).toBeNull()
    }
    expect(userThread({ ...thread(), forkedFromId: B })).not.toBeNull()
  })

  it('distinguishes replacement from switching and uses the requested runtime cwd', () => {
    const f = fixture()
    f.bind()
    f.bind(B, 2, 'thread/resume', '/chosen-checkout')
    expect(f.bound().map((b) => b.change)).toEqual(['replace', 'switch'])
    expect(f.bound().at(-1)?.thread.cwd).toBe('/chosen-checkout')
  })

  it('does not bind a delayed response over a newer foreground switch', () => {
    const f = fixture()
    f.observer.receive('client', { id: 1, method: 'thread/start' })
    f.observer.receive('client', { id: 2, method: 'thread/resume' })
    f.observer.receive('server', { id: 2, result: { thread: thread(B) } })
    f.observer.receive('server', { id: 1, result: { thread: thread() } })
    expect(f.bound()).toHaveLength(1)
    expect(f.bound()[0].thread.id).toBe(B)
  })

  it('uses the effective server cwd and model rather than the stored thread metadata', () => {
    const f = fixture()
    f.observer.receive('client', { id: 1, method: 'thread/resume', params: { cwd: '/requested' } })
    f.observer.receive('server', {
      id: 1,
      result: { cwd: '/effective', model: 'model-from-runtime', thread: thread() }
    })
    expect(f.bound().at(-1)?.thread).toMatchObject({
      cwd: '/effective',
      model: 'model-from-runtime'
    })
  })

  it('requires successful current unsubscribe before recognizing native exit', () => {
    const f = fixture()
    f.bind()
    f.observer.receive('client', { id: 2, method: 'thread/unsubscribe', params: { threadId: A } })
    expect(f.observer.unsubscribed).toBe(false)
    f.observer.receive('server', { id: 2, error: { message: 'refused' } })
    expect(f.observer.unsubscribed).toBe(false)
    f.observer.receive('client', { id: 3, method: 'thread/unsubscribe', params: { threadId: A } })
    f.observer.receive('server', { id: 3, result: { status: 'unsubscribed' } })
    expect(f.observer.unsubscribed).toBe(true)
    f.observer.receive('client', { id: 4, method: 'thread/resume' })
    f.observer.receive('server', { id: 4, error: { message: 'failed' } })
    expect(f.observer.unsubscribed).toBe(false)
  })

  it('ignores old turn completions after A to B to A without clearing current attention', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'old' } })
    f.bind(B, 2, 'thread/resume')
    f.bind(A, 3, 'thread/resume')
    f.server('turn/started', { turn: { id: 'current' } })
    f.server('item/commandExecution/requestApproval', {}, 50)
    const edges = f.edges.length
    f.server('turn/completed', { turn: { id: 'old', status: 'completed' } })
    expect(f.edges).toHaveLength(edges)
    expect(f.status()).toBe('approval')
    expect(f.attention.list().map((e) => e.kind)).toEqual(['approval'])
  })

  it('keeps tool questions distinct from permission approvals across status updates, and the question marks the row as needing you', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'turn' } })
    f.server('item/tool/requestUserInput', {}, 50)
    f.server('thread/status/changed', { status: { type: 'active' } })
    expect(f.status()).toBe('waiting')
    expect(f.attention.list()).toHaveLength(1)
    f.observer.receive('client', { id: 50, result: { answers: {} } })
    expect(f.status()).toBe('working')
    expect(f.raised).not.toContain('approval')
  })

  it('notifies once per live turn that ends, interrupted or completed, and never for a replayed completion', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'first' } })
    f.server('turn/completed', { turn: { id: 'first', status: 'interrupted' } })
    f.server('turn/started', { turn: { id: 'second' } })
    f.server('turn/completed', { turn: { id: 'second', status: 'completed' } })
    f.server('turn/completed', { turn: { id: 'second', status: 'completed' } })
    expect(f.turnDone()).toBe(2)
  })

  it('preserves unknown usage fields and reports context as a ratio', () => {
    const f = fixture()
    const usage = () => f.events.flatMap((e) => (e.type === 'usage' ? [e.usage] : []))
    f.bind()
    f.server('thread/tokenUsage/updated', { tokenUsage: { total: {}, last: {} } })
    expect(usage()).toEqual([])
    f.server('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { inputTokens: 50, outputTokens: 5, cachedInputTokens: 10 },
        last: { totalTokens: 25 },
        modelContextWindow: 100
      }
    })
    expect(usage().at(-1)).toMatchObject({
      inTok: 50,
      ctxPct: 0.25,
      cacheWriteTok: 0
    })
  })

  // CODEX§4
  it('keeps a main turn working until its spawned child finishes, without rebinding to the child', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'main' } })
    f.server('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: A,
        receiverThreadIds: [B],
        agentsStates: { [B]: { status: 'pendingInit' } }
      }
    })
    f.server('thread/status/changed', { threadId: B, status: { type: 'active', activeFlags: [] } })
    f.server('turn/started', { threadId: B, turn: { id: 'child' } })
    f.server('thread/status/changed', { status: { type: 'idle' } })
    f.server('turn/completed', { turn: { id: 'main', status: 'completed' } })
    expect(f.status()).toBe('working')
    expect(f.background()).toEqual([expect.objectContaining({ kind: 'agent', state: 'working' })])
    expect(f.turnDone()).toBe(0)
    f.server('thread/status/changed', { threadId: B, status: { type: 'idle' } })
    f.server('turn/completed', { threadId: B, turn: { id: 'child', status: 'completed' } })
    expect(f.status()).toBe('waiting')
    expect(f.turnDone()).toBe(1)
    expect(f.bound()).toHaveLength(1)
  })

  it('shows a surviving command as unclassified background while the turn itself lands waiting', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'main' } })
    const command = {
      type: 'commandExecution',
      id: 'command',
      command: 'sleep 12',
      processId: '66395',
      source: 'unifiedExecStartup',
      status: 'inProgress'
    }
    f.server('item/started', { item: command, turnId: 'main' })
    expect(f.background()).toEqual([])
    f.server('turn/completed', { turn: { id: 'main', status: 'completed' } })
    expect(f.status()).toBe('waiting')
    expect(f.background()).toEqual([
      expect.objectContaining({ kind: 'command', label: 'sleep 12', state: 'unknown' })
    ])
    expect(f.turnDone()).toBe(1)
    f.server('item/completed', {
      item: { ...command, status: 'completed', exitCode: 0 },
      turnId: 'main'
    })
    expect(f.background()).toEqual([])
    expect(f.status()).toBe('waiting')
    expect(f.turnDone()).toBe(1)
  })

  it('does not import arbitrary system-thread activity as a child or block completion', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'main' } })
    f.server('thread/status/changed', { threadId: B, status: { type: 'active' } })
    f.server('item/started', {
      threadId: B,
      item: { type: 'commandExecution', id: 'other', command: 'unrelated', status: 'inProgress' }
    })
    f.server('turn/completed', { turn: { id: 'main', status: 'completed' } })
    expect(f.background()).toEqual([])
    expect(f.turnDone()).toBe(1)
  })

  it('keeps child permission request zero pending when the parent turn completes', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'main' } })
    f.server('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: A,
        receiverThreadIds: [B],
        agentsStates: { [B]: { status: 'running' } }
      }
    })
    f.server('item/commandExecution/requestApproval', { threadId: B }, 0)
    f.server('turn/completed', { turn: { id: 'main', status: 'completed' } })
    expect(f.status()).toBe('approval')
    expect(f.raised.at(-1)).toBe('approval')
    f.observer.receive('client', { id: 0, result: { decision: 'accept' } })
    expect(f.status()).toBe('working')
    expect(f.turnDone()).toBe(0)
  })

  it('does not let old background activity change the new foreground session or replay completion on return', () => {
    const f = fixture()
    const child = '33333333-3333-4333-8333-333333333333'
    f.bind()
    f.server('turn/started', { turn: { id: 'main' } })
    f.server('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: A,
        receiverThreadIds: [child],
        agentsStates: { [child]: { status: 'running' } }
      }
    })
    f.server('turn/completed', { turn: { id: 'main', status: 'completed' } })
    f.bind(B, 2, 'thread/resume')
    const edges = f.edges.length
    const raised = f.raised.length
    f.server('thread/status/changed', { threadId: child, status: { type: 'idle' } })
    expect(f.edges).toHaveLength(edges)
    expect(f.raised).toHaveLength(raised)
    f.bind(A, 3, 'thread/resume')
    expect(f.background()).toEqual([expect.objectContaining({ state: 'waiting' })])
    expect(f.turnDone()).toBe(0)
  })

  it('does not misreport a snapshot waiting for user input as work in progress', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'main' } })
    f.server('thread/status/changed', {
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] }
    })
    expect(f.status()).toBe('waiting')
  })

  const patch = (status: string, changes: object[]) => ({
    item: { type: 'fileChange', id: 'patch', status, changes }
  })
  const command = (command: string, commandActions: object[]) => ({
    item: {
      type: 'commandExecution',
      id: 'cmd-' + command,
      status: 'completed',
      command: `/bin/zsh -lc '${command}'`,
      cwd: '/repo',
      commandActions
    }
  })

  it('lists the files a patch wrote, with line counts, and a file a command read, from the item shapes Codex sends', () => {
    const f = fixture()
    f.bind()
    f.server(
      'item/completed',
      patch('completed', [
        { path: '/repo/added.txt', kind: { type: 'add' }, diff: 'hi\n' },
        {
          path: '/repo/notes.txt',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-old line\n+new line\n'
        }
      ])
    )
    f.server(
      'item/completed',
      command('cat docs/a.md', [
        { type: 'read', command: 'cat docs/a.md', name: 'a.md', path: '/repo/docs/a.md' }
      ])
    )
    expect(f.files()).toEqual({
      type: 'files-changed',
      files: [
        { src: '/repo/added.txt', label: 'added.txt', access: 'wrote', added: 1 },
        { src: '/repo/notes.txt', label: 'notes.txt', access: 'wrote', added: 1, removed: 1 },
        { src: '/repo/docs/a.md', label: 'a.md', access: 'read' }
      ],
      lastTouched: '/repo/docs/a.md',
      lastWritten: '/repo/notes.txt',
      liveWrites: 1
    })
  })

  it('ignores a declined patch and a shell command that only writes through the shell', () => {
    const f = fixture()
    f.bind()
    f.server(
      'item/completed',
      patch('declined', [{ path: '/repo/a.txt', kind: { type: 'add' }, diff: 'x\n' }])
    )
    f.server(
      'item/completed',
      command('echo hello > b.txt', [{ type: 'unknown', command: 'echo hello > b.txt' }])
    )
    expect(f.files()).toBeUndefined()
  })

  it('starts a fresh file list when the foreground session changes', () => {
    const f = fixture()
    f.bind()
    f.server(
      'item/completed',
      patch('completed', [{ path: '/repo/a.txt', kind: { type: 'add' }, diff: 'a\n' }])
    )
    f.bind(B, 2, 'thread/start')
    f.observer.receive('server', {
      method: 'item/completed',
      params: {
        threadId: B,
        ...patch('completed', [{ path: '/repo/b.txt', kind: { type: 'add' }, diff: 'b\n' }])
      }
    })
    expect(f.files()?.files.map((file) => file.src)).toEqual(['/repo/b.txt'])
  })
})

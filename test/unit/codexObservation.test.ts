import { describe, expect, it, vi } from 'vitest'
import { CodexObservation, userThread } from '../../src/main/codexObservation'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const thread = (id = A) => ({ id, cwd: '/repo', status: { type: 'idle' }, source: 'cli' })

function fixture() {
  const events = {
    bind: vi.fn(),
    status: vi.fn(),
    title: vi.fn(),
    usage: vi.fn(),
    attention: vi.fn(),
    degraded: vi.fn(),
    background: vi.fn()
  }
  const observer = new CodexObservation(events)
  const bind = (id = A, requestId = 1, method = 'thread/start', cwd?: string) => {
    observer.receive('client', { id: requestId, method, params: { cwd } })
    observer.receive('server', { id: requestId, result: { thread: thread(id) } })
  }
  const server = (method: string, params: object, id?: number) =>
    observer.receive('server', { id, method, params: { threadId: A, ...params } })
  return { events, observer, bind, server }
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
    expect(f.events.bind.mock.calls.map((call) => call[1])).toEqual(['replace', 'switch'])
    expect(f.events.bind.mock.lastCall?.[0].cwd).toBe('/chosen-checkout')
  })

  it('does not bind a delayed response over a newer foreground switch', () => {
    const f = fixture()
    f.observer.receive('client', { id: 1, method: 'thread/start' })
    f.observer.receive('client', { id: 2, method: 'thread/resume' })
    f.observer.receive('server', { id: 2, result: { thread: thread(B) } })
    f.observer.receive('server', { id: 1, result: { thread: thread() } })
    expect(f.events.bind).toHaveBeenCalledTimes(1)
    expect(f.events.bind.mock.lastCall?.[0].id).toBe(B)
  })

  it('uses the effective server cwd and model rather than the stored thread metadata', () => {
    const f = fixture()
    f.observer.receive('client', { id: 1, method: 'thread/resume', params: { cwd: '/requested' } })
    f.observer.receive('server', {
      id: 1,
      result: { cwd: '/effective', model: 'model-from-runtime', thread: thread() }
    })
    expect(f.events.bind.mock.lastCall?.[0]).toMatchObject({
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
    f.events.attention.mockClear()
    f.events.status.mockClear()
    f.server('turn/completed', { turn: { id: 'old', status: 'completed' } })
    expect(f.events.attention).not.toHaveBeenCalled()
    expect(f.events.status).not.toHaveBeenCalled()
  })

  it('keeps tool questions distinct from permission approvals across status updates', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'turn' } })
    f.server('item/tool/requestUserInput', {}, 50)
    f.server('thread/status/changed', { status: { type: 'active' } })
    expect(f.events.status).toHaveBeenLastCalledWith('waiting')
    f.observer.receive('client', { id: 50, result: { answers: {} } })
    expect(f.events.status).toHaveBeenLastCalledWith('working')
    expect(f.events.attention.mock.calls.some(([kind]) => kind === 'turn-done')).toBe(false)
  })

  it('notifies only once for a live completed turn, not interrupted or replayed turns', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'first' } })
    f.server('turn/completed', { turn: { id: 'first', status: 'interrupted' } })
    f.server('turn/started', { turn: { id: 'second' } })
    f.server('turn/completed', { turn: { id: 'second', status: 'completed' } })
    f.server('turn/completed', { turn: { id: 'second', status: 'completed' } })
    expect(f.events.attention.mock.calls.filter(([kind]) => kind === 'turn-done')).toHaveLength(1)
  })

  it('preserves unknown usage fields and reports context as a ratio', () => {
    const f = fixture()
    f.bind()
    f.server('thread/tokenUsage/updated', { tokenUsage: { total: {}, last: {} } })
    expect(f.events.usage).not.toHaveBeenCalled()
    f.server('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { inputTokens: 50, outputTokens: 5, cachedInputTokens: 10 },
        last: { totalTokens: 25 },
        modelContextWindow: 100
      }
    })
    expect(f.events.usage.mock.lastCall?.[0]).toMatchObject({
      inTok: 50,
      ctxPct: 0.25,
      cacheWriteTok: 0
    })
  })

  // Event order and payload fields come from the standalone 0.153.4 TUI background probe.
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
    expect(f.events.status).toHaveBeenLastCalledWith('working')
    expect(f.events.background.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({ kind: 'agent', state: 'working' })
    ])
    expect(f.events.attention.mock.calls.filter(([kind]) => kind === 'turn-done')).toHaveLength(0)
    f.server('thread/status/changed', { threadId: B, status: { type: 'idle' } })
    f.server('turn/completed', { threadId: B, turn: { id: 'child', status: 'completed' } })
    expect(f.events.status).toHaveBeenLastCalledWith('waiting')
    expect(f.events.attention.mock.calls.filter(([kind]) => kind === 'turn-done')).toHaveLength(1)
    expect(f.events.bind).toHaveBeenCalledTimes(1)
  })

  it('shows a surviving command as unclassified and suppresses completion until its terminal event', () => {
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
    expect(f.events.background.mock.lastCall?.[0]).toEqual([])
    f.server('turn/completed', { turn: { id: 'main', status: 'completed' } })
    expect(f.events.status).toHaveBeenLastCalledWith('waiting')
    expect(f.events.background.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({ kind: 'command', label: 'sleep 12', state: 'unknown' })
    ])
    expect(f.events.attention.mock.calls.filter(([kind]) => kind === 'turn-done')).toHaveLength(0)
    f.server('item/completed', {
      item: { ...command, status: 'completed', exitCode: 0 },
      turnId: 'main'
    })
    expect(f.events.background.mock.lastCall?.[0]).toEqual([])
    expect(f.events.attention.mock.calls.filter(([kind]) => kind === 'turn-done')).toHaveLength(1)
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
    expect(f.events.background.mock.lastCall?.[0]).toEqual([])
    expect(f.events.attention.mock.calls.filter(([kind]) => kind === 'turn-done')).toHaveLength(1)
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
    expect(f.events.status).toHaveBeenLastCalledWith('approval')
    expect(f.events.attention).toHaveBeenLastCalledWith('approval')
    f.observer.receive('client', { id: 0, result: { decision: 'accept' } })
    expect(f.events.status).toHaveBeenLastCalledWith('working')
    expect(f.events.attention.mock.calls.filter(([kind]) => kind === 'turn-done')).toHaveLength(0)
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
    f.events.status.mockClear()
    f.events.attention.mockClear()
    f.server('thread/status/changed', { threadId: child, status: { type: 'idle' } })
    expect(f.events.status).not.toHaveBeenCalled()
    expect(f.events.attention).not.toHaveBeenCalled()
    f.bind(A, 3, 'thread/resume')
    expect(f.events.background.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({ state: 'waiting' })
    ])
    expect(f.events.attention.mock.calls.filter(([kind]) => kind === 'turn-done')).toHaveLength(0)
  })

  it('does not misreport a snapshot waiting for user input as work in progress', () => {
    const f = fixture()
    f.bind()
    f.server('turn/started', { turn: { id: 'main' } })
    f.server('thread/status/changed', {
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] }
    })
    expect(f.events.status).toHaveBeenLastCalledWith('waiting')
  })
})

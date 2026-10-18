import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexSideServers, SIDE_SERVER_IDLE_MS } from '../../src/main/codexSideServers'
import type { CodexRpc } from '../../src/main/codexTransport'

interface FakeRpc {
  home: string | undefined
  isClosed: boolean
  close: ReturnType<typeof vi.fn>
}

let started: FakeRpc[]
let servers: CodexSideServers

function start(home: string | undefined): CodexRpc {
  const rpc: FakeRpc = {
    home,
    isClosed: false,
    close: vi.fn(async () => {
      rpc.isClosed = true
    })
  }
  started.push(rpc)
  return rpc as unknown as CodexRpc
}

const ask = (home: string | undefined, answer: Promise<unknown> = Promise.resolve()) =>
  servers.ask(home, () => answer)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => (resolve = yes))
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  started = []
  servers = new CodexSideServers(start)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CodexSideServers', () => {
  it('starts one app-server per home on the first question and answers every later question, also ones asked at the same moment, on it', async () => {
    await Promise.all([ask(undefined), ask(undefined), ask('/homes/work')])
    await ask(undefined)
    expect(started.map((s) => s.home)).toEqual([undefined, '/homes/work'])
    expect(started.every((s) => !s.close.mock.calls.length)).toBe(true)
  })

  it('closes an app-server a minute after its last answer, never while a question is still out, and starts a new one for the next question', async () => {
    const slow = deferred()
    const out = ask(undefined, slow.promise)
    await ask(undefined)
    await vi.advanceTimersByTimeAsync(SIDE_SERVER_IDLE_MS * 2)
    expect(started[0].close).not.toHaveBeenCalled()
    slow.resolve()
    await out
    await vi.advanceTimersByTimeAsync(SIDE_SERVER_IDLE_MS - 1)
    await ask(undefined)
    await vi.advanceTimersByTimeAsync(SIDE_SERVER_IDLE_MS - 1)
    expect(started[0].close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(started[0].close).toHaveBeenCalledOnce()
    await ask(undefined)
    expect(started).toHaveLength(2)
  })

  it('an app-server that closed on its own is replaced by a new one on the next question', async () => {
    await ask(undefined)
    started[0].isClosed = true
    await ask(undefined)
    expect(started).toHaveLength(2)
  })

  it("forgetting a home closes only that home's app-server, and quitting closes them all", async () => {
    await Promise.all([ask(undefined), ask('/homes/work'), ask('/homes/play')])
    await servers.forget('/homes/work')
    expect(started.map((s) => s.close.mock.calls.length)).toEqual([0, 1, 0])
    await ask('/homes/work')
    expect(started).toHaveLength(4)
    await servers.closeAll()
    expect(started.map((s) => s.close.mock.calls.length)).toEqual([1, 1, 1, 1])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MACHINE_ASKS_AT_MOST_EVERY_MS, RealFiles, realFilesThere } from '../../src/main/realFiles'

afterEach(() => {
  vi.useRealTimers()
})

describe('realFilesThere', () => {
  it("asks the machine about a remote tab's files by their path there, and keys each real path back to that machine", async () => {
    const asked: [string, string[]][] = []
    const lookup = realFilesThere('devbox', async (host, files) => {
      asked.push([host, files])
      return new Map([['/home/koh/link/a.md', '/srv/api/a.md']])
    })
    const found = await lookup(['ssh://devbox/home/koh/link/a.md', 'ssh://devbox/home/koh/gone.md'])
    expect(asked).toEqual([['devbox', ['/home/koh/link/a.md', '/home/koh/gone.md']]])
    expect(found).toEqual(
      new Map([['ssh://devbox/home/koh/link/a.md', 'ssh://devbox/srv/api/a.md']])
    )
  })
})

describe('RealFiles', () => {
  const item = (src: string) => ({ src, label: src, access: 'wrote' as const, wroteAt: 1 })

  it('keeps listing a file under the path the agent gave when the machine cannot be asked, but not a ~/ path no one can open', async () => {
    const found = vi.fn()
    const real = new RealFiles(async () => {
      throw new Error('ssh: connect to host devbox: Connection refused')
    }, found)
    const given = [item('/home/koh/a.md'), item('~/notes.md')]
    expect(real.merge(given)).toEqual([])
    await vi.waitFor(() => expect(found).toHaveBeenCalled())
    expect(real.merge(given)).toEqual([expect.objectContaining({ src: '/home/koh/a.md' })])
  })

  it('is still finding a file until its first answer, and that answer is passed on even when the file is not there, but a later one saying the same is not', async () => {
    const found = vi.fn()
    const real = new RealFiles(async () => new Map(), found)
    expect(real.stillFinding('/gone.md')).toBe(true)
    await vi.waitFor(() => expect(found).toHaveBeenCalledTimes(1))
    expect(real.stillFinding('/gone.md')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(found).toHaveBeenCalledTimes(1)
  })

  it('asks again about a file that was not there at most once per gap, however often the list changes', async () => {
    vi.useFakeTimers()
    const asked: string[][] = []
    const real = new RealFiles(
      async (files) => (asked.push(files), new Map()),
      () => {},
      MACHINE_ASKS_AT_MOST_EVERY_MS
    )
    real.merge([item('/gone.md')])
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) {
      real.merge([item('/gone.md')])
      await vi.advanceTimersByTimeAsync(MACHINE_ASKS_AT_MOST_EVERY_MS / 10)
    }
    expect(asked.length).toBeLessThanOrEqual(3)
    expect(asked.length).toBeGreaterThan(1)
  })
})

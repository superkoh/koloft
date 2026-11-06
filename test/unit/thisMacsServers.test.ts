import dns from 'dns'
import os from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { namesThisMacsServer, reachesThisMacsServer } from '../../src/main/thisMacsServers'

afterEach(() => vi.restoreAllMocks())

const ownLanAddress = (): string | undefined =>
  Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && i.family === 'IPv4')?.address

describe('a web address that reaches a server on the Mac Koloft runs on, which a session on another machine may not open', () => {
  it('is any way of writing loopback, the unspecified address or one of the Mac’s own addresses', async () => {
    const own = ownLanAddress()
    for (const url of [
      'http://127.0.0.1:8888/tree',
      'https://127.9.9.9/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://localhost:3000/',
      'http://LOCALHOST./',
      'http://app.localhost/',
      'http://[::1]:5173/',
      'http://[::ffff:127.0.0.1]/',
      'http://0.0.0.0:8080/',
      'ws://127.0.0.1:9229/devtools',
      ...(own ? [`http://${own}:8000/`] : [])
    ]) {
      expect(namesThisMacsServer(url), url).toBe(true)
      expect(await reachesThisMacsServer(url), url).toBe(true)
    }
  })

  it('includes a name that resolves to the Mac, but not one that resolves elsewhere', async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async (host: string) =>
      host === 'rebound.test'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }]) as never)
    expect(namesThisMacsServer('http://rebound.test/')).toBe(false)
    expect(await reachesThisMacsServer('http://rebound.test/')).toBe(true)
    expect(await reachesThisMacsServer('https://example.com/')).toBe(false)
  })

  it('counts a name whose lookup takes too long as the Mac, and asks again next time', async () => {
    vi.useFakeTimers()
    try {
      const lookup = vi
        .spyOn(dns.promises, 'lookup')
        .mockImplementation((() => new Promise(() => {})) as never)
      const slow = reachesThisMacsServer('http://slow-answer.test/')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await slow).toBe(true)
      void reachesThisMacsServer('http://slow-answer.test/')
      expect(lookup).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves out pages that are not served over the network', async () => {
    for (const url of ['about:blank', 'data:text/html,hi', 'file:///etc/hosts', 'not a url'])
      expect(await reachesThisMacsServer(url), url).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { realFilesThere } from '../../src/main/realFiles'

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

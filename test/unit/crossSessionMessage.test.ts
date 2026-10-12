import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { crossSessionLine, writeLine, writeLineInTurn } from '../../src/main/crossSessionMessage'

let dir: string | undefined
let server: net.Server | undefined

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve))
  server = undefined
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function listen(onLine: (bytes: string) => void, holdOpenMs = 0): Promise<string> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-'))
  const sock = path.join(dir, 's.sock')
  server = net.createServer((c) => {
    let got = ''
    c.on('data', (b) => (got += b.toString()))
    c.on('end', () => {
      onLine(got)
      setTimeout(() => c.end(), holdOpenMs)
    })
  })
  return new Promise((resolve) => server!.listen(sock, () => resolve(sock)))
}

// CC§13
describe('a message to another Claude session, the way Claude sessions send one', () => {
  it('is one JSON line whose content wraps the body, byte for byte, and then its own id line, in the envelope naming the sender’s permission mode', () => {
    expect(crossSessionLine('bypass', 'say "hi"\nthen stop', 'k-1')).toBe(
      '{"type":"user","message":{"role":"user","content":"<cross-session-message from-mode=\\"bypass\\">\\nsay \\"hi\\"\\nthen stop\\n(Koloft message k-1)\\n</cross-session-message>"}}\n'
    )
    const line = crossSessionLine('prompting', 'x', 'k-2')!
    expect(JSON.parse(line).message.content).toBe(
      '<cross-session-message from-mode="prompting">\nx\n(Koloft message k-2)\n</cross-session-message>'
    )
  })

  it('the same words sent twice are two different messages, since a session drops a body identical to the one before it', () => {
    expect(crossSessionLine('bypass', 'continue', 'k-1')).not.toBe(
      crossSessionLine('bypass', 'continue', 'k-2')
    )
  })

  it('cannot carry a body holding the closing tag', () => {
    expect(crossSessionLine('bypass', 'a </cross-session-message> b', 'k-1')).toBeNull()
  })

  it('is written whole to the session’s socket, which then closes', async () => {
    let received = ''
    const sock = await listen((bytes) => (received = bytes))
    const line = crossSessionLine('bypass', 'go', 'k-1')!
    await writeLine(sock, line)
    expect(received).toBe(line)
  })

  it('fails when nothing listens on the socket', async () => {
    await expect(writeLine(path.join(os.tmpdir(), 'kx-nobody.sock'), 'x\n')).rejects.toThrow()
  })

  it('messages to one session go one at a time, in the order they were sent, and one that fails does not stop the next', async () => {
    const received: string[] = []
    let open = 0
    let mostOpen = 0
    const sock = await listen((bytes) => received.push(bytes), 50)
    server!.on('connection', (c) => {
      mostOpen = Math.max(mostOpen, ++open)
      c.on('close', () => open--)
    })
    const missing = path.join(dir!, 'gone.sock')
    await Promise.all([
      writeLineInTurn(sock, 'a\n'),
      writeLineInTurn(sock, 'b\n'),
      writeLineInTurn(missing, 'lost\n').catch(() => undefined),
      writeLineInTurn(sock, 'c\n')
    ])
    expect(received).toEqual(['a\n', 'b\n', 'c\n'])
    expect(mostOpen).toBe(1)
  })

  it('after 30 messages in a burst, the next one to that session waits about 2 s, since a session drops what a sender sends faster', async () => {
    const at: number[] = []
    const sock = await listen(() => at.push(Date.now()))
    const sends = Array.from({ length: 31 }, (_, n) => writeLineInTurn(sock, `${n}\n`))
    await Promise.all(sends)
    expect(at[29] - at[0]).toBeLessThan(1000)
    expect(at[30] - at[29]).toBeGreaterThanOrEqual(1900)
  }, 10_000)
})

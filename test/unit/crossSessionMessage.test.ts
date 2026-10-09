import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { crossSessionLine, writeLine } from '../../src/main/crossSessionMessage'

let dir: string | undefined
let server: net.Server | undefined

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve))
  server = undefined
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function listen(onLine: (bytes: string) => void): Promise<string> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-'))
  const sock = path.join(dir, 's.sock')
  server = net.createServer((c) => {
    let got = ''
    c.on('data', (b) => (got += b.toString()))
    c.on('end', () => {
      onLine(got)
      c.end()
    })
  })
  return new Promise((resolve) => server!.listen(sock, () => resolve(sock)))
}

// CC§13
describe('a message to another Claude session, the way Claude sessions send one', () => {
  it('is one JSON line whose content wraps the body, byte for byte, in the envelope naming the sender’s permission mode', () => {
    expect(crossSessionLine('bypass', 'say "hi"\nthen stop')).toBe(
      '{"type":"user","message":{"role":"user","content":"<cross-session-message from-mode=\\"bypass\\">\\nsay \\"hi\\"\\nthen stop\\n</cross-session-message>"}}\n'
    )
    const line = crossSessionLine('prompting', 'x')!
    expect(JSON.parse(line).message.content).toBe(
      '<cross-session-message from-mode="prompting">\nx\n</cross-session-message>'
    )
  })

  it('cannot carry a body holding the closing tag', () => {
    expect(crossSessionLine('bypass', 'a </cross-session-message> b')).toBeNull()
  })

  it('is written whole to the session’s socket, which then closes', async () => {
    let received = ''
    const sock = await listen((bytes) => (received = bytes))
    const line = crossSessionLine('bypass', 'go')!
    await writeLine(sock, line)
    expect(received).toBe(line)
  })

  it('fails when nothing listens on the socket', async () => {
    await expect(writeLine(path.join(os.tmpdir(), 'kx-nobody.sock'), 'x\n')).rejects.toThrow()
  })
})

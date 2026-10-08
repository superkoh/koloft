import net from 'net'

export type ModeClass = 'bypass' | 'prompting'

const CLOSING_TAG = '</cross-session-message>'
const SOCKET_WRITE_TIMEOUT_MS = 3000

// CC§13
export function crossSessionLine(mode: ModeClass, body: string): string | null {
  if (body.includes(CLOSING_TAG)) return null
  const content = `<cross-session-message from-mode="${mode}">\n${body}\n${CLOSING_TAG}`
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

// CC§11 CC§13
export function writeLine(socketPath: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    socket.setTimeout(SOCKET_WRITE_TIMEOUT_MS, () =>
      socket.destroy(new Error('the session did not take the message in time.'))
    )
    socket.on('error', reject)
    socket.on('close', (hadError) => {
      if (!hadError) resolve()
    })
    socket.on('connect', () => socket.end(line))
    socket.resume()
  })
}

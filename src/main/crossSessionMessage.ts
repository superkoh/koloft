import net from 'net'
import { setTimeout as sleep } from 'timers/promises'

export type ModeClass = 'bypass' | 'prompting'

const CLOSING_TAG = '</cross-session-message>'
export const FROM_A_SESSION = '(From the session '
export const FROM_KOLOFT = '(From Koloft:) '
export const A_HELPER_HAS_IT_IN_OLDER_TRANSCRIPTS = '(From Koloft: the owner asked for something'
export const A_HELPER_HAS_IT = `${FROM_KOLOFT}The owner asked for something, and Koloft hands it to a helper of yours, which has the request and reports back to you. Nothing is needed from you now.`
const SOCKET_WRITE_TIMEOUT_MS = 3000
export const MESSAGE_SOCKET_SHOWS_WITHIN_MS = 10_000
// CC§13
const MESSAGES_A_SENDER_MAY_BURST = 30
const MS_UNTIL_A_SENDER_MAY_SEND_ONE_MORE = 2000

// CC§13
export function crossSessionLine(mode: ModeClass, body: string, id: string): string | null {
  if (body.includes(CLOSING_TAG)) return null
  const content = `<cross-session-message from-mode="${mode}">\n${body}\n(Koloft message ${id})\n${CLOSING_TAG}`
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

interface Outbox {
  last: Promise<void>
  allowance: number
  at: number
}

const outboxes = new Map<string, Outbox>()

async function takeOneFromTheAllowance(box: Outbox): Promise<void> {
  const now = Date.now()
  box.allowance = Math.min(
    MESSAGES_A_SENDER_MAY_BURST,
    box.allowance + (now - box.at) / MS_UNTIL_A_SENDER_MAY_SEND_ONE_MORE
  )
  box.at = now
  if (box.allowance < 1) {
    await sleep((1 - box.allowance) * MS_UNTIL_A_SENDER_MAY_SEND_ONE_MORE)
    box.allowance = 1
    box.at = Date.now()
  }
  box.allowance -= 1
}

// CC§13
export function writeLineInTurn(
  receiver: string,
  line: string,
  write: (line: string) => Promise<void> = (l) => writeLine(receiver, l)
): Promise<void> {
  const box = outboxes.get(receiver) ?? {
    last: Promise.resolve(),
    allowance: MESSAGES_A_SENDER_MAY_BURST,
    at: Date.now()
  }
  outboxes.set(receiver, box)
  const mine = box.last.then(async () => {
    await takeOneFromTheAllowance(box)
    await write(line)
  })
  box.last = mine.catch(() => undefined)
  return mine
}

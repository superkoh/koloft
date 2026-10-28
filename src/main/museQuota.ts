import * as pty from 'node-pty'
import { Terminal } from '@xterm/headless'
import type { CodexLimits, CodexLimitWindow } from '@shared/types'
import { museShowsItsInputBox } from './museSessions'
import { typeKeys } from './typeKeys'
import type { PtyManager } from './ptyManager'

// MUSE§13
const QUOTA_ARGS = ['--no-session-log', '--trust-workspace']
// MUSE§13
const CURRENT_WINDOW_MINUTES = 5 * 60
const WEEK_MINUTES = 7 * 24 * 60
const COLS = 120
const ROWS = 40
const QUOTA_READ_DEADLINE_MS = 20_000
const SCREEN_POLL_MS = 200
// MUSE§13
const RETYPE_AFTER_MS = 1500
const DAY_MS = 24 * 60 * 60_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// MUSE§13
const WINDOW_LINE = /\b(Current|Weekly)\s+(\d+)% used · Resets (.+?)\s*│?\s*$/
const RESET_TEXT = /^(?:([A-Z][a-z]{2}) (\d{1,2}) )?at (\d{1,2}):(\d{2}) ([AP]M)$/

function resetsAtFrom(text: string, now: Date): number {
  const m = RESET_TEXT.exec(text.trim())
  if (!m) return 0
  const [, month, day, hour, minute, half] = m
  const at = new Date(now)
  if (month) at.setMonth(MONTHS.indexOf(month), Number(day))
  at.setHours((Number(hour) % 12) + (half === 'PM' ? 12 : 0), Number(minute), 0, 0)
  if (!month && at <= now) at.setDate(at.getDate() + 1)
  if (month && at.getTime() < now.getTime() - DAY_MS) at.setFullYear(at.getFullYear() + 1)
  return Math.floor(at.getTime() / 1000)
}

// MUSE§13
export function museQuotaFrom(lines: string[], now: Date): CodexLimits | undefined {
  const windows: CodexLimitWindow[] = []
  for (const line of lines) {
    const m = WINDOW_LINE.exec(line)
    if (!m) continue
    windows.push({
      minutes: m[1] === 'Weekly' ? WEEK_MINUTES : CURRENT_WINDOW_MINUTES,
      used: Number(m[2]) / 100,
      resetsAt: resetsAtFrom(m[3], now)
    })
  }
  return windows.length
    ? { windows: windows.sort((a, b) => a.minutes - b.minutes), at: now.getTime() }
    : undefined
}

function screenOf(term: Terminal): string[] {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++)
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  return lines
}

// MUSE§13
export function readMuseQuota(
  binary: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  ptys: Pick<PtyManager, 'track' | 'hangUp'>
): Promise<CodexLimits | undefined> {
  return new Promise((resolve) => {
    const term = new Terminal({ cols: COLS, rows: ROWS })
    const proc = pty.spawn(binary, QUOTA_ARGS, {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd,
      env
    })
    ptys.track(proc)
    let typedAt = 0
    let settled = false
    const finish = (limits: CodexLimits | undefined): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      ptys.hangUp(proc)
      term.dispose()
      resolve(limits)
    }
    proc.onData((data) => term.write(data))
    term.onData((reply) => proc.write(reply))
    proc.onExit(() => finish(undefined))
    const poll = setInterval(() => {
      const lines = screenOf(term)
      const limits = museQuotaFrom(lines, new Date())
      if (limits) return finish(limits)
      if (Date.now() - typedAt > RETYPE_AFTER_MS && museShowsItsInputBox(lines)) {
        typedAt = Date.now()
        void typeKeys((keys) => !settled && proc.write(keys), ['/usage', '\r'])
      }
    }, SCREEN_POLL_MS)
    const deadline = setTimeout(() => finish(undefined), QUOTA_READ_DEADLINE_MS)
  })
}

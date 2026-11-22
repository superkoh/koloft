import crypto from 'crypto'

// ADR-0052 CODEX§38 AGY§34 PLATFORM§74
export const TAB_PASS_ENV = 'KOLOFT_TAB_PASS'

const seedOfThisRun = crypto.randomBytes(32)
const keylessTabs = new Set<string>()

export function passOf(tabId: string): string {
  return crypto.createHmac('sha256', seedOfThisRun).update(tabId).digest('hex')
}

export function holdsPass(tabId: string, pass: unknown): boolean {
  if (typeof pass !== 'string') return false
  const want = Buffer.from(passOf(tabId))
  const got = Buffer.from(pass)
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

export function markStartedBeforeTabPasses(tabId: string, started: boolean): void {
  if (started) keylessTabs.add(tabId)
  else keylessTabs.delete(tabId)
}

export function isStartedBeforeTabPasses(tabId: string): boolean {
  return keylessTabs.has(tabId)
}

import type { PrChecks } from '@shared/types'

export type ChecksDot = 'pass' | 'fail' | 'pending'

function count(c: PrChecks | null, bucket: string): number {
  return c?.state === 'ok' ? c.checks.filter((x) => x.bucket === bucket).length : 0
}

export function failingChecks(c: PrChecks | null): number {
  return count(c, 'fail')
}

export function checksDot(c: PrChecks | null): ChecksDot | null {
  if (count(c, 'fail') > 0) return 'fail'
  if (count(c, 'pending') > 0) return 'pending'
  if (count(c, 'pass') > 0) return 'pass'
  return null
}

const NOT_READ: Record<Exclude<PrChecks['state'], 'ok'>, string | null> = {
  'no-gh': 'Checks · install gh',
  'signed-out': 'Checks · run gh auth login',
  'no-pr': null,
  failed: 'Checks · could not reach GitHub'
}

export function checksLine(c: PrChecks | null): string | null {
  if (!c) return 'Checks · checking…'
  if (c.state !== 'ok') return NOT_READ[c.state]
  const total = c.checks.length
  if (total === 0) return 'Checks · none'
  const failing = count(c, 'fail')
  if (failing > 0) return `Checks · ${failing} failing of ${total}`
  const running = count(c, 'pending')
  if (running > 0) return `Checks · ${running} running of ${total}`
  return `Checks · ${count(c, 'pass')} passed of ${total}`
}

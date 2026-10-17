import { describe, expect, it, vi } from 'vitest'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

const { museQuotaFrom } = await import('../../src/main/museQuota')

// MUSE§13
const BOX = [
  '┌──────────────────────────────────────────────────────┐',
  '│  Session usage                                       │',
  '│    Turns         0                                   │',
  '│  Subscription · Muse Code High Usage                 │',
  '│    Current        10% used · Resets at 4:11 AM       │',
  '│    Weekly         3% used · Resets Oct 18 at 5:00 PM │',
  '│    as of 1:14 AM                                     │',
  '└──────────────────────────────────────────────────────┘'
]

const at = (s: string): number => Math.floor(new Date(s).getTime() / 1000)

describe('reading a Muse account’s quota from its /usage box', () => {
  it('takes the current window as 5 hours and the weekly one as 7 days, each with its reset in local time', () => {
    const now = new Date(2026, 9, 17, 1, 14)
    expect(museQuotaFrom(BOX, now)).toEqual({
      windows: [
        { minutes: 300, used: 0.1, resetsAt: at('2026-10-17T04:11:00') },
        { minutes: 10080, used: 0.03, resetsAt: at('2026-10-18T17:00:00') }
      ],
      at: now.getTime()
    })
  })

  it('moves a reset time already past today to tomorrow, and a December reset seen in January to its own year', () => {
    const lateNight = new Date(2026, 9, 17, 23, 30)
    expect(museQuotaFrom(BOX, lateNight)!.windows[0].resetsAt).toBe(at('2026-10-18T04:11:00'))
    const box = [BOX[0], '│    Weekly         3% used · Resets Jan 2 at 9:00 AM │']
    expect(museQuotaFrom(box, new Date(2026, 11, 30, 12))!.windows[0].resetsAt).toBe(
      at('2027-01-02T09:00:00')
    )
  })

  it('finds nothing in a box without a subscription, as an API-key account shows', () => {
    expect(museQuotaFrom(BOX.slice(0, 3), new Date())).toBeUndefined()
  })
})

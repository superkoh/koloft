import { describe, expect, it } from 'vitest'
import {
  GAP_AFTER_A_LAUNCH_MS,
  GAP_BETWEEN_LAUNCHES_ON_A_ROOMY_MACHINE_MS,
  LaunchQueue
} from '../../src/main/launchQueue'

function setup(holding = false) {
  let now = 0
  const room = { holding, busy: holding }
  const started: string[] = []
  const q = new LaunchQueue({ room, now: () => now, changed: () => {} })
  const launch = (tabId: string, start?: () => Promise<string | null>) =>
    q.launch(
      { tabId, kind: 'claude', cwd: '/w', title: tabId },
      start ??
        (async () => {
          started.push(tabId)
          return tabId
        })
    )
  return { q, room, started, launch, tick: (ms: number) => (now += ms) }
}

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('a background launch waits its turn', () => {
  it('starts at once when the machine is roomy and nothing waits', async () => {
    const { started, launch } = setup()
    const r = launch('a')
    expect(r.queued).toBe(false)
    expect(await r.started).toBe('a')
    expect(await r.outcome).toBe('started')
    expect(started).toEqual(['a'])
  })

  it('a burst on a roomy machine is spaced out, since load shows a burst only after it has started', async () => {
    const { q, started, launch, tick } = setup()
    launch('a')
    const b = launch('b')
    expect(b.queued).toBe(true)
    await settled()
    expect(started).toEqual(['a'])
    tick(GAP_BETWEEN_LAUNCHES_ON_A_ROOMY_MACHINE_MS)
    q.pump()
    await settled()
    expect(started).toEqual(['a', 'b'])
  })

  it('queues while background work holds the machine, and keeps the tab id it will get', () => {
    const { q, started, launch } = setup(true)
    const r = launch('a')
    expect(r.queued).toBe(true)
    expect(r.tabId).toBe('a')
    expect(q.list().map((e) => e.tabId)).toEqual(['a'])
    q.pump()
    expect(started).toEqual([])
  })

  it('once the hold ends, starts one at a time, a launch gap apart, first come first served', async () => {
    const { q, room, started, launch, tick } = setup(true)
    launch('a')
    launch('b')
    room.holding = false
    q.pump()
    q.pump()
    await settled()
    expect(started).toEqual(['a'])
    tick(GAP_AFTER_A_LAUNCH_MS)
    q.pump()
    await settled()
    expect(started).toEqual(['a', 'b'])
  })

  it('the owner can start a queued launch now, ahead of the rest', async () => {
    const { q, started, launch } = setup(true)
    launch('a')
    const b = launch('b')
    expect(q.startNow('b')).toBe(true)
    expect(await b.started).toBe('b')
    expect(started).toEqual(['b'])
    expect(q.list().map((e) => e.tabId)).toEqual(['a'])
  })

  it('a closed queued launch never starts, and its caller hears it was dropped, not that it failed', async () => {
    const { q, started, launch } = setup(true)
    const a = launch('a')
    expect(q.drop('a')).toBe(true)
    expect(await a.started).toBeNull()
    expect(await a.outcome).toBe('dropped')
    expect(started).toEqual([])
  })

  it('a launch that throws reads as failed, never as an unhandled rejection', async () => {
    const { launch } = setup()
    const r = launch('a', async () => {
      throw new Error('no account')
    })
    expect(await r.started).toBeNull()
    expect(await r.outcome).toBe('failed')
  })

  it('keeps messages sent to a queued launch, and to one still starting, to hand over once it starts', async () => {
    const { q, launch } = setup(true)
    let finish!: (id: string) => void
    launch('a', () => new Promise((resolve) => (finish = resolve)))
    const one = async (): Promise<string> => 'one'
    const two = async (): Promise<string> => 'two'
    expect(q.hold('a', one)).toBe(true)
    q.startNow('a')
    expect(q.hold('a', two)).toBe(true)
    expect(q.hold('not-queued', one)).toBe(false)
    finish('a')
    await settled()
    expect(q.hold('a', one)).toBe(false)
    expect(q.takeHeld('a')).toEqual([one, two])
  })
})

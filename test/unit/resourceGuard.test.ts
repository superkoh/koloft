import { describe, expect, it, vi } from 'vitest'
import type { MachineState } from '../../src/shared/types'
import { ownerTyped, ResourceGuard } from '../../src/main/resourceGuard'
import type { TaggedProcess } from '../../src/main/machineTrees'

const KOLOFT = 1
const STARTED = 'Thu Nov 12 00:51:03 2026'

const proc = (
  pid: number,
  ppid: number,
  tab: string | undefined,
  opts: Partial<TaggedProcess> = {}
): TaggedProcess => ({
  pid,
  ppid,
  tab,
  rssBytes: 100 * 2 ** 20,
  started: STARTED,
  agent: false,
  ...opts
})

const TWO_TABS_EACH_RUNNING_A_TOOL = (): TaggedProcess[] => [
  proc(10, KOLOFT, 'away'),
  proc(11, 10, undefined),
  proc(20, KOLOFT, 'watched'),
  proc(21, 20, undefined)
]

function setup(rows: TaggedProcess[], tabs = ['away', 'watched']) {
  const world = { pressure: 1, rows, tabs, lookedAt: 'watched' as string | null }
  const ways: string[] = []
  const lines: string[] = []
  const states: MachineState[] = []
  const guard = new ResourceGuard({
    koloftPid: KOLOFT,
    read: async () => ({ pressure: world.pressure }),
    log: (line) => lines.push(line),
    agentTabsOnThisMac: () => world.tabs,
    lookedAt: () => world.lookedAt,
    changed: (s) => states.push(s),
    readTrees: async () => world.rows,
    giveWay: async (pid, on) => {
      ways.push(`${on ? '-b' : '-B'} ${pid}`)
    }
  })
  const critical = async (): Promise<void> => {
    world.pressure = 4
    await guard.tick()
    await guard.tick()
  }
  return { guard, ways, lines, world, states, critical }
}

describe('giving way while memory stays critical', () => {
  it('slows only the tools of the tabs nobody looks at, never an agent and never the tab on screen', async () => {
    const { guard, ways, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    expect(ways).toEqual(['-b 11'])
    expect(guard.state().slowed).toEqual(['away'])
  })

  it('does nothing at a single critical reading, nor at warning however long it lasts', async () => {
    const { guard, ways, world, states } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    world.pressure = 4
    await guard.tick()
    world.pressure = 2
    for (let i = 0; i < 20; i++) await guard.tick()
    expect(ways).toEqual([])
    expect(states.every((s) => !s.critical && !s.slowed.length)).toBe(true)
  })

  it('reads the process table only while memory stays critical', async () => {
    const { guard, world } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    let reads = 0
    Object.defineProperty(world, 'rows', {
      get: () => (reads++, TWO_TABS_EACH_RUNNING_A_TOOL())
    })
    world.pressure = 2
    for (let i = 0; i < 5; i++) await guard.tick()
    expect(reads).toBe(0)
  })

  it('leaves alone a tab that is not a bound agent tab on this Mac: a remote one, a Workbench shell', async () => {
    const { ways, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL(), ['watched'])
    await critical()
    expect(ways).toEqual([])
  })

  it('a tool that starts later is slowed on the next look, and one already slowed is not slowed twice', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    world.rows = [...world.rows, proc(12, 11, undefined)]
    await guard.tick()
    expect(ways).toEqual(['-b 11', '-b 12'])
  })

  it('a tab with no tool running carries no mark', async () => {
    const { guard, critical } = setup([proc(10, KOLOFT, 'away'), proc(20, KOLOFT, 'watched')])
    await critical()
    expect(guard.state()).toMatchObject({ critical: true, slowed: [] })
  })

  it('shows each tab’s memory only while memory stays critical', async () => {
    const { guard, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    expect(guard.state().memory).toEqual({})
    await critical()
    expect(guard.state().memory.away).toBe(200 * 2 ** 20)
    world.pressure = 2
    await guard.tick()
    expect(guard.state().memory).toEqual({})
  })
})

describe('getting a slowed tab back to full speed', () => {
  it('the owner opening the row lifts it at once, the tools that started since the last look too', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    world.rows = [...world.rows, proc(13, 11, undefined)]
    ways.length = 0
    expect(await guard.free('away')).toBe(true)
    expect(ways.sort()).toEqual(['-B 11', '-B 13'])
    expect(guard.state().slowed).toEqual([])
  })

  it('a tab the owner opened or typed into stays at full speed for the rest of this critical spell', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    await guard.free('away')
    ways.length = 0
    world.rows = [...world.rows, proc(14, 10, undefined)]
    for (let i = 0; i < 3; i++) await guard.tick()
    expect(ways).toEqual([])
  })

  it('a tab that was only on screen is slowed once the owner moves to another', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    await guard.free('away')
    world.lookedAt = 'away'
    ways.length = 0
    await guard.tick()
    expect(ways).toEqual(['-b 21'])
  })

  it('a slowed tab that comes on screen without a click is lifted at the next look', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    world.lookedAt = 'away'
    ways.length = 0
    await guard.tick()
    expect(ways).toContain('-B 11')
    expect(guard.state().slowed).toEqual(['watched'])
  })

  it('the first reading below critical lifts everything, and the next critical spell starts afresh', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    await guard.free('away')
    world.lookedAt = 'away'
    await guard.tick()
    ways.length = 0
    world.pressure = 2
    await guard.tick()
    expect(ways).toEqual(['-B 21'])
    expect(guard.state()).toEqual({ critical: false, slowed: [], memory: {} })
    world.lookedAt = 'watched'
    ways.length = 0
    await critical()
    expect(ways).toEqual(['-b 11'])
  })

  it('lifts a slowed tool that left its tab’s tree, but not another program that took its process id', async () => {
    const { guard, ways, world, critical } = setup([
      ...TWO_TABS_EACH_RUNNING_A_TOOL(),
      proc(15, 11, undefined)
    ])
    await critical()
    world.rows = [
      proc(10, KOLOFT, 'away'),
      proc(11, 999, undefined),
      proc(15, 998, undefined, { started: 'Thu Nov 12 01:00:00 2026' }),
      proc(20, KOLOFT, 'watched'),
      proc(21, 20, undefined)
    ]
    ways.length = 0
    await guard.free('away')
    expect(ways).toEqual(['-B 11'])
  })

  it('lifts a claude -p that a slowed tool started, which was born slowed though Koloft never slowed it itself', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    world.rows = [...world.rows, proc(16, 11, undefined, { agent: true })]
    await guard.tick()
    expect(ways).toEqual(['-b 11'])
    ways.length = 0
    await guard.free('away')
    expect(ways.sort()).toEqual(['-B 11', '-B 16'])
  })

  it('leaves alone a tool of the tab that it never slowed: one the agent started after the last look', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    world.rows = [...world.rows, proc(17, 10, undefined)]
    ways.length = 0
    await guard.free('away')
    expect(ways).toEqual(['-B 11'])
  })

  it('a slowed tab that comes on screen is lifted at once, without waiting for the next look', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    world.lookedAt = 'away'
    ways.length = 0
    guard.lookedAtChanged()
    await vi.waitFor(() => expect(ways).toContain('-B 11'))
  })

  it('a process table that cannot be read is logged, and the next look goes on as usual', async () => {
    const { guard, ways, world, lines } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    world.pressure = 4
    await guard.tick()
    const rows = world.rows
    Object.defineProperty(world, 'rows', {
      configurable: true,
      get: () => {
        throw new Error('ps failed')
      }
    })
    await guard.tick()
    expect(lines.join('\n')).toContain('could not look at the machine: Error: ps failed')
    Object.defineProperty(world, 'rows', { configurable: true, value: rows })
    await guard.tick()
    expect(ways).toEqual(['-b 11'])
  })

  it('a slowed shell that has since become an agent program is lifted at the next look and left alone after', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    world.rows = world.rows.map((p) => (p.pid === 11 ? { ...p, agent: true } : p))
    ways.length = 0
    await guard.tick()
    await guard.tick()
    expect(ways).toEqual(['-B 11'])
    expect(guard.state().slowed).toEqual([])
  })

  it('when the process table comes back empty as memory calms, the slowed tools are remembered and lifted at the next look', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    const rows = world.rows
    world.rows = []
    world.pressure = 2
    ways.length = 0
    await guard.tick()
    expect(ways).toEqual([])
    expect(guard.state().slowed).toEqual(['away'])
    world.rows = rows
    await guard.tick()
    expect(ways).toEqual(['-B 11'])
    expect(guard.state().slowed).toEqual([])
  })

  it('opening a row does nothing while memory is not critical', async () => {
    const { guard, ways } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    expect(await guard.free('away')).toBe(false)
    expect(ways).toEqual([])
  })

  it('a tab that closes has its surviving tools lifted', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    world.tabs = ['watched']
    world.rows = [proc(11, 999, undefined), proc(20, KOLOFT, 'watched'), proc(21, 20, undefined)]
    ways.length = 0
    guard.forget('away')
    await guard.tick()
    expect(ways).toEqual(['-B 11'])
    expect(guard.state().slowed).toEqual([])
  })

  it('quitting lifts every tool it slowed and what those started since, and slows nothing afterwards', async () => {
    const { guard, ways, world, critical } = setup(TWO_TABS_EACH_RUNNING_A_TOOL())
    await critical()
    world.rows = [...world.rows, proc(18, 11, undefined)]
    ways.length = 0
    guard.liftAllBeforeQuitting()
    expect(ways).toEqual(['-B 11'])
    await vi.waitFor(() => expect(ways).toContain('-B 18'))
    world.rows = [...world.rows, proc(19, 10, undefined)]
    await guard.tick()
    expect(ways.filter((w) => w.startsWith('-b'))).toEqual([])
  })
})

describe('what counts as the owner typing into a session', () => {
  it('a key the owner types counts; the terminal’s own replies, mouse and focus reports do not', () => {
    expect(ownerTyped('a')).toBe(true)
    expect(ownerTyped('\r')).toBe(true)
    expect(ownerTyped('\x1b[I')).toBe(false)
    expect(ownerTyped('\x1b[12;40R')).toBe(false)
    expect(ownerTyped('\x1b[<0;10;5M')).toBe(false)
    expect(ownerTyped('\x1b[M !!')).toBe(false)
    expect(ownerTyped('\x1bP1$r0m\x1b\\')).toBe(false)
    expect(ownerTyped('\x1b]11;rgb:0000/0000/0000\x07')).toBe(false)
  })
})

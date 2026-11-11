import { describe, it, expect } from 'vitest'
import { TerminalDataSinks } from '../../src/preload/terminalDataSinks'

describe('terminal output reaching a tab before its screen listens', () => {
  it('an agent that printed and died before its tab drew a screen still shows what it printed, in order, ahead of later output', () => {
    const sinks = new TerminalDataSinks()
    sinks.deliver('t1', 'Muse fixture ')
    sinks.deliver('t1', 'startup failure\r\n')
    const seen: string[] = []
    sinks.listen('t1', (d) => seen.push(d))
    sinks.deliver('t1', 'later')
    expect(seen).toEqual(['Muse fixture ', 'startup failure\r\n', 'later'])
  })

  it('output for a tab whose screen has already gone is dropped, not kept for a screen that will not come', () => {
    const sinks = new TerminalDataSinks()
    const first: string[] = []
    const stop = sinks.listen('t1', (d) => first.push(d))
    stop()
    sinks.deliver('t1', 'after the tab closed')
    const second: string[] = []
    sinks.listen('t1', (d) => second.push(d))
    expect([...first, ...second]).toEqual([])
  })
})

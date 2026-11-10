import { describe, it, expect, beforeAll } from 'vitest'
import type { Terminal } from '@xterm/xterm'

type Screens = typeof import('../../src/renderer/src/terminalScreens')
let screens: Screens

function fakeTerminal(): { term: Terminal; written: string[] } {
  const written: string[] = []
  const term = {
    rows: 3,
    write: (data: string, done?: () => void) => {
      written.push(data)
      done?.()
    },
    buffer: {
      active: {
        baseY: 0,
        get length() {
          return written.join('').split('\n').length
        },
        getLine: (y: number) => {
          const line = written.join('').split('\n')[y]
          return line === undefined ? undefined : { translateToString: () => line }
        }
      }
    }
  } as unknown as Terminal
  return { term, written }
}

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { terminal: { onScreenRequest: () => () => {}, answerScreen: () => {} } }
  }
  screens = await import('../../src/renderer/src/terminalScreens')
})

describe('the last screen of an agent that ended before its tab drew one', () => {
  it('is read, and the notice written, once the screen arrives with what the agent printed', async () => {
    const lines = screens.lastLinesOnceWritten('t-late', 5)
    const { term, written } = fakeTerminal()
    screens.registerScreen('t-late', term)
    term.write('Muse fixture startup failure')
    expect(await lines).toEqual(['Muse fixture startup failure'])
    screens.writeOnScreen('t-late', '\r\n[Koloft] notice')
    expect(written.at(-1)).toBe('\r\n[Koloft] notice')
  })
})

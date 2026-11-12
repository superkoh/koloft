import { describe, it, expect } from 'vitest'
import { SleepingTabs, type LiveTab } from '../../src/main/sleepingTabs'
import type { OpenTab } from '../../src/main/openTabs'

const CLICK = '\x1b[<0;10;5M'
const FOCUS_IN = '\x1b[I'
const PASTE = '\x1b[200~pasted\rtext\x1b[201~'

function tab(sessionId: string): OpenTab {
  return { sessionId, kind: 'claude', title: sessionId, cwd: '/w' }
}

function live(tabId: string, sessionId: string): LiveTab {
  return { tabId, sessionId, alive: true }
}

function makeSleepers(): {
  sleepers: SleepingTabs
  writes: { tabId: string; data: string }[]
  typed: { tabId: string; keys: string[] }[]
  becomeReady(tabId: string, ready?: boolean): Promise<void>
} {
  const writes: { tabId: string; data: string }[] = []
  const typed: { tabId: string; keys: string[] }[] = []
  const waiting = new Map<string, (ready: boolean) => void>()
  const sleepers = new SleepingTabs({
    write: (tabId, data) => writes.push({ tabId, data }),
    ready: (tabId) => new Promise((resolve) => waiting.set(tabId, resolve)),
    type: (tabId, keys) => typed.push({ tabId, keys })
  })
  const becomeReady = async (tabId: string, ready = true): Promise<void> => {
    waiting.get(tabId)?.(ready)
    await new Promise((r) => setImmediate(r))
  }
  return { sleepers, writes, typed, becomeReady }
}

describe('SleepingTabs — typing into a tab that is asleep', () => {
  it('a tab that is not asleep gets every byte as typed, mouse and focus reports included', () => {
    const { sleepers, writes } = makeSleepers()
    sleepers.write('t', `ls${CLICK}${FOCUS_IN}\r`)
    expect(writes).toEqual([{ tabId: 't', data: `ls${CLICK}${FOCUS_IN}\r` }])
  })

  it('what is typed into a sleeping tab waits, and is typed into the tab that wakes it once that tab is ready', async () => {
    const { sleepers, writes, typed, becomeReady } = makeSleepers()
    sleepers.add('old', tab('s1'))
    sleepers.write('old', `hello${CLICK}`)
    sleepers.write('old', `${FOCUS_IN}\r`)
    expect(writes).toEqual([])
    sleepers.settle([live('new', 's1')])
    sleepers.write('old', ' more')
    expect(typed).toEqual([])
    await becomeReady('new')
    expect(typed).toEqual([{ tabId: 'new', keys: ['hello', '\r', ' more'] }])
    expect(writes).toEqual([])
  })

  it('a paste and each Enter are handed over as whole keys, the text between them in typing-sized pieces', async () => {
    const { sleepers, typed, becomeReady } = makeSleepers()
    sleepers.add('old', tab('s1'))
    const long = 'a'.repeat(300)
    sleepers.write('old', `${long}${PASTE}x\r`)
    sleepers.settle([live('new', 's1')])
    await becomeReady('new')
    const keys = typed[0].keys
    expect(keys.join('')).toBe(`${long}${PASTE}x\r`)
    expect(keys).toContain(PASTE)
    expect(keys.at(-1)).toBe('\r')
    expect(keys.filter((k) => k.startsWith('a')).length).toBeGreaterThan(1)
  })

  it('typing held for a tab whose wake never gets ready is dropped, never typed late', async () => {
    const { sleepers, typed, becomeReady } = makeSleepers()
    sleepers.add('old', tab('s1'))
    sleepers.write('old', 'lost\r')
    sleepers.settle([live('new', 's1')])
    await becomeReady('new', false)
    expect(typed).toEqual([])
  })

  it('a paste into a sleeping tab waits with the typing as one bracketed paste that starts on its own lines, followed by what was typed after it', async () => {
    const { sleepers, typed, becomeReady } = makeSleepers()
    sleepers.add('old', tab('s1'))
    expect(sleepers.heldPaste('old', 'pasted\rtext', '\r')).toBe(true)
    sleepers.settle([live('new', 's1')])
    await becomeReady('new')
    expect(typed).toEqual([{ tabId: 'new', keys: ['\x1b[200~\n\npasted\rtext\x1b[201~', '\r'] }])
  })

  it('a paste that arrives while the tab is waking is still shaped for its agent: the line feeds Antigravity drops from a paste are typed after it', async () => {
    const { sleepers, typed, becomeReady } = makeSleepers()
    sleepers.add('old', { ...tab('s1'), kind: 'agy' })
    sleepers.settle([live('new', 's1')])
    expect(sleepers.heldPaste('old', 'text\n')).toBe(true)
    await becomeReady('new')
    expect(typed[0].keys.join('')).toBe('\x1b[200~text\x1b[201~\n')
  })

  it('a paste into a tab that is not asleep is left for the tab itself', () => {
    const { sleepers, writes } = makeSleepers()
    expect(sleepers.heldPaste('t', 'text')).toBe(false)
    expect(writes).toEqual([])
  })

  it('a tab forgotten while asleep keeps nothing of what was typed into it', () => {
    const { sleepers, writes } = makeSleepers()
    sleepers.add('old', tab('s1'))
    sleepers.write('old', 'x')
    sleepers.forget('old')
    expect(sleepers.heldPaste('old', 'p')).toBe(false)
    sleepers.write('old', 'y')
    expect(writes).toEqual([{ tabId: 'old', data: 'y' }])
  })
})

describe('SleepingTabs — after the wake', () => {
  it('keys still sent to the old tab id reach the tab that woke it, without mouse or focus reports', async () => {
    const { sleepers, writes, becomeReady } = makeSleepers()
    sleepers.add('old', tab('s1'))
    sleepers.settle([live('new', 's1')])
    await becomeReady('new')
    sleepers.write('old', `y${CLICK}${FOCUS_IN}`)
    expect(writes).toEqual([{ tabId: 'new', data: 'y' }])
    expect(sleepers.liveTabOf('old')).toBe('new')
  })

  it('once the woken tab exits, the old tab id stops reaching it', async () => {
    const { sleepers, writes, becomeReady } = makeSleepers()
    sleepers.add('old', tab('s1'))
    sleepers.settle([live('new', 's1')])
    await becomeReady('new')
    sleepers.exited('new', 's1')
    sleepers.write('old', 'y')
    expect(writes).toEqual([{ tabId: 'old', data: 'y' }])
    expect(sleepers.liveTabOf('old')).toBe('old')
  })

  it('a sleeper wakes only when its session runs in another live tab', () => {
    const { sleepers } = makeSleepers()
    sleepers.add('a', tab('s1'))
    sleepers.add('b', tab('s2'))
    sleepers.add('c', tab('s3'))
    const woken = sleepers.settle([
      live('a', 's1'),
      { tabId: 'x', sessionId: 's2', alive: false },
      live('y', 's3')
    ])
    expect(woken).toEqual([{ oldId: 'c', newId: 'y' }])
    expect([...sleepers].map(([id]) => id)).toEqual(['a', 'b'])
  })

  it('when a tab that resumed a session exits, the other sleepers holding that session are the ones to forget', () => {
    const { sleepers } = makeSleepers()
    sleepers.add('a', tab('s1'))
    sleepers.add('b', tab('s1'))
    sleepers.add('c', tab('s2'))
    expect(sleepers.exited('a', 's1')).toEqual(['b'])
    expect(sleepers.exited('z', undefined)).toEqual([])
  })
})

describe('SleepingTabs — tabs restored asleep at launch', () => {
  it('each gets its own tab id, found again by its session, and holds what is typed into it', () => {
    const { sleepers, writes } = makeSleepers()
    const a = sleepers.addRestored(tab('s1'))
    const b = sleepers.addRestored(tab('s2'))
    expect(a).not.toBe(b)
    expect(sleepers.tabOf('s2')).toBe(b)
    sleepers.write(a, 'held')
    expect(writes).toEqual([])
  })
})

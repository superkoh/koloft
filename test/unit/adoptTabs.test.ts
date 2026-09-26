import { describe, it, expect, beforeEach } from 'vitest'
import type { AdoptableTab, SessionInfo } from '@shared/types'
import { useStore, consumeAdoptedNudge } from '../../src/renderer/src/store'

const adoptable = (over: Partial<AdoptableTab>): AdoptableTab => ({
  id: 'pty-x-1',
  kind: 'claude',
  cwd: '/repo',
  ...over
})

const live = (tabId: string, sessionId: string): SessionInfo => ({
  tabId,
  backendId: 'claude',
  host: 'local',
  sessionId,
  title: 'Live',
  cwd: '/repo',
  treeRoot: '/repo',
  files: [],
  alive: true,
  updatedAt: 0
})

beforeEach(() => {
  useStore.setState({ tabs: [], sessions: [], activeTabId: null, openFiles: {} })
})

describe('store: adoptTabs', () => {
  it('appends every adopted tab in inventory order without spawning-style activation', () => {
    useStore
      .getState()
      .adoptTabs([adoptable({ id: 'a1' }), adoptable({ id: 'a2' }), adoptable({ id: 'a3' })], null)
    const s = useStore.getState()
    expect(s.tabs.map((t) => t.id)).toEqual(['a1', 'a2', 'a3'])
    expect(s.activeTabId).toBeNull()
  })

  it('re-activates the remembered tab — not the last one appended', () => {
    useStore
      .getState()
      .adoptTabs([adoptable({ id: 'b1' }), adoptable({ id: 'b2' }), adoptable({ id: 'b3' })], 'b2')
    expect(useStore.getState().activeTabId).toBe('b2')
  })

  it('ignores a remembered tab that did not adopt (a dead pty, or a util shell)', () => {
    useStore.getState().adoptTabs([adoptable({ id: 'c1' })], 'gone-tab')
    expect(useStore.getState().activeTabId).toBeNull()
  })

  it('is a complete no-op on an empty inventory', () => {
    useStore.getState().adoptTabs([], 'anything')
    const s = useStore.getState()
    expect(s.tabs).toEqual([])
    expect(s.activeTabId).toBeNull()
  })

  it('builds a bound claude tab: session id, inventory title, alive', () => {
    useStore
      .getState()
      .adoptTabs([adoptable({ id: 'd1', sessionId: 'sess-d', title: 'Fix the bug' })], null)
    expect(useStore.getState().tabs[0]).toMatchObject({
      id: 'd1',
      kind: 'claude',
      sessionId: 'sess-d',
      title: 'Fix the bug',
      alive: true
    })
  })

  it('falls back to the stock titles when the inventory has none', () => {
    useStore
      .getState()
      .adoptTabs([adoptable({ id: 'e1' }), adoptable({ id: 'e2', kind: 'shell' })], null)
    const [claude, shell] = useStore.getState().tabs
    expect(claude.title).toBe('Claude')
    expect(shell.title).toBe('Terminal')
  })

  it('restores the resuming overlay for an unbound resume in flight', () => {
    useStore.getState().adoptTabs([adoptable({ id: 'f1', resumeSessionId: 'sess-f' })], null)
    expect(useStore.getState().tabs[0]).toMatchObject({
      id: 'f1',
      sessionId: 'sess-f',
      resuming: true
    })
  })

  it('seeds the revert gate: an adopted bound tab whose session ends flips to shell', () => {
    useStore.getState().adoptTabs([adoptable({ id: 'g1', sessionId: 'sess-g' })], null)
    useStore.getState().setSessions([])
    const t = useStore.getState().tabs.find((x) => x.id === 'g1')!
    expect(t.kind).toBe('shell')
    expect(t.sessionId).toBeUndefined()
  })

  it('does NOT arm the revert gate for a tab that never bound (launch window)', () => {
    useStore.getState().adoptTabs([adoptable({ id: 'i1' })], null)
    useStore.getState().setSessions([])
    expect(useStore.getState().tabs.find((x) => x.id === 'i1')!.kind).toBe('claude')
  })

  it('owes each adopted tab exactly one repaint nudge', () => {
    useStore.getState().adoptTabs([adoptable({ id: 'j1' })], null)
    expect(consumeAdoptedNudge('j1')).toBe(true)
    expect(consumeAdoptedNudge('j1')).toBe(false)
    expect(consumeAdoptedNudge('never-adopted')).toBe(false)
  })

  it('skips entries whose tab already exists — a re-run boot effect must not duplicate', () => {
    useStore.getState().adoptTabs([adoptable({ id: 'm1' }), adoptable({ id: 'm2' })], null)
    useStore.getState().adoptTabs([adoptable({ id: 'm1' }), adoptable({ id: 'm2' })], 'm1')
    const s = useStore.getState()
    expect(s.tabs.map((t) => t.id)).toEqual(['m1', 'm2'])
    expect(s.activeTabId).toBe('m1')
  })

  it('adopted tabs behave like ordinary tabs afterwards (bind clears resuming)', () => {
    useStore.getState().adoptTabs([adoptable({ id: 'k1', resumeSessionId: 'sess-k' })], null)
    useStore.getState().setSessions([live('k1', 'sess-k')])
    expect(useStore.getState().tabs.find((x) => x.id === 'k1')!.resuming).toBeFalsy()
  })
})

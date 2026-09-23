import { describe, it, expect } from 'vitest'
import { adoptableTabs, type PtySnapshot, type TrackedSnapshot } from '../../src/main/tabInventory'

const pty = (over: Partial<PtySnapshot>): PtySnapshot => ({
  id: 'pty-a-1',
  kind: 'claude',
  cwd: '/repo',
  alive: true,
  util: false,
  ...over
})

const bound = (over: Partial<TrackedSnapshot>): TrackedSnapshot => ({
  tabId: 'pty-a-1',
  sessionId: 'sess-1',
  title: 'Fix the bug',
  alive: true,
  ...over
})

describe('adoptableTabs: what a reloaded renderer adopts — every join rule pinned here, as the e2e reload spec sees only a missing tab', () => {
  it('joins a bound claude pty with its tracker decoration', () => {
    expect(adoptableTabs([pty({})], [bound({})])).toEqual([
      { id: 'pty-a-1', kind: 'claude', cwd: '/repo', sessionId: 'sess-1', title: 'Fix the bug' }
    ])
  })

  it('adopts a pre-bind launch pty bare — no session fields until the hook lands', () => {
    expect(adoptableTabs([pty({})], [])).toEqual([{ id: 'pty-a-1', kind: 'claude', cwd: '/repo' }])
  })

  it('carries the spawn-time resume intent for an unbound resume in flight', () => {
    expect(adoptableTabs([pty({ resumeSessionId: 'sess-9' })], [])).toEqual([
      { id: 'pty-a-1', kind: 'claude', cwd: '/repo', resumeSessionId: 'sess-9' }
    ])
  })

  it('excludes utility shells — a terminal tab dies with the reload', () => {
    expect(adoptableTabs([pty({ kind: 'shell', util: true })], [])).toEqual([])
  })

  it('keeps a plain non-util shell tab', () => {
    expect(adoptableTabs([pty({ kind: 'shell' })], [])).toEqual([
      { id: 'pty-a-1', kind: 'shell', cwd: '/repo' }
    ])
  })

  it('drops a dead pty — a frozen tab with an empty scrollback is worthless', () => {
    expect(adoptableTabs([pty({ alive: false })], [bound({})])).toEqual([])
  })

  it('emits nothing for a tracker entry whose pty is gone (pty map is the spine)', () => {
    expect(adoptableTabs([], [bound({})])).toEqual([])
  })

  it('adopts BOTH ptys of a dual-bound session (erases the force-close first-binding limit)', () => {
    const out = adoptableTabs(
      [pty({ id: 'pty-a-1' }), pty({ id: 'pty-a-2' })],
      [bound({ tabId: 'pty-a-1' }), bound({ tabId: 'pty-a-2' })]
    )
    expect(out.map((t) => t.sessionId)).toEqual(['sess-1', 'sess-1'])
  })

  it('ignores a dead tracker decoration — only a live binding decorates', () => {
    expect(adoptableTabs([pty({})], [bound({ alive: false })])).toEqual([
      { id: 'pty-a-1', kind: 'claude', cwd: '/repo' }
    ])
  })

  it('leaves title absent when the tracker has none yet (renderer default applies)', () => {
    expect(adoptableTabs([pty({})], [bound({ title: '' })])).toEqual([
      { id: 'pty-a-1', kind: 'claude', cwd: '/repo', sessionId: 'sess-1' }
    ])
  })

  it('preserves pty creation order', () => {
    const out = adoptableTabs(
      [pty({ id: 'pty-a-2' }), pty({ id: 'pty-a-1' }), pty({ id: 'pty-a-3' })],
      []
    )
    expect(out.map((t) => t.id)).toEqual(['pty-a-2', 'pty-a-1', 'pty-a-3'])
  })
})

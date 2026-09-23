import { describe, it, expect } from 'vitest'
import {
  actionView,
  splitActions,
  type ActionState
} from '../../src/renderer/src/components/extensionActions'

/** an action as the upstream state reports it, with no per-tab overrides */
function action(id: string, extra: Partial<ActionState> = {}): ActionState {
  return { id, tabs: {}, ...extra }
}

/**
 * D3's collapse rule (browser-extensions design §03, retired; pinned
 * by BB-C01/BB-C02):
 * up to four extensions are all on the row and there is no puzzle at all; past four the
 * row keeps three and the puzzle's menu lists EVERY extension, not just the hidden ones.
 */
describe('splitActions', () => {
  const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `probe-${i + 1}`)

  it('renders nothing and offers no overflow when no extension is installed', () => {
    expect(splitActions([])).toEqual({ shown: [], menu: null })
  })

  it('keeps every extension on the row up to the boundary of four', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(splitActions(names(n))).toEqual({ shown: names(n), menu: null })
    }
  })

  it('collapses to three icons plus a menu of ALL of them at five', () => {
    expect(splitActions(names(5))).toEqual({
      shown: ['probe-1', 'probe-2', 'probe-3'],
      menu: names(5)
    })
  })

  it('still shows exactly three past the boundary, with every extension in the menu', () => {
    expect(splitActions(names(9))).toEqual({
      shown: ['probe-1', 'probe-2', 'probe-3'],
      menu: names(9)
    })
  })

  it('preserves the order it was given', () => {
    const given = ['zeta', 'alpha', 'mid', 'omega', 'beta']
    expect(splitActions(given).shown).toEqual(['zeta', 'alpha', 'mid'])
    expect(splitActions(given).menu).toEqual(given)
  })
})

/**
 * What one button shows. `title` is the extension's own name (the lib defaults it to the
 * manifest name), and chrome.action.setBadgeText/setTitle may be scoped to ONE tab — the
 * row follows the tab the extension is looking at, i.e. the active one (D4).
 */
describe('actionView', () => {
  it('reads the name and the badge off the action itself', () => {
    expect(actionView(action('abc', { title: 'Koloft BB Probe', text: 'ok' }), 7)).toEqual({
      id: 'abc',
      name: 'Koloft BB Probe',
      badge: 'ok'
    })
  })

  it('shows no badge when the extension painted none', () => {
    expect(actionView(action('abc', { title: 'Koloft BB Probe' }), 7).badge).toBe('')
  })

  it('labels a title-less action with its extension id, never with an empty string', () => {
    expect(actionView(action('abc'), 7).name).toBe('abc')
    expect(actionView(action('abc', { title: '' }), 7).name).toBe('abc')
  })

  it("prefers the active tab's own badge and title over the extension-wide ones", () => {
    const scoped = action('abc', {
      title: 'Everywhere',
      text: 'ok',
      tabs: { '7': { title: 'This tab', text: '2' } }
    })
    expect(actionView(scoped, 7)).toEqual({ id: 'abc', name: 'This tab', badge: '2' })
  })

  it('ignores an override that belongs to another tab', () => {
    const scoped = action('abc', { title: 'Everywhere', text: 'ok', tabs: { '9': { text: '2' } } })
    expect(actionView(scoped, 7).badge).toBe('ok')
  })

  it('lets the active tab clear a badge the extension set everywhere', () => {
    // an empty override is a value, not an absence: chrome.action.setBadgeText({text:'',
    // tabId}) is how an extension takes the badge off ONE tab
    const cleared = action('abc', { text: 'ok', tabs: { '7': { text: '' } } })
    expect(actionView(cleared, 7).badge).toBe('')
  })

  it('falls back to the extension-wide values when no tab is active', () => {
    const scoped = action('abc', { title: 'Everywhere', text: 'ok', tabs: { '7': { text: '2' } } })
    expect(actionView(scoped, undefined)).toEqual({ id: 'abc', name: 'Everywhere', badge: 'ok' })
  })
})

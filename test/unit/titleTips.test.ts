// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTitleTips, TIP_DELAY_MS } from '../../src/renderer/src/titleTips'

const tip = (): HTMLElement | null => document.querySelector('.kt-tip')

function over(el: Element, from?: Element): void {
  from?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: el }))
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from ?? null }))
}

function leave(el: Element, to: Element): void {
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }))
  to.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: el }))
}

describe('Koloft draws its own tooltip for every title', () => {
  let uninstall: () => void
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div id="away">away</div>
      <div id="tab" title="http://localhost:5173/"><span id="lb">My App</span><button id="x" title="Close tab">x</button></div>
      <div id="quiet" title=""><span id="inner">no tip</span></div>`
    uninstall = installTitleTips(document)
  })
  afterEach(() => {
    uninstall()
    vi.useRealTimers()
  })
  const $ = (id: string): HTMLElement => document.getElementById(id)!

  it('shows the hovered title after the delay, holding back the element title so macOS does not show a second one, and puts it back on leave', () => {
    over($('lb'), $('away'))
    vi.advanceTimersByTime(TIP_DELAY_MS - 1)
    expect(tip()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(tip()?.textContent).toBe('http://localhost:5173/')
    expect($('tab').hasAttribute('title')).toBe(false)
    leave($('tab'), $('away'))
    expect(tip()).toBeNull()
    expect($('tab').getAttribute('title')).toBe('http://localhost:5173/')
  })

  it('a titled child inside a titled element shows its own title, and moving inside the element keeps one tip', () => {
    over($('lb'), $('away'))
    vi.advanceTimersByTime(TIP_DELAY_MS)
    over($('x'), $('lb'))
    expect($('tab').getAttribute('title')).toBe('http://localhost:5173/')
    vi.advanceTimersByTime(TIP_DELAY_MS)
    expect(tip()?.textContent).toBe('Close tab')
    expect(document.querySelectorAll('.kt-tip')).toHaveLength(1)
  })

  it('a click hides the tip and puts the title back at once, and it does not come back until the mouse leaves', () => {
    over($('lb'), $('away'))
    vi.advanceTimersByTime(TIP_DELAY_MS)
    $('lb').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(tip()).toBeNull()
    expect($('tab').getAttribute('title')).toBe('http://localhost:5173/')
    over($('lb'), $('lb'))
    vi.advanceTimersByTime(TIP_DELAY_MS)
    expect(tip()).toBeNull()
    leave($('tab'), $('away'))
    over($('lb'), $('away'))
    vi.advanceTimersByTime(TIP_DELAY_MS)
    expect(tip()?.textContent).toBe('http://localhost:5173/')
  })

  it('an empty title shows nothing, also not its parent’s', () => {
    over($('inner'), $('away'))
    vi.advanceTimersByTime(TIP_DELAY_MS)
    expect(tip()).toBeNull()
  })
})

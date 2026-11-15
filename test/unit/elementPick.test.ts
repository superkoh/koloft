import { describe, it, expect } from 'vitest'
import { cssLines, elementLabel, pickText, pictureOf } from '../../src/main/elementPick'
import {
  closeOwnSession,
  hiddenFromClients,
  holdDebugger,
  openOwnSession
} from '../../src/main/guestDebugger'

const picked = {
  url: 'http://127.0.0.1:5173/cart',
  title: 'Cart',
  frame: null,
  label: 'button#buy.primary',
  box: { x: 10.4, y: 20.6, width: 200, height: 60 },
  html: '<button id="buy" class="primary">Buy</button>',
  css: {
    display: 'inline-block',
    'margin-top': '4px',
    'margin-right': '8px',
    'margin-bottom': '4px',
    'margin-left': '8px',
    'padding-top': '0px',
    'padding-right': '0px',
    'padding-bottom': '0px',
    'padding-left': '0px',
    ...Object.fromEntries(
      ['top', 'right', 'bottom', 'left'].flatMap((s) => [
        [`border-${s}-width`, '1px'],
        [`border-${s}-style`, 'solid'],
        [`border-${s}-color`, 'rgb(0, 0, 0)']
      ])
    ),
    color: 'rgb(255, 255, 255)'
  }
}

describe('the text a pick pastes into the session', () => {
  it('names the page, the element, its picture, its HTML and its computed CSS', () => {
    expect(pickText(picked, '/Users/me/picks/tab-1.png')).toBe(
      [
        'Element picked in the Workbench browser',
        'Page: http://127.0.0.1:5173/cart ("Cart")',
        'Element: button#buy.primary, 200 × 60 px at (10, 21)',
        'Picture: /Users/me/picks/tab-1.png',
        'HTML:',
        '<button id="buy" class="primary">Buy</button>',
        'CSS (computed):',
        'display: inline-block;',
        'margin: 4px 8px;',
        'padding: 0px;',
        'border: 1px solid rgb(0, 0, 0);',
        'color: rgb(255, 255, 255);'
      ].join('\n')
    )
  })

  it('names the frame right after the page when the element sits inside an iframe', () => {
    const text = pickText({ ...picked, frame: 'https://pay.example/widget' }, null)
    expect(text.split('\n').slice(1, 4)).toEqual([
      'Page: http://127.0.0.1:5173/cart ("Cart")',
      'Inside the frame: https://pay.example/widget',
      'Element: button#buy.primary, 200 × 60 px at (10, 21)'
    ])
  })

  it('leaves the picture line out when no picture could be saved', () => {
    expect(pickText(picked, null)).not.toContain('Picture:')
  })

  it('cuts a long HTML and says how much was left out', () => {
    const text = pickText({ ...picked, html: 'x'.repeat(4500) }, null)
    expect(text).toContain(`${'x'.repeat(4000)}… 500 more characters`)
    expect(text).not.toContain('x'.repeat(4001))
  })
})

describe('the picture of a picked element', () => {
  const guestWhoseCapture = (
    capturePage: () => Promise<unknown>
  ): Parameters<typeof pictureOf>[0] =>
    ({
      debugger: {
        sendCommand: async () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } })
      },
      getZoomFactor: () => 1,
      capturePage
    }) as unknown as Parameters<typeof pictureOf>[0]
  const throws = guestWhoseCapture(() =>
    Promise.reject(new Error('Current display surface not available'))
  )
  const root = { session: 'S-1', targetId: 'PAGE-1', url: 'http://127.0.0.1:5173/', parent: null }

  it('carries the reason out when the capture fails, so the pick can say so', async () => {
    expect(await pictureOf(throws, root, picked.box)).toEqual({
      png: null,
      pictureFailed: 'Current display surface not available'
    })
  })

  it('counts a capture that comes back empty as failed', async () => {
    const empty = guestWhoseCapture(async () => ({ isEmpty: () => true }))
    expect(await pictureOf(empty, root, picked.box)).toEqual({
      png: null,
      pictureFailed: 'the page gave back an empty picture'
    })
  })

  it('stays quiet for an element scrolled fully out of view', async () => {
    const below = { x: 10, y: 900, width: 200, height: 60 }
    expect(await pictureOf(throws, root, below)).toEqual({ png: null, pictureFailed: null })
  })
})

describe('the CSS a pick shows, built from the longhands Chromium reports', () => {
  it('lists all four sides when they differ', () => {
    const css = {
      'padding-top': '1px',
      'padding-right': '2px',
      'padding-bottom': '3px',
      'padding-left': '4px'
    }
    expect(cssLines(css)).toEqual(['padding: 1px 2px 3px 4px;'])
  })

  it('puts gap and border-radius back together from their parts', () => {
    const css = {
      'row-gap': '8px',
      'column-gap': '8px',
      'border-top-left-radius': '6px',
      'border-top-right-radius': '6px',
      'border-bottom-right-radius': '6px',
      'border-bottom-left-radius': '6px'
    }
    expect(cssLines(css)).toEqual(['border-radius: 6px;', 'gap: 8px;'])
  })

  it('names each side of a border that differs, with its style and colour', () => {
    const side = (s: string, w: string, style: string, color: string): Record<string, string> => ({
      [`border-${s}-width`]: w,
      [`border-${s}-style`]: style,
      [`border-${s}-color`]: color
    })
    const css = {
      ...side('top', '0px', 'none', 'rgb(0, 0, 0)'),
      ...side('right', '0px', 'none', 'rgb(0, 0, 0)'),
      ...side('bottom', '1px', 'solid', 'rgb(255, 0, 0)'),
      ...side('left', '0px', 'none', 'rgb(0, 0, 0)')
    }
    expect(cssLines(css)).toEqual(['border-bottom: 1px solid rgb(255, 0, 0);'])
  })
})

describe('the element label', () => {
  it('is the tag with its id and classes, like a CSS selector', () => {
    expect(
      elementLabel({ localName: 'div', attributes: ['class', ' card  wide ', 'id', 'main'] })
    ).toBe('div#main.card.wide')
  })
})

function fakeGuest(): {
  wc: Parameters<typeof holdDebugger>[0]
  attaches: () => number
  attached: () => boolean
  detachFromOutside: () => void
} {
  let attached = false
  let attaches = 0
  const onDetach = new Set<() => void>()
  const wc = {
    id: Math.floor(Math.random() * 1e9),
    isDestroyed: () => false,
    debugger: {
      once: (_: string, f: () => void) => onDetach.add(f),
      off: (_: string, f: () => void) => onDetach.delete(f),
      isAttached: () => attached,
      attach: () => {
        if (attached) throw new Error('Debugger is already attached to the target')
        attached = true
        attaches++
      },
      detach: () => {
        attached = false
      }
    }
  } as unknown as Parameters<typeof holdDebugger>[0]
  return {
    wc,
    attaches: () => attaches,
    attached: () => attached,
    detachFromOutside: () => {
      attached = false
      for (const f of [...onDetach]) f()
      onDetach.clear()
    }
  }
}

describe('a session Koloft opens on a guest for itself', () => {
  it('is kept from CDP clients: its messages, and the attach and detach that announce it, even before the attach answers', async () => {
    let answer: (v: { sessionId: string }) => void = () => {}
    const wc = {
      debugger: {
        sendCommand: () => new Promise<{ sessionId: string }>((resolve) => (answer = resolve))
      }
    } as unknown as Parameters<typeof openOwnSession>[0]
    const opening = openOwnSession(wc, 'FRAME-1')
    expect(
      hiddenFromClients('Target.attachedToTarget', {
        sessionId: 'S-1',
        targetInfo: { targetId: 'FRAME-1' }
      })
    ).toBe(true)
    answer({ sessionId: 'S-1' })
    expect(await opening).toBe('S-1')
    expect(hiddenFromClients('Overlay.inspectNodeRequested', {}, 'S-1')).toBe(true)
    expect(hiddenFromClients('Target.detachedFromTarget', { sessionId: 'S-1' })).toBe(true)
    expect(hiddenFromClients('Page.frameNavigated', {}, 'S-2')).toBe(false)
    expect(
      hiddenFromClients('Target.attachedToTarget', {
        sessionId: 'S-2',
        targetInfo: { targetId: 'FRAME-1' }
      })
    ).toBe(false)
  })

  it('is forgotten once its detach is announced, and that announcement still reaches no client', async () => {
    const listeners = new Set<(...a: unknown[]) => void>()
    const wc = {
      debugger: {
        sendCommand: async (method: string) =>
          method === 'Target.attachToTarget' ? { sessionId: 'S-9' } : {},
        on: (_: string, f: (...a: unknown[]) => void) => listeners.add(f),
        off: (_: string, f: (...a: unknown[]) => void) => listeners.delete(f)
      }
    } as unknown as Parameters<typeof openOwnSession>[0]
    await openOwnSession(wc, 'PAGE-9')
    await closeOwnSession(wc, 'S-9')
    expect(hiddenFromClients('Overlay.inspectNodeRequested', {}, 'S-9')).toBe(true)
    const announced = ['Target.detachedFromTarget', { sessionId: 'S-9' }] as const
    for (const f of [...listeners]) f({}, ...announced)
    expect(hiddenFromClients(...announced)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hiddenFromClients('Overlay.inspectNodeRequested', {}, 'S-9')).toBe(false)
  })
})

describe('one debugger attachment per guest, shared by the agent and the picker', () => {
  it('attaches once for two holders and detaches only when the last one lets go', () => {
    const g = fakeGuest()
    const agent = holdDebugger(g.wc)
    const picker = holdDebugger(g.wc)
    expect(g.attaches()).toBe(1)
    picker()
    expect(g.attached()).toBe(true)
    agent()
    expect(g.attached()).toBe(false)
  })

  it('starts a fresh count after the debugger is detached from outside, so a holder from before cannot detach the new one', () => {
    const g = fakeGuest()
    const before = holdDebugger(g.wc)
    g.detachFromOutside()
    const after = holdDebugger(g.wc)
    expect(g.attaches()).toBe(2)
    before()
    expect(g.attached()).toBe(true)
    after()
    expect(g.attached()).toBe(false)
  })

  it('counts a holder that lets go twice only once', () => {
    const g = fakeGuest()
    const agent = holdDebugger(g.wc)
    const picker = holdDebugger(g.wc)
    picker()
    picker()
    expect(g.attached()).toBe(true)
    agent()
    expect(g.attached()).toBe(false)
  })
})

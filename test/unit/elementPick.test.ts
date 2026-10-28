import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { cssValue, elementLabel, pickText, savePickHere } from '../../src/main/elementPick'
import { hiddenFromClients, holdDebugger, openOwnSession } from '../../src/main/guestDebugger'

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
    'border-top-width': '1px',
    'border-right-width': '1px',
    'border-bottom-width': '1px',
    'border-left-width': '1px',
    'border-top-style': 'solid',
    'border-top-color': 'rgb(0, 0, 0)',
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

describe('the CSS shorthand a pick shows', () => {
  it('lists all four sides when they differ', () => {
    const css = {
      'padding-top': '1px',
      'padding-right': '2px',
      'padding-bottom': '3px',
      'padding-left': '4px'
    }
    expect(cssValue(css, 'padding')).toBe('1px 2px 3px 4px')
  })

  it('takes a property Chromium reports directly over its sides', () => {
    expect(cssValue({ gap: '8px' }, 'gap')).toBe('8px')
  })
})

describe('the element label', () => {
  it('is the tag with its id and classes, like a CSS selector', () => {
    expect(
      elementLabel({ localName: 'div', attributes: ['class', ' card  wide ', 'id', 'main'] })
    ).toBe('div#main.card.wide')
  })
})

describe('the pick picture saved on this Mac', () => {
  it('is written under the folder and a picture older than a day is deleted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picks-'))
    const old = path.join(dir, 'old.png')
    fs.writeFileSync(old, 'x')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo)
    const file = await savePickHere(dir, 'tab-1.png', Buffer.from('png'))
    expect(file).toBe(path.join(dir, 'tab-1.png'))
    expect(fs.readFileSync(file, 'utf8')).toBe('png')
    expect(fs.existsSync(old)).toBe(false)
  })
})

function fakeGuest(): {
  wc: Parameters<typeof holdDebugger>[0]
  attaches: () => number
  attached: () => boolean
} {
  let attached = false
  let attaches = 0
  const wc = {
    id: Math.floor(Math.random() * 1e9),
    isDestroyed: () => false,
    debugger: {
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
  return { wc, attaches: () => attaches, attached: () => attached }
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

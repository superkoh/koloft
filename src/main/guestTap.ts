import { BrowserWindow, screen, type WebContents } from 'electron'
import { holdDebugger } from './guestDebugger'
import { within } from './within'
import type { Box, Point } from './tapGrid'

export interface FrameOnPage {
  key: string
  box: Box
}

export interface PartOnPage {
  count: number
  box?: Box
  frames?: FrameOnPage[]
  view?: Box
  ratio?: number
}

export const A_PAGE_ANSWERS_WITHIN_MS = 20_000
const A_TAP_ANSWERS_WITHIN_MS = 8000

export const findPart = (selector: string, scroll: boolean): string => `(() => {
  const els = document.querySelectorAll(${JSON.stringify(selector)})
  if (els.length !== 1) return { count: els.length }
  if (${scroll}) els[0].scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const boxOf = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height } }
  const view = { x: 0, y: 0, width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight }
  const shown = (e) => { const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 }
  const frames = [...document.querySelectorAll('iframe')].map((f, i) => ({ f, key: f.src || '#' + i })).filter(({ f }) => shown(f)).map(({ f, key }) => ({ key, box: boxOf(f) })).filter(({ box: b }) =>
    b.width > 0 && b.height > 0 && b.x < view.width && b.y < view.height && b.x + b.width > 0 && b.y + b.height > 0)
  return { count: 1, box: boxOf(els[0]), frames, view, ratio: devicePixelRatio }
})()`

function screenScaleOf(wc: WebContents): number {
  const win = BrowserWindow.fromWebContents(wc.hostWebContents ?? wc)
  return (win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()).scaleFactor
}

// PLATFORM§8 PLATFORM§9 PLATFORM§16
export async function pictureOfPart(wc: WebContents, box: Box, ratio: number): Promise<Buffer> {
  const zoom = ratio / screenScaleOf(wc)
  const rect = {
    x: Math.round(box.x * zoom),
    y: Math.round(box.y * zoom),
    width: Math.round(box.width * zoom),
    height: Math.round(box.height * zoom)
  }
  const image = await within(
    wc.capturePage(rect),
    A_PAGE_ANSWERS_WITHIN_MS,
    `the page did not give its picture within ${A_PAGE_ANSWERS_WITHIN_MS / 1000} s`
  )
  if (image.isEmpty()) throw new Error('the page gave back an empty picture')
  return image.toPNG()
}

function mouse(wc: WebContents, type: string, { x, y }: Point): Promise<unknown> {
  const press = type !== 'mouseMoved'
  return within(
    wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: press ? 'left' : 'none',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: press ? 1 : 0
    }),
    A_TAP_ANSWERS_WITHIN_MS,
    `the page did not take the tap within ${A_TAP_ANSWERS_WITHIN_MS / 1000} s`
  )
}

// PLATFORM§16
export async function tapAt(wc: WebContents, point: Point): Promise<void> {
  const release = holdDebugger(wc)
  try {
    await mouse(wc, 'mouseMoved', point)
    await mouse(wc, 'mousePressed', point)
  } finally {
    await mouse(wc, 'mouseReleased', point).catch(() => undefined)
    release()
  }
}

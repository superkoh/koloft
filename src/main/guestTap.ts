import type { WebContents } from 'electron'
import { holdDebugger } from './guestDebugger'
import { within } from './within'
import type { Box, Point } from './tapGrid'

export interface PartOnPage {
  count: number
  box?: Box
  frames?: Box[]
  view?: Box
}

const A_PAGE_ANSWERS_WITHIN_MS = 20_000
const A_TAP_ANSWERS_WITHIN_MS = 8000

export const findPart = (selector: string): string => `(() => {
  const els = document.querySelectorAll(${JSON.stringify(selector)})
  if (els.length !== 1) return { count: els.length }
  els[0].scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const boxOf = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height } }
  const view = { x: 0, y: 0, width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight }
  const shown = (e) => { const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 }
  const frames = [...document.querySelectorAll('iframe')].filter(shown).map(boxOf).filter((b) =>
    b.width > 0 && b.height > 0 && b.x < view.width && b.y < view.height && b.x + b.width > 0 && b.y + b.height > 0)
  return { count: 1, box: boxOf(els[0]), frames, view }
})()`

// PLATFORM§16
export async function pictureOfPart(wc: WebContents, box: Box): Promise<Buffer> {
  const zoom = wc.getZoomFactor()
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

// PLATFORM§16
export async function tapAt(wc: WebContents, { x, y }: Point): Promise<void> {
  const release = holdDebugger(wc)
  try {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const)
      await within(
        wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: type === 'mouseMoved' ? 'none' : 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: type === 'mouseMoved' ? 0 : 1
        }),
        A_TAP_ANSWERS_WITHIN_MS,
        `the page did not take the tap within ${A_TAP_ANSWERS_WITHIN_MS / 1000} s`
      )
  } finally {
    release()
  }
}

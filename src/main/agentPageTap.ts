import { urlOrNull } from '@shared/browserRoute'
import { answered, EXIT_USAGE, refused, type AgentReply, type AgentVerb } from './agentRequests'
import type { SecretAnswer, SecretAsk, TapRounds } from './discord/secretAsks'
import type { DiscordFile } from './discord/link'
import type { PartOnPage } from './guestTap'
import {
  boxAround,
  clipTo,
  gridOver,
  readSquares,
  type Box,
  type Grid,
  type Point
} from './tapGrid'

export const PAGE_USAGE =
  'koloft: usage: koloft page tap <css selector> -- "<one line that tells the owner what to do>"'
export const NO_SUCH_PART =
  "koloft: no single element matches that selector in this session's Workbench pages. Give a selector that matches exactly one element: the smallest one that holds what the owner must tap, usually the check's <iframe>."
export const OWNER_ASLEEP_TAP =
  'koloft: the owner is asleep and cannot tap the page now. Skip this step, go on with the rest, and say in your report that it waits for the owner.'
export const TAPS_PASSED =
  'The owner said it passed. Look at the page to see whether it went through.'
export const DONE_AT_THE_MAC =
  'The owner said they were done, on the Mac. Look at the page to see whether it went through.'
export const OWNER_GAVE_UP =
  'koloft: the owner gave up on this; nothing more is tapped. Look at the page to see where it stands.'
export const TAPS_NOT_IN_TIME =
  'koloft: the owner did not finish in time. Look at the page to see where it stands.'
export const SQUARES_LABEL = 'Squares to tap, in order'
const OUT_OF_VIEW = 'the part of the page to show is out of view'

const A_TAPPED_PAGE_SETTLES_MS = 1500
const BETWEEN_TAPS_MS = 250
// PLATFORM§9
const A_PAGE_BROUGHT_TO_THE_FRONT_PAINTS_MS = 800

export interface TapPage {
  guestId: number
  url(): string
  find(selector: string): Promise<PartOnPage>
  picture(box: Box): Promise<Buffer>
  tap(point: Point): Promise<void>
}

export interface PageVerbDeps {
  sessionTab(tabId: string): string
  ask(a: SecretAsk): Promise<SecretAnswer>
  ownerAsleep(): boolean
  pages(tabId: string): TapPage[]
  draw(png: Buffer, grid: Grid): Promise<DiscordFile>
  sleep(ms: number): Promise<void>
}

const boxKey = (b: Box): string => [b.x, b.y, b.width, b.height].map(Math.round).join(',')

function rounds(d: PageVerbDeps, page: TapPage, selector: string, first: PartOnPage): TapRounds {
  const seenAtStart = new Set((first.frames ?? []).map(boxKey))
  let part = first.box!
  let view = first.view!
  let grid: Grid | undefined
  let shownBefore = false
  return {
    picture: async () => {
      if (!shownBefore) await d.sleep(A_PAGE_BROUGHT_TO_THE_FRONT_PAINTS_MS)
      shownBefore = true
      const now = await page.find(selector).catch((): PartOnPage => ({ count: 0 }))
      if (now.count === 1 && now.box) part = now.box
      if (now.view) view = now.view
      const cameIntoView = (now.frames ?? []).filter((f) => !seenAtStart.has(boxKey(f)))
      const shown = clipTo(boxAround([part, ...cameIntoView]), view)
      if (!shown) throw new Error(OUT_OF_VIEW)
      grid = gridOver(shown)
      return d.draw(await page.picture(shown), grid)
    },
    tap: async (text) => {
      if (!grid) return 'Koloft has no picture to tap on yet: press New picture.'
      const read = readSquares(grid, text)
      if ('unknown' in read)
        return `Koloft tapped nothing: ${read.unknown.length ? read.unknown.join(', ') : 'no square'} is not a square on the picture.`
      for (const [i, point] of read.points.entries()) {
        if (i) await d.sleep(BETWEEN_TAPS_MS)
        await page.tap(point)
      }
      await d.sleep(A_TAPPED_PAGE_SETTLES_MS)
      return `Tapped ${read.names.join(', ')}.`
    }
  }
}

async function tapAsk(
  d: PageVerbDeps,
  at: { tabId: string; from: string },
  selector: string,
  what: string
): Promise<AgentReply> {
  if (d.ownerAsleep()) return refused(OWNER_ASLEEP_TAP)
  const pages = d.pages(at.tabId)
  const found = await Promise.all(
    pages.map((p) => p.find(selector).catch((): PartOnPage => ({ count: 0 })))
  )
  if (found.reduce((n, f) => n + f.count, 0) !== 1) return refused(NO_SUCH_PART)
  const i = found.findIndex((f) => f.count === 1)
  const page = pages[i]
  const url = page.url()
  const site = urlOrNull(url)?.host || url
  const a = await d.ask({
    ...at,
    shape: { kind: 'tap', guestId: page.guestId, url, label: what },
    header: (name) => `👆 **${name}** asks you to tap a web page`,
    body: `Page: ${site}\n${what}\nSay which squares to tap.`,
    label: SQUARES_LABEL,
    taps: rounds(d, page, selector, found[i])
  })
  if ('ended' in a) return refused(a.ended === 'declined' ? OWNER_GAVE_UP : TAPS_NOT_IN_TIME)
  return answered('passed' in a ? TAPS_PASSED : DONE_AT_THE_MAC)
}

export function pageVerb(d: PageVerbDeps): AgentVerb {
  return (args, caller) => {
    const [sub, selector, dashes, what, ...more] = args
    if (sub !== 'tap' || !selector?.trim() || dashes !== '--' || !what?.trim() || more.length)
      return refused(PAGE_USAGE, EXIT_USAGE)
    return tapAsk(
      d,
      { tabId: d.sessionTab(caller.tabId), from: caller.tabId },
      selector,
      what.trim()
    )
  }
}

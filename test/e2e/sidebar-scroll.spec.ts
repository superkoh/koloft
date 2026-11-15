import type { Page } from '@playwright/test'
import { test, expect, pendingAttention } from './helpers/app'
import { sendShortcut, startSessionIn, waitBooted } from './helpers/p1'

type Box = { top: number; bottom: number }
type Layout = {
  list: Box
  inbox: Box
  heads: Record<string, Box>
  blocks: Record<string, Box>
  active: Box | null
  activeTab: string | null
  activeHead: Box | null
  ownerOfTopEdge: string | null
}

const SHORT_LIST = '.ws-list { max-height: 120px !important; }'
const INTO_WS_A_ROWS = 30

function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    }
    const list = document.querySelector('.ws-list')!
    const heads: Record<string, Box> = {}
    const blocks: Record<string, Box> = {}
    for (const ws of document.querySelectorAll('.ws')) {
      const name = ws.querySelector('.ws-name')!.textContent!
      heads[name] = box(ws.querySelector('.ws-head')!)
      blocks[name] = box(ws)
    }
    const active = list.querySelector('.ws .ws-tab.active')
    const lr = list.getBoundingClientRect()
    const top = document.elementFromPoint(lr.left + lr.width / 2, lr.top + 2)
    return {
      list: box(list),
      inbox: box(document.querySelector('.ibx-entry')!),
      heads,
      blocks,
      active: active && box(active),
      activeTab: active?.getAttribute('data-tab-id') ?? null,
      activeHead: active && box(active.closest('.ws')!.querySelector('.ws-head')!),
      ownerOfTopEdge: top?.closest('.ws')?.querySelector('.ws-name')?.textContent ?? null
    }
  })
}

const scrollTo = (page: Page, at: number | 'end'): Promise<void> =>
  page
    .locator('.ws-list')
    .evaluate((el, to) => void (el.scrollTop = to === 'end' ? el.scrollHeight : to), at)

async function scrollIntoWsARows(page: Page): Promise<void> {
  await scrollTo(page, 0)
  const l = await layout(page)
  await scrollTo(page, l.heads['ws-a'].bottom - l.list.top + INTO_WS_A_ROWS)
}

test.describe('C2 sidebar scroll: Inbox stays on screen, a workspace head stays at the top of the list until its last row has gone', () => {
  test('the Inbox never moves while the list scrolls, a workspace head sticks at the top while its rows pass under it and leaves with its last row, a row the app jumps to lands below its stuck head, and a workspace dragged onto a stuck head goes before it', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-a')
    await page
      .locator('.hint-card[data-hint="worktree"]')
      .getByRole('button', { name: 'Got it', exact: true })
      .click()
    await startSessionIn(page, 'ws-b')
    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(3)
    await page.addStyleTag({ content: SHORT_LIST })

    await scrollTo(page, 0)
    const start = await layout(page)
    expect(start.inbox.bottom).toBeLessThanOrEqual(start.list.top)

    await scrollIntoWsARows(page)
    const midA = await layout(page)
    expect(midA.inbox).toEqual(start.inbox)
    expect(midA.blocks['ws-a'].top).toBeLessThan(midA.list.top)
    expect(midA.heads['ws-a'].top).toBeCloseTo(midA.list.top, 0)
    expect(midA.ownerOfTopEdge).toBe('ws-a')

    await scrollTo(page, 'end')
    const end = await layout(page)
    expect(end.inbox).toEqual(start.inbox)
    expect(end.heads['ws-a'].bottom).toBeLessThanOrEqual(end.blocks['ws-a'].bottom + 0.5)
    expect(end.heads['ws-a'].top).toBeLessThan(end.list.top)
    expect(end.heads['ws-b'].top).toBeGreaterThanOrEqual(end.blocks['ws-a'].bottom)

    for (let press = 0; press < 3; press++) {
      await scrollTo(page, 'end')
      const before = (await layout(page)).activeTab
      await sendShortcut(app, 'shortcut:next-waiting-session')
      await expect.poll(async () => (await layout(page)).activeTab).not.toBe(before)
      await expect
        .poll(async () => {
          const l = await layout(page)
          return (
            !!l.active &&
            !!l.activeHead &&
            l.active.top >= l.activeHead.bottom - 0.5 &&
            l.active.bottom <= l.list.bottom + 0.5
          )
        })
        .toBe(true)
    }

    await scrollIntoWsARows(page)
    expect((await layout(page)).heads['ws-a'].top).toBeCloseTo(midA.list.top, 0)
    await page
      .locator('.ws-head', { hasText: 'ws-b' })
      .dragTo(page.locator('.ws-head', { hasText: 'ws-a' }), {
        targetPosition: { x: 40, y: 4 }
      })
    await expect(page.locator('.ws-head .ws-name')).toHaveText(['ws-b', 'ws-a'])
  })
})

import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, pendingAttention } from '../e2e/helpers/app'
import {
  boundSessionId,
  openMenu,
  switchToRow,
  terminalText,
  type AgentName
} from '../e2e/helpers/p1'
import type { AttentionKind } from '../../src/shared/types'

export type RowState = 'st-pending' | 'st-working' | 'st-approval' | 'st-waiting' | 'st-idle'

export interface Driver {
  page: Page
  start(wsName: string, agent?: AgentName): Promise<string>
  row(tabId: string): Locator
  show(tabId: string): Promise<void>
  type(tabId: string, text: string): Promise<void>
  waitFor(tabId: string, state: RowState, timeoutMs?: number): Promise<void>
  askAndWait(tabId: string, text: string, timeoutMs?: number): Promise<AttentionKind>
  screen(tabId: string): Promise<string>
  toasts(): Promise<string[]>
  shot(file: string): Promise<void>
}

// CC§12
const ENTER_GOES_IN_A_WRITE_OF_ITS_OWN_AFTER_MS = 800
const NEW_SESSION_BIND_DEADLINE_MS = 60_000
const TURN_DEADLINE_MS = 180_000

async function koloftPage(browser: Browser): Promise<Page> {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().endsWith('/renderer/index.html'))
  if (!page) throw new Error('the sandbox shows no Koloft window')
  return page
}

const exactly = (text: string): RegExp =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

export async function attach(cdp: string): Promise<Driver> {
  const browser = await chromium.connectOverCDP(cdp)
  const page = await koloftPage(browser)
  const row = (tabId: string): Locator => page.locator(`.ws-tab[data-tab-id="${tabId}"]`)
  const closeTipThatWouldEatTheNextClick = async (): Promise<void> => {
    const tip = page.locator('.hint-card')
    if (await tip.isVisible()) await tip.getByRole('button', { name: 'Got it' }).click()
  }
  const show = async (tabId: string): Promise<void> => {
    await closeTipThatWouldEatTheNextClick()
    await switchToRow(page, row(tabId))
  }
  const markOf = async (tabId: string): Promise<string> => {
    const mark = (await pendingAttention(page)).find((e) => e.tabId === tabId)
    return mark ? `${mark.kind}@${mark.at}` : ''
  }
  const write = (tabId: string, text: string): Promise<void> =>
    page.evaluate(([id, t]) => window.api.terminal.write(id, t), [tabId, text])
  const waitFor = (tabId: string, state: RowState, timeoutMs = TURN_DEADLINE_MS): Promise<void> =>
    expect(row(tabId)).toHaveClass(new RegExp(`\\b${state}\\b`), { timeout: timeoutMs })

  const type = async (tabId: string, text: string): Promise<void> => {
    await write(tabId, text)
    await page.waitForTimeout(ENTER_GOES_IN_A_WRITE_OF_ITS_OWN_AFTER_MS)
    await write(tabId, '\r')
  }

  return {
    page,
    row,
    show,
    type,
    waitFor,
    async start(wsName, agent) {
      const group = page
        .locator('.ws')
        .filter({ has: page.locator('.ws-head .ws-name', { hasText: exactly(wsName) }) })
      const activeTab = (): Promise<string | null> =>
        group
          .locator('.ws-tab.active[data-tab-id]')
          .evaluateAll((rows) => rows[0]?.getAttribute('data-tab-id') ?? null)
      const before = await activeTab()
      await closeTipThatWouldEatTheNextClick()
      await openMenu(page, group.locator('.ws-head'))
      const items = page.locator('.menu .mi:not(.disabled)')
      await (
        agent
          ? items.filter({ hasText: new RegExp(`^New ${agent} session`) })
          : items.filter({ has: page.locator('.k', { hasText: /^⌘N$/ }) })
      ).click()
      let tabId: string | null = null
      await expect
        .poll(
          async () => {
            tabId = await activeTab()
            return tabId !== null && tabId !== before && (await boundSessionId(page, tabId))
          },
          { timeout: NEW_SESSION_BIND_DEADLINE_MS }
        )
        .toBeTruthy()
      await expect(row(tabId!)).toHaveClass(/\bst-(working|waiting|approval|idle)\b/, {
        timeout: NEW_SESSION_BIND_DEADLINE_MS
      })
      return tabId!
    },
    async askAndWait(tabId, text, timeoutMs = TURN_DEADLINE_MS) {
      const markBefore = await markOf(tabId)
      await type(tabId, text)
      let kind: AttentionKind | undefined
      await expect
        .poll(
          async () => {
            const mark = await markOf(tabId)
            if (mark && mark !== markBefore) kind = mark.split('@')[0] as AttentionKind
            else if (/\bst-approval\b/.test((await row(tabId).getAttribute('class')) ?? ''))
              kind = 'approval'
            return kind
          },
          { timeout: timeoutMs }
        )
        .toBeTruthy()
      return kind!
    },
    screen: (tabId) => terminalText(page, tabId),
    toasts: () => page.locator('.toast .toast-msg').allTextContents(),
    async shot(file) {
      await page.screenshot({ path: file })
    }
  }
}

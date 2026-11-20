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
  const show = (tabId: string): Promise<void> => switchToRow(page, row(tabId))
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
      await openMenu(page, group.locator('.ws-head'))
      await page
        .locator('.menu .mi:not(.disabled)', {
          hasText: agent ? new RegExp(`^New ${agent} session`) : /^New (\w+ )?session/
        })
        .first()
        .click()
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
      return tabId!
    },
    async askAndWait(tabId, text, timeoutMs = TURN_DEADLINE_MS) {
      const typedAt = Date.now()
      await type(tabId, text)
      let kind: AttentionKind | undefined
      await expect
        .poll(
          async () => {
            kind = (await pendingAttention(page)).find(
              (e) => e.tabId === tabId && e.at > typedAt
            )?.kind
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

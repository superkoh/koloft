import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect } from '@playwright/test'
import { openMenu, switchToRow, terminalText, wsGroup, type AgentName } from '../e2e/helpers/p1'

export type RowState = 'st-pending' | 'st-working' | 'st-approval' | 'st-waiting' | 'st-idle'

export interface Driver {
  page: Page
  start(wsName: string, agent?: AgentName): Promise<string>
  row(tabId: string): Locator
  show(tabId: string): Promise<void>
  type(tabId: string, text: string): Promise<void>
  waitFor(tabId: string, state: RowState, timeoutMs?: number): Promise<void>
  askAndWait(tabId: string, text: string, timeoutMs?: number): Promise<void>
  screen(tabId: string): Promise<string>
  toasts(): Promise<string[]>
  shot(file: string): Promise<void>
}

// CC§12
const ENTER_GOES_IN_A_WRITE_OF_ITS_OWN_AFTER_MS = 800
const NEW_ROW_DEADLINE_MS = 60_000
const TURN_DEADLINE_MS = 180_000

async function koloftPage(browser: Browser): Promise<Page> {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().endsWith('/renderer/index.html'))
  if (!page) throw new Error('the sandbox shows no Koloft window')
  return page
}

const tabIdsIn = (scope: Locator): Promise<string[]> =>
  scope
    .locator('.ws-tab[data-tab-id]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-tab-id')!))

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
    async start(wsName, agent = 'Claude') {
      const group = wsGroup(page, wsName)
      const before = new Set(await tabIdsIn(group))
      await openMenu(page, group.locator('.ws-head'))
      await page
        .locator('.menu .mi:not(.disabled)', { hasText: new RegExp(`^New (${agent} )?session`) })
        .click()
      let tabId: string | undefined
      await expect
        .poll(
          async () => {
            tabId = (await tabIdsIn(group)).find((id) => !before.has(id))
            return tabId
          },
          { timeout: NEW_ROW_DEADLINE_MS }
        )
        .toBeTruthy()
      await expect(row(tabId!)).not.toHaveClass(/\bst-pending\b/, { timeout: NEW_ROW_DEADLINE_MS })
      return tabId!
    },
    async askAndWait(tabId, text, timeoutMs = TURN_DEADLINE_MS) {
      await type(tabId, text)
      await waitFor(tabId, 'st-working', timeoutMs)
      await waitFor(tabId, 'st-waiting', timeoutMs)
    },
    screen: (tabId) => terminalText(page, tabId),
    toasts: () => page.locator('.toast .toast-msg').allTextContents(),
    async shot(file) {
      await page.screenshot({ path: file })
    }
  }
}

import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings } from './helpers/env'
import {
  centerTerm,
  openMenu,
  openSessionTerminal,
  panelTerm,
  readCalls,
  runIn,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsGroup,
  wsRows
} from './helpers/p1'

const CENTER = '.term-island .term-wrap'
const PANEL = '.wb-panel .wb-term'
const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000

function shownTermText(page: Page, box: string): Promise<string> {
  return page.evaluate((sel) => {
    const terms =
      (
        window as unknown as {
          __koloftTerms?: Record<
            string,
            {
              element?: HTMLElement
              buffer: {
                active: {
                  length: number
                  getLine(
                    i: number
                  ): { isWrapped: boolean; translateToString(trim?: boolean): string } | undefined
                }
              }
            }
          >
        }
      ).__koloftTerms ?? {}
    for (const t of Object.values(terms)) {
      const wrap = t.element?.closest(sel)
      if (!t.element || !wrap || wrap.getClientRects().length === 0) continue
      if (getComputedStyle(t.element).visibility === 'hidden') continue
      const b = t.buffer.active
      let text = ''
      for (let i = 0; i < b.length; i++) {
        const line = b.getLine(i)
        if (!line) continue
        text += (i === 0 || line.isWrapped ? '' : '\n') + line.translateToString(true)
      }
      return text
    }
    return ''
  }, box)
}

async function koloftExits(page: Page): Promise<string[]> {
  const text = await shownTermText(page, CENTER)
  return [...text.matchAll(/\[fake-claude\] koloft exit=(\d+)/g)].map((m) => m[1])
}

async function koloftInSession(page: Page, args: string): Promise<string> {
  const before = (await koloftExits(page)).length
  await runIn(page, centerTerm(page), `/koloft ${args}`)
  await expect
    .poll(async () => (await koloftExits(page)).length, {
      timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS
    })
    .toBe(before + 1)
  return (await koloftExits(page))[before]
}

async function openCron(page: Page, wsName: string): Promise<Locator> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
  const dlg = page.locator('.modal.cronjobs')
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

test.describe('`koloft` inside a Koloft tab: the command Koloft puts on PATH reaches Koloft and acts for the session it runs in', () => {
  test('koloft cron add from a session adds a job to its pinned workspace, shown in Scheduled jobs and in koloft cron list', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    expect(await koloftInSession(page, 'cron add --name Standup --daily 09:00 -- say hi')).toBe('0')
    expect(await koloftInSession(page, 'cron list')).toBe('0')
    expect(await shownTermText(page, CENTER)).toMatch(/^1\. Standup · /m)

    const dlg = await openCron(page, 'ws-a')
    await expect(
      dlg.locator('.job-row').filter({ has: page.locator('.job-name', { hasText: /^Standup$/ }) })
    ).toHaveCount(1)
  })

  test('koloft session new starts a named sibling in the same workspace and leaves the caller on screen', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const callerTabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
    expect(callerTabId).toBeTruthy()
    const callsBefore = readCalls(env).length

    expect(await koloftInSession(page, 'session new --name kid -- hello')).toBe('0')

    await expect(wsRows(page, 'ws-a')).toHaveCount(2, { timeout: 60_000 })
    const calls = await waitForCalls(env, callsBefore + 1, 60_000)
    const kid = calls[calls.length - 1]
    expect(kid.argv[kid.argv.indexOf('--name') + 1]).toBe('kid')
    expect(kid.firstPrompt).toMatch(/\n\nhello$/)
    await expect(wsGroup(page, 'ws-a').locator('.ws-tab.active')).toHaveAttribute(
      'data-tab-id',
      callerTabId!
    )
  })

  test("koloft in a session's Workbench shell acts for the session that owns the shell", async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)

    await runIn(page, panelTerm(page), 'koloft help; echo "help-exit=$?"')
    await expect
      .poll(async () => /help-exit=(\d+)/.exec(await shownTermText(page, PANEL))?.[1], {
        timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS
      })
      .toBe('0')
  })

  test('with agent tools off in Settings, a new session has no koloft channel and koloft is refused', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedSettings(env, { agentTools: false })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')

      expect(await koloftInSession(page, 'help')).not.toBe('0')
    } finally {
      await quitAndClose(app)
    }
  })
})

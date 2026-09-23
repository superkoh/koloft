import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  runIn,
  settingsOnDisk,
  snap,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { layoutState, seedWorkbenchDefault, wbUnreadTabs, WORKBENCH } from './helpers/workbench'

// Layer B — the four contextual hints (T-HN-01…T-HN-07). One card at a time,
// portalled to the body, anchored at the thing it is talking about; showing it IS
// seeing it, and only "Don't show tips" silences the rest.
//
// Three fixture facts every case here is built on:
//  - the fixture home pins ws-a and ws-b, and its layout.json opts INTO an expanded
//    Workbench (`workbench.defaultOpen: true`). The `workbench` hint only fires while
//    the panel is collapsed, so a case that wants it calls `seedWorkbenchDefault(env,
//    false)` and a case that must not see it leaves the opt-in alone.
//  - the `workbench` hint counts LIVE writes (`liveWrites`, stamped after the bind), so
//    the canned startup turn's own NOTES.md write already earns it on launch when the
//    panel is collapsed; `/write <name>` is a second, explicit write for the cases that
//    want one on demand.
//  - a hint closes on ANY mousedown outside its card, so a case that has to move the
//    UI while a card is up goes through the app menu (`toggle-browser`), never a click.
//
// The approval trigger needs a row that is NOT the shown tab, which no typing gesture
// can reach: the only terminal on screen belongs to the selected session. It is driven
// through `window.api.terminal.write` — the very channel the xterm sends the user's own
// keystrokes on (precedent: reload-recovery.spec.ts) — so the background session gets
// that line exactly as it would have had Claude asked for permission on its own.

/** Seeds that have to be on disk before the app reads them, then a launched window. */
async function start(
  env: E2EEnv,
  opts: { hintsSeen?: string[]; hintsOff?: boolean; panelOpen?: boolean } = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  seedSettings(env, {
    onboardingSeen: true,
    hintsSeen: opts.hintsSeen ?? [],
    hintsOff: opts.hintsOff ?? false
  })
  if (opts.panelOpen === false) seedWorkbenchDefault(env, false)
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

function card(page: Page, id?: string): ReturnType<Page['locator']> {
  return page.locator(id ? `.hint-card[data-hint="${id}"]` : '.hint-card')
}

/** A sidebar row, by the tab it belongs to — what a row anchor is keyed on. */
function rowSel(tabId: string): string {
  return `.ws-tab[data-tab-id="${tabId}"]`
}

/**
 * Where the cut-out sits relative to the element the card is supposed to point at.
 * `{dx:0, dy:0}` means "anchored here": the backdrop is drawn 4px outside the target's
 * own rect, and it is the only observable that tells one anchor from another — with the
 * panel open, both of the `agent-web` anchors are on screen at the same time.
 */
async function anchorOffset(
  page: Page,
  selector: string
): Promise<{ dx: number; dy: number } | null> {
  const target = await page.locator(selector).first().boundingBox()
  const back = await page.locator('.hint-backdrop').boundingBox()
  if (!target || !back) return null
  return { dx: Math.round(back.x + 4 - target.x), dy: Math.round(back.y + 4 - target.y) }
}

async function expectAnchoredAt(page: Page, selector: string): Promise<void> {
  await expect(card(page)).toBeVisible()
  await expect
    .poll(() => anchorOffset(page, selector), { timeout: 15_000 })
    .toEqual({
      dx: 0,
      dy: 0
    })
}

/** The tab id of the row on screen — what `terminal.write` addresses, and what a row
 *  anchor is keyed on (`data-tab-id` survives the pending row being replaced). */
async function shownTabId(page: Page): Promise<string> {
  const id = await page.locator('.ws-tab.active').first().getAttribute('data-tab-id')
  if (!id) throw new Error('the shown session row carries no data-tab-id')
  return id
}

/** Type one line into a session that is NOT on screen, on the channel its own xterm
 *  uses. The approval trigger is defined by the row being hidden, so no gesture in the
 *  product can reach it. */
async function typeInto(page: Page, tabId: string, line: string): Promise<void> {
  await page.evaluate((a) => window.api.terminal.write(a.id, a.line + '\r'), {
    id: tabId,
    line
  })
}

/** No card came up, and none was on its way: the pump waits out the gap before it shows
 *  anything, so a bare `toHaveCount(0)` straight after a trigger would pass too early. */
async function stayAbsent(page: Page, ms = 4000): Promise<void> {
  await page.waitForTimeout(ms)
  await expect(card(page)).toHaveCount(0)
}

// ---- T-HN-01 -------------------------------------------------------------------------

test('T-HN-01: the workbench hint comes up once, takes no focus, and never returns', async ({
  env
}) => {
  test.setTimeout(240_000)
  let { app, page } = await start(env, { panelOpen: false })
  try {
    // a file written mid-turn while the panel is shut — the trigger
    await startSessionIn(page, 'ws-a')
    await runIn(page, centerTerm(page), '/write first.md')
    await expect(card(page, 'workbench')).toBeVisible({ timeout: 30_000 })
    await expect(card(page, 'workbench').locator('.h')).toHaveText('Claude changed a file')
    await expect(card(page, 'workbench').locator('.foot .n')).toHaveText('tip 1 of 5')
    await expectAnchoredAt(page, WORKBENCH.titlebarIcon)
    await snap(page, 'T-HN-01')

    // the card never moves the focus: the user is typing at a claude TUI and the next
    // keystroke has to reach the pty. Typed WITHOUT clicking first — a click anywhere
    // outside the card would close it and hide the very thing being measured.
    expect(await focusOwner(page)).toBe('tui')
    await page.keyboard.type('hint-focus-probe')
    await page.keyboard.press('Enter')
    await expect(centerTerm(page)).toContainText('handled: hint-focus-probe', { timeout: 30_000 })
    await expect(card(page, 'workbench')).toBeVisible()

    await card(page, 'workbench').locator('button.mini', { hasText: 'Got it' }).click()
    await expect(card(page)).toHaveCount(0)
    await expect
      .poll(() => settingsOnDisk(env).hintsSeen, { timeout: 20_000 })
      .toEqual(['workbench'])

    // a second write in the same session earns nothing
    await runIn(page, centerTerm(page), '/write second.md')
    await expect(centerTerm(page)).toContainText('wrote second.md', { timeout: 30_000 })
    await stayAbsent(page)
  } finally {
    await quitAndClose(app)
  }

  // …and neither does a fresh launch: seen is seen, on disk
  app = await launchApp(env)
  try {
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await runIn(page, centerTerm(page), '/write third.md')
    await expect(centerTerm(page)).toContainText('wrote third.md', { timeout: 30_000 })
    await stayAbsent(page)
  } finally {
    await quitAndClose(app)
  }
})

// ---- T-HN-02 -------------------------------------------------------------------------

test('T-HN-02: the approval hint fires only for a row that is not on screen', async ({ env }) => {
  test.setTimeout(240_000)
  // the panel opt-in stays, so no `workbench` hint can crowd this one out; `worktree`
  // is seeded seen because a second session in ws-a would earn it
  const { app, page } = await start(env, { hintsSeen: ['worktree'] })
  try {
    await startSessionIn(page, 'ws-a')
    const a = await shownTabId(page)
    await startSessionIn(page, 'ws-a')
    const b = await shownTabId(page)
    expect(b).not.toBe(a)

    // control: B is the shown tab when it turns amber — nothing is said
    await runIn(page, centerTerm(page), '/need-approval')
    await expect(page.locator(rowSel(b))).toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
    await stayAbsent(page)

    // clear the amber so the trigger has a transition to make again, then put A on screen
    await runIn(page, centerTerm(page), 'back to work')
    await expect(page.locator(rowSel(b))).not.toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
    await page.locator(rowSel(a)).click()
    await expect(page.locator(rowSel(a))).toHaveClass(/\bactive\b/, { timeout: 15_000 })

    // …and the hint was still armed: the same session, amber again, now hidden
    await typeInto(page, b, '/need-approval')
    await expect(card(page, 'approval')).toBeVisible({ timeout: 30_000 })
    await expect(card(page, 'approval').locator('.h')).toHaveText('Amber means a session needs you')
    await expectAnchoredAt(page, rowSel(b))
    await snap(page, 'T-HN-02')
  } finally {
    await quitAndClose(app)
  }
})

// ---- T-HN-03 -------------------------------------------------------------------------

test('T-HN-03: the agent-web hint follows the page onto the Browser tab', async ({ env }) => {
  test.setTimeout(240_000)
  const { app, page } = await start(env, { hintsSeen: ['workbench'], panelOpen: false })
  try {
    await startSessionIn(page, 'ws-a')
    // port 1 answers nothing on purpose: the hint is earned by the shim's open request,
    // not by a page load, and nothing here may reach the developer's real browser
    await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/hinted')
    await expect(centerTerm(page)).toContainText('opened http://127.0.0.1:1/hinted', {
      timeout: 30_000
    })

    await expect(card(page, 'agent-web')).toBeVisible({ timeout: 30_000 })
    await expect(card(page, 'agent-web').locator('.h')).toHaveText('Claude opened this page here')
    // the tab it is about is off screen, so the card points at what would reveal it
    await expectAnchoredAt(page, WORKBENCH.titlebarIcon)
    await snap(page, 'T-HN-03')

    // expand through the MENU: a click on the toggle is a click outside the card
    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T2')
    await expect(wbUnreadTabs(page)).toHaveCount(1)
    // …and the card re-measures onto the tab the page landed in, named by its own id
    const landed = await wbUnreadTabs(page).getAttribute('data-wb-tab-id')
    await expectAnchoredAt(page, `.wb-tab[data-wb-tab-id="${landed}"]`)
  } finally {
    await quitAndClose(app)
  }
})

// ---- T-HN-04 -------------------------------------------------------------------------

test('T-HN-04: the worktree hint fires on a second session in the SAME workspace', async ({
  env
}) => {
  test.setTimeout(240_000)
  const { app, page } = await start(env)
  try {
    await startSessionIn(page, 'ws-a')

    // two controls, neither of which may say anything (a hint already seen would make
    // them vacuous): ws-b has no running row of its own, so a launch there earns no
    // `worktree` card even with ws-a busy beside it — and a file written mid-turn earns
    // no `workbench` card either, because this fixture's panel is EXPANDED
    await startSessionIn(page, 'ws-b')
    await runIn(page, centerTerm(page), '/write shown.md')
    await expect(centerTerm(page)).toContainText('wrote shown.md', { timeout: 30_000 })
    await stayAbsent(page)

    // the real case: ws-a already has a running row
    await startSessionIn(page, 'ws-a')
    await expect(card(page, 'worktree')).toBeVisible({ timeout: 30_000 })
    await expect(card(page, 'worktree').locator('.h')).toHaveText('Two sessions on one folder?')
    await expectAnchoredAt(page, rowSel(await shownTabId(page)))
    await snap(page, 'T-HN-04')
  } finally {
    await quitAndClose(app)
  }
})

// ---- T-HN-05 -------------------------------------------------------------------------

test('T-HN-05: Don’t show tips silences every hint until Reset tips', async ({ env }) => {
  test.setTimeout(240_000)
  // the panel opt-in stays: this case is about the switch, and a `workbench` card would
  // queue ahead of the one being driven here
  const { app, page } = await start(env)
  try {
    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-a')
    await expect(card(page, 'worktree')).toBeVisible({ timeout: 30_000 })
    await card(page, 'worktree').locator('button.ob-link', { hasText: 'show tips' }).click()
    await expect(card(page)).toHaveCount(0)
    await expect.poll(() => settingsOnDisk(env).hintsOff, { timeout: 20_000 }).toBe(true)

    // the next trigger says nothing at all
    await startSessionIn(page, 'ws-a')
    await stayAbsent(page)

    // Settings ▸ Welcome ▸ Reset tips re-arms the whole set
    await page.locator('.tb-ico[title="Settings"]').click()
    await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 20_000 })
    await page.locator('.set-ni', { hasText: 'Welcome' }).click()
    await page
      .locator('.settings-modal .set-main .set-row button.mini', { hasText: 'Reset tips' })
      .click()
    await expect.poll(() => settingsOnDisk(env).hintsOff, { timeout: 20_000 }).toBe(false)
    expect(settingsOnDisk(env).hintsSeen).toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 20_000 })

    await startSessionIn(page, 'ws-a')
    await expect(card(page, 'worktree')).toBeVisible({ timeout: 30_000 })
    await snap(page, 'T-HN-05')
  } finally {
    await quitAndClose(app)
  }
})

// ---- T-HN-06 -------------------------------------------------------------------------

test('T-HN-06: Esc and an outside click close a hint, and count it as seen', async ({ env }) => {
  test.setTimeout(240_000)
  const { app, page } = await start(env, { panelOpen: false })
  try {
    await startSessionIn(page, 'ws-a')
    await runIn(page, centerTerm(page), '/write one.md')
    await expect(card(page, 'workbench')).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(card(page)).toHaveCount(0)
    await expect
      .poll(() => settingsOnDisk(env).hintsSeen, { timeout: 20_000 })
      .toEqual(['workbench'])
    expect(settingsOnDisk(env).hintsOff).toBe(false)

    // the other closing gesture, on the next hint the app has to offer
    await startSessionIn(page, 'ws-a')
    await expect(card(page, 'worktree')).toBeVisible({ timeout: 30_000 })
    await centerTerm(page).click()
    await expect(card(page)).toHaveCount(0)
    await expect
      .poll(() => settingsOnDisk(env).hintsSeen, { timeout: 20_000 })
      .toEqual(['workbench', 'worktree'])
    expect(settingsOnDisk(env).hintsOff).toBe(false)
  } finally {
    await quitAndClose(app)
  }
})

// ---- T-HN-07 -------------------------------------------------------------------------

test('T-HN-07: two triggers at once show one card, and the second waits', async ({ env }) => {
  test.setTimeout(240_000)
  // `worktree` is seeded seen so the second launch cannot put a third card in the queue
  const { app, page } = await start(env, { hintsSeen: ['worktree'] })
  try {
    await startSessionIn(page, 'ws-a')
    const a = await shownTabId(page)
    await startSessionIn(page, 'ws-a')
    const b = await shownTabId(page)

    // B is on screen; shut its panel so a write of its own earns the `workbench` hint
    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T1')

    // both triggers inside the same beat: B writes a file, A turns amber behind it
    await runIn(page, centerTerm(page), '/write both.md')
    await typeInto(page, a, '/need-approval')

    // both really happened — otherwise "one at a time" would be measuring one trigger
    await expect(page.locator(rowSel(a))).toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
    await expect(centerTerm(page)).toContainText('wrote both.md', { timeout: 30_000 })
    await expect(card(page)).toHaveCount(1, { timeout: 30_000 })
    // which of the two the pump reached first is a race between a hook and the jsonl
    // poll, and the requirement is not about the order — it is that only ONE is up
    const first = await card(page).getAttribute('data-hint')
    expect(['workbench', 'approval']).toContain(first)
    const second = first === 'workbench' ? 'approval' : 'workbench'
    await snap(page, 'T-HN-07')

    const dismissed = Date.now()
    await card(page).locator('button.mini', { hasText: 'Got it' }).click()
    await expect(card(page)).toHaveCount(0)
    // the queued one holds back rather than reading as an interruption
    await expect(card(page, second)).toBeVisible({ timeout: 30_000 })
    expect(Date.now() - dismissed).toBeGreaterThanOrEqual(1900)
    // …and it never pulled the user off the session they were in
    expect(await shownTabId(page)).toBe(b)
  } finally {
    await quitAndClose(app)
  }
})

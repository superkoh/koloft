import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { setGithubFixture } from './helpers/env'
import type { E2EEnv } from './helpers/env'
import { hostResolverSwitch } from './helpers/fixtureServer'
import {
  centerTerm,
  gitInit,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { newWebTab, openBrowser } from './helpers/browser'
import { WORKBENCH, waitPanelAttached, wbTabs } from './helpers/workbench'

/**
 * Workbench · the GitHub button.
 *
 * One read-only button at the left end of the tab strip: a number means this branch's
 * pull request, no number means the repository. Everything it opens is an ORDINARY web
 * tab, and the button itself is outside the tab model entirely — that last part is what
 * G7 is about, and what keeps the cap, the drag-reorder and `layout.json` unaware of it.
 *
 * Two things are staged, both for the same reason — the real feature reaches github.com,
 * and a test may not:
 *  - `setGithubFixture` answers for the lookup, so no `git ls-remote` runs;
 *  - github.com is pinned at the loopback, so the page the button opens fails to load
 *    instead of leaving this machine. The oracle is the ADDRESS the panel chose, which is
 *    on the tab (its `title`) whether the page loaded or not.
 */

const REPO = { owner: 'acme', repo: 'widgets', branch: 'feature/login', pr: 265 }
const REPO_URL = 'https://github.com/acme/widgets'
const PR_URL = `${REPO_URL}/pull/265`
const PULLS_URL = `${REPO_URL}/pulls`

const ghButton = (page: Page): ReturnType<Page['locator']> => page.locator('.wb-gh')

/**
 * Launch with the fixture in place. Both seams travel in the LAUNCH ENV, so every case
 * here takes `env` alone and never the `app` fixture — asking for `app` would start the
 * standard app just to close it again (the `hostResolverSwitch` precedent in
 * browser-internalization.spec.ts).
 *
 * `ws-a` is the GitHub project; `ws-b` is deliberately absent from the map, which is how
 * "not a GitHub project" is expressed.
 */
async function startWithGithub(
  env: E2EEnv,
  ws = 'ws-a',
  extra: Record<string, { owner: string; repo: string; branch?: string; pr?: number }> = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  setGithubFixture(env, { [env.workspaces.a]: REPO, ...extra })
  env.extraArgs.push(hostResolverSwitch(['github.com']))
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  await startSessionIn(page, ws)
  await waitPanelAttached(page)
  await openBrowser(page)
  return { app, page }
}

/** every open tab's target, which for a `web` tab is its url */
function tabTargets(page: Page): Promise<(string | null)[]> {
  return wbTabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('title')))
}

// G1 — the button is not a permanent piece of chrome. Outside a github.com project there
// is nothing to open, so there is nothing to click on either.
test('G1: a workspace that is not a GitHub project gets no button', async ({ env }) => {
  test.setTimeout(240_000)
  const started = await startWithGithub(env, 'ws-b')
  try {
    await expect(wbTabs(started.page).first()).toBeVisible({ timeout: 20_000 })
    await expect(ghButton(started.page)).toHaveCount(0)
  } finally {
    await started.app.close().catch(() => {})
  }
})

// G2 — where it sits. Right of the pinned Files tab and LEFT of the divider, i.e. on the
// panel's own side of the fence rather than among the user's tabs.
test('G2: a GitHub project gets a button between Files and the divider', async ({ env }) => {
  test.setTimeout(240_000)
  const { app: a, page } = await startWithGithub(env)
  try {
    const gh = ghButton(page)
    await expect(gh).toBeVisible({ timeout: 30_000 })
    // B2: a number means the pull request
    await expect(gh).toHaveText('#265')
    await expect(gh).toHaveAttribute('aria-label', /Open pull request #265/)

    const order = await page
      .locator(`${WORKBENCH.tabStrip} .wb-pin > *`)
      .evaluateAll((els) => els.map((e) => e.className.split(/\s+/)[0]))
    expect(order[0]).toBe('wb-tab')
    expect(order[1]).toBe('wb-gh')
    await snap(page, 'G2-github-button')
  } finally {
    await a.close().catch(() => {})
  }
})

// G3/G4 (B3, B5, B6) — a click opens the pull request in an ordinary web tab, and a
// second click comes back to that same tab rather than making another.
test('G3/G4: clicking opens the pull request once, and returns to it after that', async ({
  env
}) => {
  test.setTimeout(240_000)
  const { app: a, page } = await startWithGithub(env)
  try {
    await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
    await expect(wbTabs(page)).toHaveCount(1) // the pinned Files tab, alone

    await ghButton(page).click()
    await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })
    await expect.poll(() => tabTargets(page)).toContain(PR_URL)
    await expect(wbTabs(page).nth(1)).toHaveClass(/\bon\b/)

    await ghButton(page).click()
    // FR-15's dedup: same target, same tab. A second tab here would mean the button is
    // minting pages the user never asked for.
    await expect(wbTabs(page)).toHaveCount(2)
    await expect(wbTabs(page).nth(1)).toHaveClass(/\bon\b/)
  } finally {
    await a.close().catch(() => {})
  }
})

// G5 (B4) — the right-click menu. Four items, all read-only; nothing here creates a pull
// request, comments or merges.
test('G5: right-click offers the read-only set, and each item opens its page', async ({ env }) => {
  test.setTimeout(240_000)
  const { app: a, page } = await startWithGithub(env)
  try {
    await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
    await ghButton(page).click({ button: 'right' })

    const menu = page.locator('.wb-ghmenu')
    await expect(menu).toBeVisible()
    expect(await menu.locator('.mi').allInnerTexts()).toEqual([
      'Open repository',
      'Open pull requests',
      'Open pull request #265',
      'Check again'
    ])

    await menu.locator('.mi', { hasText: 'Open pull requests' }).click()
    await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })
    await expect.poll(() => tabTargets(page)).toContain(PULLS_URL)

    // and the repository home is a different page, so it gets a tab of its own
    await ghButton(page).click({ button: 'right' })
    await page.locator('.wb-ghmenu .mi', { hasText: 'Open repository' }).click()
    await expect(wbTabs(page)).toHaveCount(3, { timeout: 20_000 })
    await expect.poll(() => tabTargets(page)).toContain(REPO_URL)
  } finally {
    await a.close().catch(() => {})
  }
})

// G6 (B7) — a full strip scrolls, and the button goes nowhere. This also fixes what was
// already true of the pinned Files tab: past about six tabs it scrolled out of reach.
test('G6: the button stays at the left edge when the strip scrolls', async ({ env }) => {
  test.setTimeout(240_000)
  const { app: a, page } = await startWithGithub(env)
  try {
    await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
    // eight blank tabs. Blank, so nothing is ever fetched, and eight of them is well past
    // what a 560px strip can hold. The ＋ rather than ⌘T: that key is arbitrated by focus,
    // and this case has no business depending on that.
    for (let i = 0; i < 8; i++) await newWebTab(page)
    await expect(wbTabs(page)).toHaveCount(9, { timeout: 20_000 })

    // The trap the sticky group brings with it, and the reason this assertion is here
    // rather than in a drag case: a tab's drop index is its position in the MODEL, and
    // moving Files into `.wb-pin` must not re-base the rest at the slice. Off by one and
    // every drag-reorder lands one slot early — nothing else in the suite would notice,
    // because nothing else drags a tab.
    expect(
      await wbTabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-drop-index')))
    ).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8'])

    const strip = page.locator(WORKBENCH.tabStrip)
    await expect
      .poll(() => strip.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeGreaterThan(0)
    await strip.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })

    const [stripBox, ghBox, filesBox] = await Promise.all([
      strip.boundingBox(),
      ghButton(page).boundingBox(),
      wbTabs(page).first().boundingBox()
    ])
    expect(ghBox).not.toBeNull()
    // still parked against the strip's own left inset, with Files beside it — not merely
    // "somewhere on screen"
    expect(ghBox!.x).toBeGreaterThanOrEqual(stripBox!.x)
    expect(ghBox!.x).toBeLessThan(stripBox!.x + 160)
    expect(filesBox!.x).toBeGreaterThanOrEqual(stripBox!.x)
  } finally {
    await a.close().catch(() => {})
  }
})

// G7 (B11) — it is NOT a tab. It is not counted as one, ⌘W cannot close it, and it is not
// written to layout.json, so nothing about the tab model has to know it exists.
test('G7: the button is not a tab — ⌘W cannot close it and it is never counted', async ({
  env
}) => {
  test.setTimeout(240_000)
  const { app: a, page } = await startWithGithub(env)
  try {
    await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
    await expect(wbTabs(page)).toHaveCount(1)

    await ghButton(page).click()
    await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })

    // ⌘W with the focus on the button itself: it closes the ACTIVE TAB, and the button
    // is still standing afterwards
    await ghButton(page).focus()
    await sendShortcut(a, 'shortcut:close-tab')
    await expect(wbTabs(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(ghButton(page)).toBeVisible()
    // and it cannot be picked up and dropped somewhere in the strip
    await expect(ghButton(page)).not.toHaveAttribute('draggable', 'true')
  } finally {
    await a.close().catch(() => {})
  }
})

// G8 — Claude can move a whole session into another git checkout mid-conversation
// (EnterWorktree), and the panel re-roots itself there. This button is keyed on exactly
// that root, so it has to come along: another worktree is another branch, and so another
// pull request. Nothing in the button's own code knows relocation exists — this case is
// what says the one thing it does know (the root) is enough.
test('G8: the button follows the session into another worktree', async ({ env }) => {
  test.setTimeout(300_000)
  // a real repository, because `/enter-worktree` makes a real worktree in it
  gitInit(env.workspaces.a)
  const wtDir = path.join(env.workspaces.a, '.claude', 'worktrees', 'wt271')
  const { app, page } = await startWithGithub(env, 'ws-a', {
    [wtDir]: { owner: 'acme', repo: 'widgets', branch: 'wt271', pr: 412 }
  })
  try {
    await expect(ghButton(page)).toHaveText('#265', { timeout: 30_000 })

    await runIn(page, centerTerm(page), '/enter-worktree wt271')
    // the number is the new checkout's, and the click that follows goes to ITS pull request
    await expect(ghButton(page)).toHaveText('#412', { timeout: 60_000 })
    await ghButton(page).click()
    await expect
      .poll(() => tabTargets(page), { timeout: 20_000 })
      .toContain('https://github.com/acme/widgets/pull/412')

    // …and back out again, without leaving the worktree's number behind
    await runIn(page, centerTerm(page), '/exit-worktree')
    await expect(ghButton(page)).toHaveText('#265', { timeout: 60_000 })
  } finally {
    await app.close().catch(() => {})
  }
})

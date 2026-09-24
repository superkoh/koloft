import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import {
  centerTerm,
  gitCommitAll,
  gitInit,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  artifactBody,
  countGitSpawns,
  installGitSpawnLog,
  openFileTab,
  waitGitQuiet,
  WORKBENCH
} from './helpers/workbench'
import { openTabs, pinnedTab } from './helpers/browser'
import type { E2EEnv } from './helpers/env'

function committedRepo(dir: string): void {
  gitInit(dir)
  gitCommitAll(dir)
}

const MINIMAL_EVEN_UNRENDERABLE_PDF = '%PDF-1.4\n%%EOF\n'

const SCROLL_RESTORE_GIVE_UP_SETTLE_MS = 5_000

const numberedLines = (n: number): string =>
  Array.from({ length: n }, (_, i) => String(i + 1)).join('\n') + '\n'

function artifactTitle(page: Page): Locator {
  return page.locator(WORKBENCH.artifactTitle)
}

function viewSegment(page: Page): Locator {
  return page.locator(WORKBENCH.viewSeg).locator('button')
}

function activeView(page: Page): Locator {
  return page.locator(WORKBENCH.viewSegOn)
}

async function openArtifact(page: Page, env: E2EEnv, rel: string): Promise<void> {
  await openFileTab(page, env, path.join(env.workspaces.a, rel))
  await expect(artifactTitle(page)).toHaveText(rel, { timeout: 30_000 })
}

async function relaunchWithGitLog(
  app: ElectronApplication,
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  await app.close().catch(() => {})
  installGitSpawnLog(env)
  const next = await launchApp(env)
  const page = await next.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app: next, page }
}

test.describe('artifact rendering in a Workbench `file` tab, driven through the real UI', () => {
  test('WB-R01 + WB-R02: a markdown file opens on its Rendered view even when it has a diff, under a header of path, change letter, ±N, view segment, ↻ and ≡ (R2)', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    committedRepo(env.workspaces.a)
    fs.appendFileSync(path.join(env.workspaces.a, 'README.md'), '\nmore alpha content\n')

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openArtifact(page, env, 'README.md')

    await expect(artifactBody(page).locator('.md-body')).toContainText('koloft-e2e-alpha', {
      timeout: 15_000
    })
    await expect(artifactBody(page).locator('.idiff')).toHaveCount(0)

    const bar = page.locator(WORKBENCH.kindBar)
    await expect(bar.locator('.ft-gbadge')).toHaveText('M', { timeout: 20_000 })
    await expect(bar.locator('.ft-delta .add')).toContainText('+')
    await expect(viewSegment(page)).toHaveText(['Rendered', 'Diff', 'Source'])
    await expect(activeView(page)).toHaveText('Rendered')
    await expect(page.locator(WORKBENCH.reload)).toBeVisible()
    await expect(page.locator(WORKBENCH.outline)).toBeVisible()

    await viewSegment(page).nth(1).click()
    await expect(artifactBody(page).locator('.idiff')).toBeVisible({ timeout: 15_000 })
    await expect(artifactBody(page).locator('.md-body')).toHaveCount(0)
    await expect(activeView(page)).toHaveText('Diff')

    await viewSegment(page).nth(2).click()
    await expect(artifactBody(page).locator('.code-body')).toBeVisible({ timeout: 15_000 })
    await expect(artifactBody(page).locator('.idiff')).toHaveCount(0)
    await expect(activeView(page)).toHaveText('Source')
  })

  test('WB-R01: a changed code file opens on Diff as the whole file with its changes inline, and code never offers Rendered (R3)', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    committedRepo(env.workspaces.a)
    fs.writeFileSync(
      path.join(env.workspaces.a, 'src', 'app.ts'),
      'export const answer = 43\nexport const added = true\n'
    )

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openArtifact(page, env, 'src/app.ts')

    const idiff = artifactBody(page).locator('.idiff')
    await expect(idiff).toBeVisible({ timeout: 15_000 })
    await expect(viewSegment(page)).toHaveText(['Diff', 'Source'])
    await expect(activeView(page)).toHaveText('Diff')
    await expect(idiff.locator('.idiff-del')).toContainText('42')
    await expect(idiff.locator('.idiff-add', { hasText: 'answer = 43' })).toBeVisible()
    await expect(idiff.locator('.idiff-add', { hasText: 'added = true' })).toBeVisible()
  })

  test('WB-R01: an unchanged code file opens on Source, with Diff kept in the segment but disabled so the control never moves under the pointer (R3b)', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    committedRepo(env.workspaces.a)

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openArtifact(page, env, 'src/app.ts')

    await expect(artifactBody(page).locator('.code-body')).toContainText('answer', {
      timeout: 15_000
    })
    await expect(viewSegment(page)).toHaveText(['Diff', 'Source'])
    await expect(activeView(page)).toHaveText('Source')
    await expect(viewSegment(page).nth(0)).toBeDisabled()
    await expect(artifactBody(page).locator('.idiff')).toHaveCount(0)
    await expect(page.locator(`${WORKBENCH.kindBar} .ft-gbadge`)).toHaveCount(0)
    await expect(page.locator(`${WORKBENCH.kindBar} .ft-delta`)).toHaveCount(0)
    await expect(page.locator(WORKBENCH.reload)).toBeVisible()
  })

  test('a file tab’s default view is chosen once per file and only falls back: a code file read on Source stays on Source when an agent first edits it, and Diff is merely offered', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    committedRepo(env.workspaces.a)

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openArtifact(page, env, 'src/app.ts')

    const codeBody = artifactBody(page).locator('.code-body')
    await expect(codeBody).toContainText('answer', { timeout: 15_000 })
    await expect(activeView(page)).toHaveText('Source')
    await expect(viewSegment(page).nth(0)).toBeDisabled()

    fs.appendFileSync(
      path.join(env.workspaces.a, 'src', 'app.ts'),
      'export const editedByAgent = true\n'
    )
    await expect(codeBody).toContainText('editedByAgent', { timeout: 10_000 })
    await expect(viewSegment(page).nth(0)).toBeEnabled({ timeout: 20_000 })
    await expect(page.locator(`${WORKBENCH.kindBar} .ft-gbadge`)).toHaveText('M', {
      timeout: 20_000
    })

    await expect(activeView(page)).toHaveText('Source')
    await expect(codeBody).toBeVisible()
    await expect(artifactBody(page).locator('.idiff')).toHaveCount(0)
  })

  test('a diff refetch that parses to no change while Changes still lists the file keeps the last good diff on screen: an untracked file caught at zero bytes by a `cat >` rewrite stays on Diff', async ({
    app,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    committedRepo(ws)
    const fresh = path.join(ws, 'src', 'fresh.ts')
    fs.writeFileSync(fresh, 'export const freshMarker = 1\n')
    const fullDiffsOfFresh = (): number =>
      countGitSpawns(env, {
        root: ws,
        subcommand: 'diff',
        argv: (argv) =>
          argv.includes('--no-index') &&
          argv.includes('-U1000000000') &&
          argv.includes('src/fresh.ts')
      })

    const relaunched = await relaunchWithGitLog(app, env)
    const page = relaunched.page
    try {
      await startSessionIn(page, 'ws-a')
      await openArtifact(page, env, 'src/fresh.ts')

      const lastGoodDiff = artifactBody(page).locator('.idiff .idiff-add', {
        hasText: 'freshMarker'
      })
      const badge = page.locator(`${WORKBENCH.kindBar} .ft-gbadge`)
      await expect(activeView(page)).toHaveText('Diff', { timeout: 20_000 })
      await expect(lastGoodDiff).toBeVisible()
      await expect(badge).toHaveText('U', { timeout: 20_000 })
      await waitGitQuiet(env, { root: ws })

      const before = fullDiffsOfFresh()
      fs.truncateSync(fresh, 0)
      await expect.poll(fullDiffsOfFresh, { timeout: 30_000 }).toBeGreaterThan(before)
      await waitGitQuiet(env, { root: ws })

      await expect(badge).toHaveText('U')
      await expect(activeView(page)).toHaveText('Diff')
      await expect(viewSegment(page).nth(0)).toBeEnabled()
      await expect(lastGoodDiff).toBeVisible()
    } finally {
      await relaunched.app.close().catch(() => {})
    }
  })

  test('an artifact survives switching to another tab and back, scroll position intact; a session round trip keeps its document and its scroll (R1)', async ({
    page,
    env
  }) => {
    test.setTimeout(150_000)
    fs.writeFileSync(path.join(env.workspaces.a, 'long.txt'), numberedLines(400))

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openArtifact(page, env, 'long.txt')

    const codeBody = artifactBody(page).locator('.code-body')
    await expect(codeBody).toBeVisible({ timeout: 15_000 })
    await codeBody.evaluate((el) => {
      el.scrollTop = 1200
    })
    await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)

    await pinnedTab(page).click()
    await expect(codeBody).toBeHidden()

    await openTabs(page).first().click()
    await expect(artifactTitle(page)).toHaveText('long.txt', { timeout: 15_000 })
    await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)

    await startSessionIn(page, 'ws-b')
    await expect(page.locator(WORKBENCH.artifact)).toHaveCount(0)

    await wsRows(page, 'ws-a').first().click()
    await expect(artifactTitle(page)).toHaveText('long.txt', { timeout: 20_000 })
    await expect(artifactBody(page).locator('.code-body')).toContainText('400', { timeout: 20_000 })
    await expect
      .poll(
        () =>
          artifactBody(page)
            .locator('.code-body')
            .evaluate((el) => el.scrollTop),
        {
          timeout: 20_000
        }
      )
      .toBe(1200)
  })

  test('a file that got shorter while its session was off screen comes back as far down as it now goes, and a later reload leaves the scroll where the user put it (R1)', async ({
    page,
    env
  }) => {
    test.setTimeout(150_000)
    const long = path.join(env.workspaces.a, 'long.txt')
    fs.writeFileSync(long, numberedLines(400))

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openArtifact(page, env, 'long.txt')

    const codeBody = artifactBody(page).locator('.code-body')
    await expect(codeBody).toBeVisible({ timeout: 15_000 })
    await codeBody.evaluate((el) => {
      el.scrollTop = 1200
    })
    await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)

    await startSessionIn(page, 'ws-b')
    await expect(page.locator(WORKBENCH.artifact)).toHaveCount(0)
    fs.writeFileSync(long, numberedLines(80))

    await wsRows(page, 'ws-a').first().click()
    await expect(artifactTitle(page)).toHaveText('long.txt', { timeout: 20_000 })
    await expect(codeBody).toContainText('80', { timeout: 20_000 })
    const bottom = await codeBody.evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(bottom, 'the shorter file still scrolls, only not as far as before').toBeGreaterThan(0)
    expect(bottom).toBeLessThan(1200)
    await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(bottom)

    await page.waitForTimeout(SCROLL_RESTORE_GIVE_UP_SETTLE_MS)
    await codeBody.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(0)
    fs.appendFileSync(long, 'tail-marker-e2e\n')
    await expect(codeBody).toContainText('tail-marker-e2e', { timeout: 10_000 })
    expect(await codeBody.evaluate((el) => el.scrollTop)).toBe(0)
  })

  test('WB-R04: a markdown artifact auto-refreshes when the file changes on disk (R4)', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openArtifact(page, env, 'README.md')

    const mdBody = artifactBody(page).locator('.md-body')
    await expect(mdBody).toContainText('koloft-e2e-alpha', { timeout: 15_000 })
    await expect(page.locator(WORKBENCH.reload)).toBeVisible()

    fs.appendFileSync(path.join(env.workspaces.a, 'README.md'), 'freshline-koloft-e2e\n')
    await expect(mdBody).toContainText('freshline-koloft-e2e', { timeout: 10_000 })
  })

  test('WB-R04: a code artifact auto-refreshes in place, scroll position intact (R5)', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const long = path.join(env.workspaces.a, 'long.txt')
    fs.writeFileSync(long, numberedLines(400))

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openArtifact(page, env, 'long.txt')

    const codeBody = artifactBody(page).locator('.code-body')
    await expect(codeBody).toBeVisible({ timeout: 15_000 })
    await codeBody.evaluate((el) => {
      el.scrollTop = 1200
    })
    await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)

    fs.appendFileSync(long, 'tail-marker-e2e\n')
    await expect(codeBody).toContainText('tail-marker-e2e', { timeout: 10_000 })
    await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)
  })

  test('WB-R05: a pdf never auto-reloads, since a reload loses its page position — a notice offers Reload / Dismiss, and so does ↻ (R6)', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const pdfPath = path.join(env.workspaces.a, 'tiny.pdf')
    fs.writeFileSync(pdfPath, MINIMAL_EVEN_UNRENDERABLE_PDF)

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openArtifact(page, env, 'tiny.pdf')

    await expect(page.locator(WORKBENCH.viewSeg)).toHaveCount(0)
    const notice = artifactBody(page).locator('.fp-stale')
    await expect(notice).toHaveCount(0)

    fs.appendFileSync(pdfPath, 'x')
    await expect(notice).toBeVisible({ timeout: 10_000 })
    await runIn(page, centerTerm(page), 'ping')
    await expect(centerTerm(page)).toContainText('handled: ping', { timeout: 30_000 })
    await expect(notice).toBeVisible()

    await notice.locator('.fp-stale-btn').click()
    await expect(notice).toHaveCount(0)

    fs.appendFileSync(pdfPath, 'y')
    await expect(notice).toBeVisible({ timeout: 10_000 })
    await notice.locator('.fp-stale-x').click()
    await expect(notice).toHaveCount(0)

    fs.appendFileSync(pdfPath, 'z')
    await expect(notice).toBeVisible({ timeout: 10_000 })
    await page.locator(WORKBENCH.reload).click()
    await expect(notice).toHaveCount(0)
  })
})

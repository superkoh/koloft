import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { E2EEnv } from './helpers/env'
import { centerTerm, runIn, startSessionIn, termIds, waitBooted, waitForCalls } from './helpers/p1'
import { LINE42_MARKER, seedOutsideDir, setupChangeFixture } from './helpers/filesFixture'
import {
  WORKBENCH,
  activeKind,
  openInBrowse,
  seedScratchpad,
  showBrowse,
  wbActiveTab,
  wbTabs,
  workbenchPanel
} from './helpers/workbench'
import { guestByUrl, openTabs } from './helpers/browser'

function row(page: Page, abs: string, section = 'tree'): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${section}"] .ft-node[data-path="${abs}"]`)
}

function section(page: Page, name: string): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${name}"]`)
}

function fileRows(page: Page, name: string): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${name}"] .ft-node.ft-file`)
}

function halfBtn(page: Page, name: 'Changes' | 'Browse'): Locator {
  return page.locator('.wb-bar .seg[aria-label="Files view"] button', { hasText: name })
}

const searchToggle = (page: Page): Locator =>
  page.locator('.wb-bar .icobtn[aria-label="Search files"]')
const searchInput = (page: Page): Locator => page.locator('.wb-panel .ft-search-input')
const searchMode = (page: Page, mode: 'name' | 'content'): Locator =>
  page.locator(`.wb-panel .ft-mode-btn[data-mode="${mode}"]`)

const portalledCtxMenu = (page: Page): Locator => page.locator('.ft-ctx[role="menu"]')
const ctxItems = (page: Page): Locator => page.locator('.ft-ctx .ft-ctx-it')

const readingTitle = (page: Page): Locator => page.locator(WORKBENCH.readingTitle)
const readingBody = (page: Page): Locator => page.locator(WORKBENCH.readingBody)

async function browseReady(page: Page, root: string): Promise<void> {
  await showBrowse(page)
  await expect(row(page, root)).toBeVisible({ timeout: 30_000 })
  await expect(row(page, `${root}/src`)).toBeVisible({ timeout: 30_000 })
}

async function expandTo(page: Page, root: string, abs: string): Promise<void> {
  const segs = abs.slice(root.length + 1).split('/')
  let dir = root
  for (const seg of segs.slice(0, -1)) {
    dir += '/' + seg
    const r = row(page, dir)
    await expect(r).toBeVisible({ timeout: 20_000 })
    if (!(await r.getAttribute('class'))?.split(/\s+/).includes('open')) await r.click()
    await expect(r).toHaveClass(/\bopen\b/, { timeout: 20_000 })
  }
}

async function rowInsideScrollingTreeBody(page: Page, abs: string): Promise<boolean> {
  return page.evaluate((p) => {
    const body = document.querySelector('.wb-panel .bv-body') as HTMLElement | null
    const el = document.querySelector(
      `.wb-panel .bv-sec[data-section="tree"] .ft-node[data-path="${p}"]`
    ) as HTMLElement | null
    if (!body || !el) return false
    const b = body.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.bottom > b.top && r.top < b.bottom
  }, abs)
}

async function sourceLineInsideArtifactScroller(page: Page, n: number): Promise<boolean> {
  return page.evaluate((line) => {
    const host = document.querySelector('.wb-panel .fv-read .wb-artifact') as HTMLElement | null
    const el = document.querySelectorAll<HTMLElement>('.wb-panel .fv-read .code-body .line')[
      line - 1
    ]
    if (!host || !el) return false
    const h = host.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.bottom > h.top && r.top < h.bottom
  }, n)
}

async function ttyCursorX(page: Page): Promise<number> {
  const ids = await termIds(page)
  return page.evaluate((id) => {
    const map = (
      window as unknown as {
        __koloftTerms?: Record<string, { buffer: { active: { cursorX: number } } }>
      }
    ).__koloftTerms
    return map?.[id]?.buffer.active.cursorX ?? -1
  }, ids[0])
}

function readIfPresent(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

async function relaunchOnSameUserData(
  app: ElectronApplication,
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  await app.close().catch(() => {})
  const next = await launchApp(env)
  const page = await next.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app: next, page }
}

async function streamAt(page: Page, rel: string): Promise<{ scrollTop: number; blockTop: number }> {
  return page.evaluate((r) => {
    const stream = document.querySelector('.wb-panel .cv-stream') as HTMLElement | null
    const blk = document.querySelector(`.wb-panel .cv-blk[data-path="${r}"]`) as HTMLElement | null
    return { scrollTop: stream?.scrollTop ?? -1, blockTop: blk?.offsetTop ?? -2 }
  }, rel)
}

const CONTENT_SEARCH_HIT_CAP = 300

const AT_SIGN_PLUS_TRAILING_SPACE = 2

const panelOwnedWidthToggle = /^(Full width|Restore)/

test.describe('Workbench files tab: the Browse half — lazy tree, virtual roots, search, decorations, row menu, keyboard and per-workspace memory', () => {
  test('WB-B01: Browse lists one level at a time, hides gitignored and heavy dirs, and a file click shows the file without making a tab', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    const tabsBefore = await wbTabs(page).count()

    await expect(row(page, `${fx.root}/lib`)).toBeVisible()
    await expect(row(page, `${fx.root}/lib/deep`)).toHaveCount(0)
    await expect(row(page, fx.paths.deepDir)).toHaveCount(0)
    await expect(row(page, fx.paths.deepFile)).toHaveCount(0)

    await row(page, `${fx.root}/lib`).click()
    await expect(row(page, `${fx.root}/lib/deep`)).toBeVisible({ timeout: 20_000 })
    await expect(row(page, fx.paths.deepDir)).toHaveCount(0)

    await row(page, `${fx.root}/lib/deep`).click()
    await expect(row(page, fx.paths.deepDir)).toBeVisible({ timeout: 20_000 })
    await row(page, fx.paths.deepDir).click()
    await expect(row(page, fx.paths.deepFile)).toBeVisible({ timeout: 20_000 })

    await expect(
      row(page, fx.paths.ignoredDir),
      'hidden by .gitignore (git check-ignore)'
    ).toHaveCount(0)
    await expect(row(page, fx.paths.heavyDir), 'hidden by fileTree’s HEAVY set').toHaveCount(0)
    await expect(row(page, `${fx.root}/docs`)).toBeVisible()

    await row(page, fx.paths.deepFile).click()
    await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts', { timeout: 25_000 })
    await expect(readingBody(page)).toContainText('beacon_1', { timeout: 25_000 })
    expect(await wbTabs(page).count()).toBe(tabsBefore)
  })

  test('WB-B03: name search lists the file, a content hit opens it scrolled to its line by click or Enter, and empty / truncated results say so', async ({
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    await searchToggle(page).click()
    await expect(searchInput(page)).toBeFocused()

    await searchInput(page).fill('beacon')
    const nameHit = page.locator(`.wb-panel .ft-result[data-path="${fx.paths.deepFile}"]`)
    await expect(nameHit).toBeVisible({ timeout: 20_000 })
    await expect(section(page, 'tree')).toHaveCount(0)

    await searchMode(page, 'content').click()
    await searchInput(page).fill(LINE42_MARKER)
    const contentHit = page.locator(
      `.wb-panel .ft-cresult[data-path="${fx.paths.deepFile}"][data-line="42"]`
    )
    await expect(contentHit).toBeVisible({ timeout: 25_000 })
    await contentHit.click()

    await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts', { timeout: 25_000 })
    await expect
      .poll(() => sourceLineInsideArtifactScroller(page, 42), { timeout: 25_000 })
      .toBe(true)
    expect(await sourceLineInsideArtifactScroller(page, 1)).toBe(false)

    const bulk3 = fx.paths.bulk[2]
    await searchInput(page).fill('part3_800')
    await expect(
      page.locator(`.wb-panel .ft-cresult[data-path="${bulk3}"][data-line="800"]`)
    ).toBeVisible({ timeout: 25_000 })
    await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts')
    await searchInput(page).press('Enter')
    await expect(readingTitle(page)).toHaveText('bulk/part-3.ts', { timeout: 25_000 })
    await expect
      .poll(() => sourceLineInsideArtifactScroller(page, 800), { timeout: 25_000 })
      .toBe(true)
    expect(await sourceLineInsideArtifactScroller(page, 1)).toBe(false)

    await searchInput(page).fill('koloft-e2e-no-such-token-anywhere')
    await expect(page.locator('.wb-panel .bv-nomatch')).toHaveText('No matches', {
      timeout: 20_000
    })

    await searchInput(page).fill('export const part')
    const truncated = page.locator('.wb-panel .bv-truncated')
    await expect(truncated).toBeVisible({ timeout: 30_000 })
    await expect(truncated).toHaveText('Showing the first 300 — narrow the query.')
    await expect(page.locator('.wb-panel .ft-cresult')).toHaveCount(CONTENT_SEARCH_HIT_CAP)
  })

  test('WB-B04: ⌗ Scratchpad and ↗ Outside carry A7’s allowlist, de-duplication, tasks blackout and missing-dir rule', async ({
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const outside = seedOutsideDir(env)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const call = (await waitForCalls(env, 1))[0]
    const scratch = seedScratchpad(env, call.cwd, call.sessionId)

    const scratchWritten = `${scratch.dir}/from-agent.md`
    const controlDir = path.join(path.dirname(scratch.siblingTasksDir), 'control')
    const siblingControl = path.join(controlDir, 'sibling-control.md')
    const writtenFirstMustNotShowUp = [outside.ts, scratch.siblingTasksFile]
    const writtenAfterSoTheirRowsAreTheBarrier = [
      siblingControl,
      outside.md,
      outside.html,
      outside.png,
      scratchWritten
    ]
    for (const abs of [...writtenFirstMustNotShowUp, ...writtenAfterSoTheirRowsAreTheBarrier]) {
      await runIn(page, centerTerm(page), `/write ${abs}`)
    }

    await expect
      .poll(() => writtenFirstMustNotShowUp.map((p) => readIfPresent(p)), {
        timeout: 30_000
      })
      .toEqual([
        expect.stringContaining('Written mid-turn'),
        expect.stringContaining('Written mid-turn')
      ])

    await browseReady(page, fx.root)

    await expect(section(page, 'scratchpad')).toBeVisible({ timeout: 30_000 })
    await expect(section(page, 'scratchpad').locator('.ft-scratchpad')).toContainText('Scratchpad')
    await expect(section(page, 'outside')).toBeVisible({ timeout: 30_000 })
    await expect(section(page, 'outside').locator('.ft-external')).toContainText('Outside')

    for (const p of [scratch.md, scratch.png, scratch.ts, scratchWritten]) {
      await expect(row(page, p, 'scratchpad')).toBeVisible({ timeout: 30_000 })
    }

    for (const p of [outside.md, outside.html, outside.png, siblingControl]) {
      await expect(row(page, p, 'outside')).toBeVisible({ timeout: 30_000 })
    }
    await expect(row(page, outside.ts, 'outside')).toHaveCount(0)
    await expect(row(page, scratchWritten, 'outside')).toHaveCount(0)

    await row(page, outside.md, 'outside').click({ timeout: 30_000 })
    await expect(readingBody(page)).toContainText(path.basename(outside.md), { timeout: 30_000 })

    // CC§2
    await expect(page.locator(`.wb-panel .ft-node[data-path="${scratch.tasksDir}"]`)).toHaveCount(0)
    await expect(page.locator(`.wb-panel .ft-node[data-path="${scratch.tasksFile}"]`)).toHaveCount(
      0
    )
    await expect(
      page.locator(`.wb-panel .ft-node[data-path="${scratch.siblingTasksDir}"]`)
    ).toHaveCount(0)
    await expect(
      page.locator(`.wb-panel .ft-node[data-path="${scratch.siblingTasksFile}"]`)
    ).toHaveCount(0)

    outside.remove()
    fs.rmSync(controlDir, { recursive: true, force: true })
    await expect(section(page, 'outside')).toHaveCount(0, { timeout: 40_000 })
    await expect(page.locator('.wb-panel .ft-external', { hasText: 'Outside' })).toHaveCount(0)
    await expect(section(page, 'scratchpad')).toBeVisible()
  })

  test('WB-B05: a written gitignored file is forced visible, and status / ±N / pulse / dir marks paint', async ({
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    fx.editTracked(fx.paths.changeable[0])
    fx.modifyMarkdown()
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const ignoredWrite = `${fx.paths.ignoredDir}/agent-note.txt`
    await runIn(page, centerTerm(page), `/write ${fx.rel(ignoredWrite)}`)
    await expect(centerTerm(page)).toContainText('wrote secrets/agent-note.txt', {
      timeout: 30_000
    })

    await browseReady(page, fx.root)

    const forcedDir = row(page, fx.paths.ignoredDir)
    await expect(forcedDir).toBeVisible({ timeout: 30_000 })
    await expect(forcedDir).toHaveAttribute('data-forced', '1')
    const forcedFile = row(page, ignoredWrite)
    await expect(forcedFile).toBeVisible()
    await expect(forcedFile).toHaveAttribute('data-forced', '1')

    await expandTo(page, fx.root, fx.paths.changeable[0])
    const changed = row(page, fx.paths.changeable[0])
    await expect(changed.locator('.ft-gbadge.git-modified')).toHaveText('M', { timeout: 30_000 })
    await expect(changed.locator('.ft-name')).toHaveClass(/\bgit-modified\b/)
    await expect(changed.locator('.ft-delta .add')).toHaveText('+1')
    await expect(changed.locator('.ft-delta .del')).toHaveText('−1')

    const docsRow = row(page, `${fx.root}/docs`)
    await expect(docsRow).toHaveClass(/\bhas-changes\b/, { timeout: 30_000 })
    await expect(docsRow.locator('.bv-dot')).toBeVisible()

    const pulsing = fx.paths.changeable[1]
    await runIn(page, centerTerm(page), `/write ${fx.rel(pulsing)}`)
    await expect(row(page, pulsing).locator('.ft-pulse')).toBeVisible({ timeout: 10_000 })
    await expect(row(page, pulsing)).toHaveClass(/\blive\b/)

    await expect(centerTerm(page)).toContainText(`wrote ${fx.rel(pulsing)}`, { timeout: 30_000 })
    await expect(row(page, `${fx.root}/src`).locator('.ft-dir-agg')).toContainText('●', {
      timeout: 30_000
    })
  })

  test('WB-B06: arrows expand/collapse/select, a bookmark marks the row, expansion survives a restart, and an opened file is revealed', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    await searchToggle(page).click()
    await expect(searchInput(page)).toBeFocused()
    await searchToggle(page).click()
    await expect(page.locator('.wb-panel .bv-body')).toBeFocused({ timeout: 10_000 })

    const keyTo = async (abs: string): Promise<void> => {
      for (let i = 0; i < 60; i++) {
        if (
          await row(page, abs)
            .evaluate((el) => el.classList.contains('kbd-focus'))
            .catch(() => false)
        )
          return
        await page.keyboard.press('ArrowDown')
      }
      await expect(row(page, abs)).toHaveClass(/\bkbd-focus\b/)
    }

    await keyTo(`${fx.root}/lib`)
    await page.keyboard.press('ArrowRight')
    await expect(row(page, `${fx.root}/lib`)).toHaveClass(/\bopen\b/)
    await expect(row(page, `${fx.root}/lib/deep`)).toBeVisible({ timeout: 20_000 })

    await keyTo(`${fx.root}/lib/deep`)
    await page.keyboard.press('ArrowRight')
    await expect(row(page, fx.paths.deepDir)).toBeVisible({ timeout: 20_000 })
    await page.keyboard.press('ArrowLeft')
    await expect(row(page, `${fx.root}/lib/deep`)).not.toHaveClass(/\bopen\b/)
    await expect(row(page, fx.paths.deepDir)).toHaveCount(0)
    await page.keyboard.press('ArrowRight')
    await expect(row(page, fx.paths.deepDir)).toBeVisible({ timeout: 20_000 })

    await keyTo(fx.paths.deepDir)
    await page.keyboard.press('ArrowRight')
    await keyTo(fx.paths.deepFile)
    await page.keyboard.press('Enter')
    await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts', { timeout: 25_000 })

    await row(page, fx.paths.deepFile).click({ button: 'right' })
    await portalledCtxMenu(page).getByText('Add bookmark', { exact: true }).click()
    await expect(row(page, fx.paths.deepFile).locator('.bv-bm')).toBeVisible()
    await expect(row(page, fx.paths.deepFile, 'bookmarks')).toBeVisible()

    const restarted = await relaunchOnSameUserData(app, env)
    await startSessionIn(restarted.page, 'ws-a')
    await expect(workbenchPanel(restarted.page)).toBeVisible({ timeout: 25_000 })
    await browseReady(restarted.page, fx.root)
    await expect(row(restarted.page, fx.paths.deepDir)).toBeVisible({ timeout: 30_000 })
    await expect(row(restarted.page, fx.paths.deepFile)).toBeVisible()
    await expect(row(restarted.page, fx.paths.deepFile, 'bookmarks')).toBeVisible()

    await expandTo(restarted.page, fx.root, fx.paths.deepFile)
    await row(restarted.page, fx.paths.deepDir).click()
    await expect(row(restarted.page, fx.paths.deepFile)).toHaveCount(0)

    await searchToggle(restarted.page).click()
    await searchInput(restarted.page).fill('beacon')
    await restarted.page
      .locator(`.wb-panel .ft-result[data-path="${fx.paths.deepFile}"]`)
      .click({ timeout: 25_000 })
    await expect(readingTitle(restarted.page)).toHaveText('lib/deep/nested/beacon.ts', {
      timeout: 25_000
    })
    await searchToggle(restarted.page).click()

    const revealed = row(restarted.page, fx.paths.deepFile)
    await expect(revealed).toBeVisible({ timeout: 25_000 })
    await expect(revealed).toHaveClass(/\bactive\b/)
    await expect
      .poll(() => rowInsideScrollingTreeBody(restarted.page, fx.paths.deepFile), {
        timeout: 15_000
      })
      .toBe(true)

    await restarted.app.close().catch(() => {})
  })

  test('WB-B07: Recents caps at 12, moves a reopened file to the front, and never records an agent open even though it lands in the reading area', async ({
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(240_000)
    const fx = setupChangeFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    const opened = [
      ...fx.paths.changeable,
      fx.paths.deletable,
      fx.paths.renameSource,
      fx.paths.conflictFile,
      fx.paths.agentTs,
      fx.paths.agentTsB,
      `${fx.root}/src/app.ts`
    ]
    expect(opened).toHaveLength(13)

    await expandTo(page, fx.root, opened[0])
    for (const abs of opened) {
      await row(page, abs).click()
      await expect(readingTitle(page)).toHaveText(`src/${abs.slice(abs.lastIndexOf('/') + 1)}`, {
        timeout: 25_000
      })
    }

    const recents = fileRows(page, 'recents')
    await expect(recents).toHaveCount(12, { timeout: 20_000 })
    await expect(row(page, opened[0], 'recents')).toHaveCount(0)
    await expect(recents.first()).toHaveAttribute('data-path', opened[12])

    await row(page, opened[1]).click()
    await expect(readingTitle(page)).toHaveText('src/change-2.ts', { timeout: 25_000 })
    await expect(recents.first()).toHaveAttribute('data-path', opened[1])
    await expect(recents).toHaveCount(12)
    await expect(row(page, opened[1], 'recents')).toHaveCount(1)

    await runIn(page, centerTerm(page), '/open README.koloft.md')
    await expect(centerTerm(page)).toContainText('opened README.koloft.md', { timeout: 30_000 })
    await expect(readingTitle(page)).toHaveText('README.koloft.md', { timeout: 25_000 })
    await expect(recents).toHaveCount(12)
    await expect(row(page, `${fx.root}/README.koloft.md`, 'recents')).toHaveCount(0)
    await expect(recents.first()).toHaveAttribute('data-path', opened[1])
  })

  test('WB-B08: the row menu is the same from Browse and Changes, and @ injection writes a trailing space without submitting', async ({
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(3)
    fx.modifyHtml()
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    await expandTo(page, fx.root, fx.paths.html)
    await row(page, fx.paths.html).click({ button: 'right' })
    await expect(portalledCtxMenu(page)).toBeVisible()
    expect(await ctxItems(page).allTextContents()).toEqual([
      'Edit',
      'Open',
      'View source',
      'Reveal in Finder',
      'Open with default app',
      'Copy path',
      'Copy relative path',
      'Add bookmark',
      '@ Inject into terminal'
    ])
    await page.keyboard.press('Escape')
    await expect(portalledCtxMenu(page)).toHaveCount(0)

    await halfBtn(page, 'Changes').click()
    const changesRow = page.locator(
      `.wb-panel .cv-row[data-path="${fx.rel(fx.paths.changeable[0])}"]`
    )
    await expect(changesRow).toBeVisible({ timeout: 30_000 })
    await changesRow.click({ button: 'right' })
    await expect(portalledCtxMenu(page)).toBeVisible()
    expect(await ctxItems(page).allTextContents()).toEqual([
      'Edit',
      'Open',
      'Reveal in Finder',
      'Open with default app',
      'Copy path',
      'Copy relative path',
      'Add bookmark',
      '@ Inject into terminal'
    ])

    const rel = fx.rel(fx.paths.changeable[0])
    const before = await ttyCursorX(page)
    expect(before).toBeGreaterThanOrEqual(0)
    await portalledCtxMenu(page).getByText('@ Inject into terminal', { exact: true }).click()
    await expect(centerTerm(page)).toContainText(`@${rel}`, { timeout: 20_000 })
    await expect
      .poll(() => ttyCursorX(page), { timeout: 20_000 })
      .toBe(before + rel.length + AT_SIGN_PLUS_TRAILING_SPACE)
    await expect(centerTerm(page)).not.toContainText('handled:')
  })

  test('WB-B09: Browse’s reading area and a split-off file tab carry the same header controls, in the same order', async ({
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyMarkdown()
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    const controlsOf = async (scope: Locator): Promise<string[]> => {
      const views = await scope.locator('.seg[aria-label="View mode"] button').allTextContents()
      const icons = await scope
        .locator('.icobtn[aria-label]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
      return [...views.map((v) => v.trim()), ...icons.filter((l) => !panelOwnedWidthToggle.test(l))]
    }

    await expandTo(page, fx.root, fx.paths.markdown)
    await row(page, fx.paths.markdown).click()

    const reading = page.locator('.wb-panel .fv-artifact-hd')
    await expect(reading.locator('.wb-title')).toHaveText('docs/guide.md', { timeout: 25_000 })
    await expect(reading.locator('.ft-gbadge.git-modified')).toHaveText('M')
    await expect(reading.locator('.ft-delta')).toBeVisible()
    await expect(reading.locator('.seg[aria-label="View mode"] button')).toHaveCount(3, {
      timeout: 25_000
    })
    const readingControls = await controlsOf(reading)

    await halfBtn(page, 'Changes').click()
    const block = page.locator(`.wb-panel .cv-blk[data-path="${fx.rel(fx.paths.markdown)}"]`)
    await expect(block).toBeVisible({ timeout: 30_000 })
    await block.locator('.cv-split').click()
    await expect.poll(() => activeKind(page), { timeout: 25_000 }).toBe('file')

    const kindBar = page.locator('.wb-panel > .wb-bar')
    await expect(kindBar.locator('.wb-title')).toHaveText('docs/guide.md', { timeout: 25_000 })
    await expect(kindBar.locator('.ft-gbadge.git-modified')).toHaveText('M')
    await expect(kindBar.locator('.ft-delta')).toBeVisible()
    await expect(kindBar.locator('.seg[aria-label="View mode"] button')).toHaveCount(3, {
      timeout: 25_000
    })

    expect(await controlsOf(kindBar)).toEqual(readingControls)
    expect(readingControls).toEqual(['Rendered', 'Diff', 'Source', 'Reload', 'Edit', 'Outline'])
  })

  test('FR-31: the reading area’s header drops the directory before the file name, tail first', async ({
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const long = fx.addUntracked('docs/release-notes-september.md')
    await startSessionIn(page, 'ws-a')
    await openInBrowse(page, long)

    const title = page.locator(WORKBENCH.readingTitle)
    await expect(title).toContainText('release-notes-september.md', { timeout: 25_000 })

    const gutter = page.locator('.center-row .gutter-v').last()
    const box = (await gutter.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 2000, box.y + box.height / 2)
    await page.mouse.up()

    const shape = await page.evaluate((sel) => {
      const hd = document.querySelector(sel)!.parentElement!
      const nm = hd.querySelector('.nm') as HTMLElement
      const dir = hd.querySelector('.dir') as HTMLElement
      const text = [...nm.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text
      const range = document.createRange()
      range.setStart(text, text.data.length - '.md'.length)
      range.setEnd(text, text.data.length)
      const tail = range.getBoundingClientRect()
      const nmBox = nm.getBoundingClientRect()
      return {
        dirIsGone: dir.getBoundingClientRect().width === 0,
        nameIsCut: nm.scrollWidth > nm.clientWidth,
        tailInside: tail.left >= nmBox.left - 1 && tail.right <= nmBox.right + 1,
        clearOfControls: nmBox.right <= hd.querySelector('.ft-gbadge')!.getBoundingClientRect().left
      }
    }, WORKBENCH.readingTitle)
    expect(shape).toEqual({
      dirIsGone: true,
      nameIsCut: true,
      tailInside: true,
      clearOfControls: true
    })
  })

  test('WB-P06: Browse expansion and Recents come back per workspace root after a relaunch, and a fresh workspace inherits neither', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    await expandTo(page, fx.root, fx.paths.deepFile)
    await row(page, fx.paths.deepFile).click()
    await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts', { timeout: 25_000 })
    await row(page, fx.paths.readme).click()
    await expect(readingTitle(page)).toHaveText('README.koloft.md', { timeout: 25_000 })
    await expect(fileRows(page, 'recents')).toHaveCount(2)

    const restarted = await relaunchOnSameUserData(app, env)

    await startSessionIn(restarted.page, 'ws-a')
    await expect(workbenchPanel(restarted.page)).toBeVisible({ timeout: 25_000 })
    await browseReady(restarted.page, fx.root)
    await expect(row(restarted.page, fx.paths.deepFile)).toBeVisible({ timeout: 30_000 })
    const restoredRecents = fileRows(restarted.page, 'recents')
    await expect(restoredRecents).toHaveCount(2, { timeout: 20_000 })
    await expect(restoredRecents.first()).toHaveAttribute('data-path', fx.paths.readme)
    await expect(restoredRecents.nth(1)).toHaveAttribute('data-path', fx.paths.deepFile)

    await startSessionIn(restarted.page, 'ws-b')
    await expect(workbenchPanel(restarted.page)).toBeVisible({ timeout: 25_000 })
    await showBrowse(restarted.page)
    const rootB = env.workspaces.b
    await expect(row(restarted.page, rootB)).toBeVisible({ timeout: 30_000 })
    await expect(section(restarted.page, 'recents')).toHaveCount(0)
    await expect(
      restarted.page.locator('.wb-panel .bv-sec[data-section="tree"] .ft-node.ft-dir.open')
    ).toHaveCount(1)
    await expect(
      restarted.page.locator(`.wb-panel .ft-node[data-path="${fx.paths.deepFile}"]`)
    ).toHaveCount(0)

    await restarted.app.close().catch(() => {})
  })

  test('WB-R09: .html and .htm open a web tab from Browse, never from a Changes row; every other file opens none', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyHtml()
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    await expandTo(page, fx.root, fx.paths.html)
    await expect(openTabs(page)).toHaveCount(0)

    await row(page, fx.paths.html).click()
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    await expect.poll(() => activeKind(page), { timeout: 25_000 }).toBe('web')
    await expect(wbActiveTab(page)).toHaveAttribute('title', new RegExp('report\\.html$'))
    const htmlGuest = await guestByUrl(app, /report\.html$/, { timeout: 30_000 })
    await expect(htmlGuest.locator('h1')).toHaveText(/^koloft-e2e-report-html/, { timeout: 20_000 })
    await expect(readingTitle(page)).toHaveCount(0)

    await showBrowse(page)
    await row(page, fx.paths.htm).click()
    await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
    await expect.poll(() => activeKind(page), { timeout: 25_000 }).toBe('web')
    await expect(wbActiveTab(page)).toHaveAttribute('title', new RegExp('report\\.htm$'))
    const htmGuest = await guestByUrl(app, /report\.htm$/, { timeout: 30_000 })
    await expect(htmGuest.locator('h1')).toHaveText('koloft-e2e-report-htm', { timeout: 20_000 })
    await expect(readingTitle(page)).toHaveCount(0)

    await showBrowse(page)
    await expandTo(page, fx.root, fx.paths.changeable[0])
    await row(page, fx.paths.changeable[0]).click()
    await expect(readingTitle(page)).toHaveText('src/change-1.ts', { timeout: 25_000 })
    await expect(openTabs(page)).toHaveCount(2)
    expect(await activeKind(page)).toBe('files')

    await halfBtn(page, 'Changes').click()
    const changesRow = page.locator(`.wb-panel .cv-row[data-path="${fx.rel(fx.paths.html)}"]`)
    await expect(changesRow).toBeVisible({ timeout: 30_000 })
    await changesRow.click()
    await expect(changesRow).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    expect(await activeKind(page)).toBe('files')
    await expect(openTabs(page)).toHaveCount(2)
  })

  test('WB-R13: the files backlink out of a Changes-opened web tab activates the pinned tab and scrolls the stream to that file’s block', async ({
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(7)
    fx.modifyMarkdown()
    fx.modifyHtml()
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const htmlRel = fx.rel(fx.paths.html)
    const parkRel = fx.rel(fx.paths.changeable[6])
    await expect(page.locator(`.wb-panel .cv-row[data-path="${parkRel}"]`)).toBeVisible({
      timeout: 40_000
    })
    await page.locator(`.wb-panel .cv-row[data-path="${parkRel}"]`).click()
    await expect(page.locator(`.wb-panel .cv-row[data-path="${parkRel}"]`)).toHaveClass(
      /\bactive\b/
    )
    await expect.poll(async () => (await streamAt(page, parkRel)).scrollTop).toBeGreaterThan(0)

    await page.locator(`.wb-panel .cv-blk[data-path="${htmlRel}"] .cv-split`).click()
    await expect.poll(() => activeKind(page), { timeout: 30_000 }).toBe('web')

    const parked = await streamAt(page, htmlRel)
    expect(parked.scrollTop).not.toBe(parked.blockTop)

    const backlink = page.locator('.wb-panel .wb-backlink button')
    await expect(backlink).toBeVisible({ timeout: 20_000 })
    await backlink.click()

    await expect(page.locator(WORKBENCH.tabFiles)).toHaveClass(/\bon\b/, { timeout: 20_000 })
    await expect(page.locator('.wb-panel .fv')).toHaveAttribute('data-view', 'changes')
    await expect(page.locator(`.wb-panel .cv-row[data-path="${htmlRel}"]`)).toHaveClass(
      /\bactive\b/,
      {
        timeout: 20_000
      }
    )
    await expect
      .poll(
        async () => {
          const at = await streamAt(page, htmlRel)
          return Math.abs(at.scrollTop - at.blockTop)
        },
        { timeout: 20_000 }
      )
      .toBeLessThanOrEqual(2)
  })
})

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  centerTerm,
  clickAppMenuItem,
  runIn,
  sendShortcut,
  setNextSessionTitle,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { setupChangeFixture, seedBrowseTree } from './helpers/filesFixture'
import {
  WORKBENCH,
  WORKBENCH_GIT,
  countGitSpawns,
  installGitSpawnLog,
  installStallingGit,
  isAggregateDiff,
  layoutState,
  openFileTab,
  openInBrowse,
  seedWorkbenchDefault,
  showBrowse,
  waitGitQuiet,
  wbTabs,
  workbenchIcon,
  workbenchPanel
} from './helpers/workbench'

const CV = {
  row: '.wb-panel .cv-row',
  stream: '.wb-panel .cv-stream',
  block: '.wb-panel .cv-blk',
  blockSeg: '.seg[aria-label="Block view"]',
  expand: '.cv-exp',
  hunk: '.cv-hunk',
  diffRow: '.idiff-row',
  token: '.idiff-code > span',
  special: '.cv-special',
  total: '.wb-panel .cv-total',
  banner: '.cv-banner',
  empty: '.wb-panel .cv-empty'
} as const

const badge = (page: Page): Locator => page.locator('.wb-tab.pinned .cnt')
const reloadBtn = (page: Page): Locator => page.locator('.wb-bar .icobtn[aria-label="Reload"]')
const baseBtn = (page: Page): Locator =>
  page.locator('.wb-bar .seg button', { hasText: /^(base|vs HEAD) ▾$/ })
const filterBtn = (page: Page): Locator =>
  page.locator('.wb-bar .seg button', { hasText: 'Filter' })
const filesMenu = (page: Page): Locator => page.locator('.wb-bar .fv-menu')

const rows = (page: Page): Locator => page.locator(CV.row)
const blocks = (page: Page): Locator => page.locator(CV.block)
const rowOf = (page: Page, rel: string): Locator => page.locator(`${CV.row}[data-path="${rel}"]`)
const blockOf = (page: Page, rel: string): Locator =>
  page.locator(`${CV.block}[data-path="${rel}"]`)
const stream = (page: Page): Locator => page.locator(CV.stream)

async function shownPaths(page: Page): Promise<string[]> {
  return (await rows(page).evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.path ?? '')
  )) as string[]
}

async function showChanges(page: Page): Promise<void> {
  const panel = workbenchPanel(page)
  if (!(await panel.isVisible())) {
    await workbenchIcon(page).click()
    await expect(panel).toBeVisible({ timeout: 20_000 })
  }
  const pinned = page.locator(WORKBENCH.tabFiles)
  if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()
  const changes = page
    .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
    .filter({ hasText: 'Changes' })
  await expect(changes).toBeVisible({ timeout: 20_000 })
  if ((await changes.getAttribute('aria-pressed')) !== 'true') await changes.click()
  await expect(page.locator(`${WORKBENCH.panel} .fv`)).toHaveAttribute('data-view', 'changes', {
    timeout: 20_000
  })
}

const transientBlockNotesIncludingTheSettledLookingOne = /^(Loading…|No diff available\.)$/

async function waitStream(page: Page, n: number, timeout = 30_000): Promise<void> {
  await expect(rows(page)).toHaveCount(n, { timeout })
  await expect(page.locator(`${CV.block}:not([data-ready="1"])`)).toHaveCount(0, { timeout })
  await expect(
    page.locator('.wb-panel .cv-note', {
      hasText: transientBlockNotesIncludingTheSettledLookingOne
    })
  ).toHaveCount(0, { timeout })
}

async function activeView(page: Page): Promise<string | null> {
  const fv = page.locator(`${WORKBENCH.panel} .fv`)
  return (await fv.count()) === 0 ? null : fv.first().getAttribute('data-view')
}

const scrollTop = (page: Page): Promise<number> => stream(page).evaluate((el) => el.scrollTop)

function blockTop(page: Page, rel: string): Promise<number> {
  return blockOf(page, rel).evaluate((el) => (el as HTMLElement).offsetTop)
}

async function pickChip(
  page: Page,
  group: 'Status' | 'Ownership' | 'Type',
  chip: string
): Promise<void> {
  const target = page.locator(
    `.fv-filters .fv-fgroup[aria-label="${group}"] .ft-chip[data-chip="${chip}"]`
  )
  if ((await filesMenu(page).count()) === 0) await filterBtn(page).click()
  await expect(filesMenu(page)).toBeVisible()
  await target.click()
  await expect(target).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(filesMenu(page)).toHaveCount(0)
}

async function openChanges(page: Page, ws = 'ws-a'): Promise<void> {
  await startSessionIn(page, ws)
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await showChanges(page)
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

test.describe('Workbench files tab: the Changes half — one diff stream beside a file list', () => {
  test('WB-C01: clicking a row scrolls the stream to its anchor, mints no tab, and leaves every other block mounted as the same DOM node', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(5)
    await openChanges(page)
    await waitStream(page, 5)

    const tabsBefore = await wbTabs(page).count()
    expect(await shownPaths(page)).toEqual([
      'src/change-1.ts',
      'src/change-2.ts',
      'src/change-3.ts',
      'src/change-4.ts',
      'src/change-5.ts'
    ])

    await page.evaluate(() => {
      const el = document.querySelector('.cv-blk[data-path="src/change-3.ts"]') as
        (HTMLElement & { __koloftProbe?: string }) | null
      if (el) el.__koloftProbe = 'block-3'
    })
    expect(await blockOf(page, 'src/change-3.ts').locator(CV.diffRow).count()).toBeGreaterThan(0)

    await rowOf(page, 'src/change-4.ts').click()

    const want4 = await blockTop(page, 'src/change-4.ts')
    await expect
      .poll(async () => {
        const [top, max] = await stream(page).evaluate((el) => [
          el.scrollTop,
          el.scrollHeight - el.clientHeight
        ])
        return top === Math.min(want4, max)
      })
      .toBe(true)
    expect(await scrollTop(page)).toBeGreaterThan(0)
    expect(await wbTabs(page).count()).toBe(tabsBefore)

    await stream(page).evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(blockOf(page, 'src/change-3.ts').locator(CV.diffRow).first()).toBeVisible()
    const survived = await page.evaluate(
      () =>
        (
          document.querySelector('.cv-blk[data-path="src/change-3.ts"]') as
            (HTMLElement & { __koloftProbe?: string }) | null
        )?.__koloftProbe ?? null
    )
    expect(survived).toBe('block-3')
  })

  test('WB-C02: a changed .md is diff-only in the stream, and ↗ splits it out as Rendered', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyMarkdown()
    await openChanges(page)
    await waitStream(page, 1)

    const blk = blockOf(page, 'docs/guide.md')
    await expect(blk.locator(CV.diffRow).first()).toBeVisible()
    expect(await blk.locator('.md-body').count()).toBe(0)
    expect(await blk.locator('.wb-artifact').count()).toBe(0)

    const seg = blk.locator(CV.blockSeg)
    expect(await seg.locator('button').allTextContents()).toEqual(['Diff', 'Source', '↗ New tab'])

    const tabsBefore = await wbTabs(page).count()
    await seg.locator('button', { hasText: '↗ New tab' }).click()
    await expect(wbTabs(page)).toHaveCount(tabsBefore + 1)
    await expect(page.locator(WORKBENCH.viewSegOn)).toHaveText('Rendered', { timeout: 20_000 })
  })

  test('WB-C03: ⤢ expands one file to full context, leaves the others alone, and ↻ collapses it', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    await openChanges(page)
    await waitStream(page, 2)

    const x = blockOf(page, 'src/change-1.ts')
    const y = blockOf(page, 'src/change-2.ts')
    const compactX = await x.locator(CV.diffRow).count()
    const compactY = await y.locator(CV.diffRow).count()
    const rowCeilingAtGitDefaultContextFor40LineFile = 12
    const rowFloorAtFullContextFor40LineFile = 30
    expect(compactX).toBeLessThan(rowCeilingAtGitDefaultContextFor40LineFile)
    expect(compactY).toBeLessThan(rowCeilingAtGitDefaultContextFor40LineFile)

    await x.locator(CV.expand).click()
    await expect(x.locator(CV.expand)).toHaveAttribute('aria-pressed', 'true')
    await expect
      .poll(() => x.locator(CV.diffRow).count())
      .toBeGreaterThan(rowFloorAtFullContextFor40LineFile)
    expect(await y.locator(CV.diffRow).count()).toBe(compactY)

    await reloadBtn(page).click()
    await expect.poll(() => x.locator(CV.diffRow).count(), { timeout: 20_000 }).toBe(compactX)
    await expect(x.locator(CV.expand)).toHaveAttribute('aria-pressed', 'false')
    expect(await y.locator(CV.diffRow).count()).toBe(compactY)
  })

  test('WB-C04: merge-base lists the committed and the uncommitted change; vs HEAD lists only the uncommitted', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    const fb = fx.featureBranch()
    expect(fx.rel(fb.committed)).toBe('src/change-1.ts')
    expect(fx.rel(fb.uncommitted)).toBe('src/change-2.ts')

    await openChanges(page)
    await waitStream(page, 2)
    await expect(baseBtn(page)).toHaveText(/^base ▾$/)
    expect(await shownPaths(page)).toEqual(['src/change-1.ts', 'src/change-2.ts'])

    await baseBtn(page).click()
    await filesMenu(page).getByRole('menuitemradio', { name: 'vs HEAD' }).click()
    await expect(baseBtn(page)).toHaveText(/^vs HEAD ▾$/)

    await waitStream(page, 1)
    expect(await shownPaths(page)).toEqual(['src/change-2.ts'])
    await expect(blockOf(page, 'src/change-2.ts').locator(CV.diffRow).first()).toBeVisible()
  })

  test('WB-C06: the three filter groups AND together, and Docs is markdown + html', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    const mixed = fx.mixedOwnershipSet()

    await openChanges(page)
    await runIn(page, centerTerm(page), `/write ${mixed.agentTsRel}`)
    await runIn(page, centerTerm(page), `/write ${mixed.agentMdRel}`)
    await showChanges(page)
    await waitStream(page, 4)
    expect(await shownPaths(page)).toEqual([
      'docs/agent-notes.md',
      'src/agent-notes.ts',
      'src/change-1.ts',
      'src/legacy.ts'
    ])
    expect(fx.rel(mixed.external)).toBe('src/change-1.ts')
    expect(fx.rel(mixed.deleted)).toBe('src/legacy.ts')

    await pickChip(page, 'Ownership', 'session')
    await expect
      .poll(() => shownPaths(page), { timeout: 30_000 })
      .toEqual(['docs/agent-notes.md', 'src/agent-notes.ts'])

    await pickChip(page, 'Type', 'docs')
    await expect.poll(() => shownPaths(page)).toEqual(['docs/agent-notes.md'])

    await pickChip(page, 'Ownership', 'all')
    await pickChip(page, 'Type', 'all')
    await expect.poll(() => shownPaths(page)).toHaveLength(4)

    await pickChip(page, 'Status', 'deleted')
    await expect.poll(() => shownPaths(page)).toEqual(['src/legacy.ts'])
    await filterBtn(page).click()
    await expect(
      page.locator('.fv-fgroup[aria-label="Status"] .ft-chip[data-chip="all"]')
    ).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
  })

  test('WB-C07: rename / binary / deleted / conflict are one summary row each, and only the rename opens', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    const st = fx.specialStates()
    expect(fx.unmergedPaths()).toContain('src/conflict.ts')

    await openChanges(page)
    await waitStream(page, 4)

    const kinds = Object.fromEntries(
      (await blocks(page).evaluateAll((els) =>
        els.map((e) => [(e as HTMLElement).dataset.path, (e as HTMLElement).dataset.kind])
      )) as [string, string][]
    )
    expect(kinds).toEqual({
      'assets/logo.png': 'binary',
      'src/conflict.ts': 'conflict',
      'src/legacy.ts': 'deleted',
      'src/newname.ts': 'renamed'
    })
    expect(fx.rel(st.renamed.to)).toBe('src/newname.ts')
    expect(fx.rel(st.binary)).toBe('assets/logo.png')
    expect(fx.rel(st.deleted)).toBe('src/legacy.ts')
    expect(fx.rel(st.conflicted)).toBe('src/conflict.ts')

    for (const rel of ['assets/logo.png', 'src/conflict.ts', 'src/legacy.ts']) {
      const blk = blockOf(page, rel)
      await expect(blk.locator(CV.special)).toHaveCount(1)
      expect(await blk.locator(CV.diffRow).count()).toBe(0)
      await blk.locator(CV.special).click()
      expect(await blk.locator(CV.diffRow).count()).toBe(0)
    }

    const ren = blockOf(page, 'src/newname.ts')
    await expect(ren.locator('.cv-rename')).toHaveAttribute('aria-expanded', 'false')
    await expect(ren.locator('.cv-rename')).toHaveText(/Renamed from src\/oldname\.ts/)
    expect(await ren.locator(CV.diffRow).count()).toBe(0)
    await ren.locator('.cv-rename').click()
    await expect(ren.locator('.cv-rename')).toHaveAttribute('aria-expanded', 'true')
    const paired = await ren.locator(CV.diffRow).count()
    expect(paired).toBeGreaterThan(0)
    expect(paired, 'an unpaired rename degrades into a whole-file delete plus add').toBeLessThan(20)
  })

  test('WB-C08: untracked and binary rows show a status letter but no ±N', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(1)
    fx.addUntracked()
    fx.changeBinary()

    await openChanges(page)
    await waitStream(page, 3)

    const untracked = rowOf(page, 'src/brand-new.ts')
    const binary = rowOf(page, 'assets/logo.png')
    const tracked = rowOf(page, 'src/change-1.ts')

    await expect(untracked.locator('.ft-gbadge')).toHaveText('U')
    expect(await untracked.locator('.ft-delta').count()).toBe(0)
    await expect(binary.locator('.ft-gbadge')).toHaveText('M')
    expect(await binary.locator('.ft-delta').count()).toBe(0)
    await expect(tracked.locator('.ft-delta .add')).toHaveText('+1')
    await expect(tracked.locator('.ft-delta .del')).toHaveText('−1')
  })

  test('the file list totals the change set, and the total follows the filter', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(3)
    fx.modifyMarkdown()
    fx.addUntracked()

    await openChanges(page)
    await waitStream(page, 5)

    const total = page.locator(CV.total)
    await expect(total.locator('.cv-total-n')).toHaveText('5 files · 1 not counted')
    await expect(total.locator('.ft-delta .add')).toHaveText('+4')
    await expect(total.locator('.ft-delta .del')).toHaveText('−4')
    await expect(total).toHaveAttribute(
      'title',
      '5 files listed · 4 added, 4 removed. 1 of them brings no line count (new, binary, or git gave none).'
    )
    await expect(total).toHaveAttribute('data-partial', '1')

    await pickChip(page, 'Type', 'docs')
    await expect.poll(() => shownPaths(page)).toEqual(['docs/guide.md'])
    await expect(total.locator('.cv-total-n')).toHaveText('1 file')
    await expect(total.locator('.ft-delta .add')).toHaveText('+1')
    await expect(total.locator('.ft-delta .del')).toHaveText('−1')
    await expect(badge(page)).toHaveText('5')
    await expect(total).not.toHaveAttribute('data-partial', '1')

    fx.editTracked(fx.paths.markdown)
    await expect(total.locator('.ft-delta .add')).toHaveText('+2', { timeout: 30_000 })
  })

  test('the change-set summary stays put while the file list scrolls', async ({ page, env }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    const p = fx.paths
    const tracked = [
      ...p.changeable,
      p.markdown,
      p.html,
      p.htm,
      p.agentTs,
      p.agentTsB,
      p.agentMd,
      p.deepFile,
      p.readme,
      p.deletable,
      p.renameSource,
      p.conflictFile,
      p.huge,
      ...p.bulk
    ]
    for (const abs of tracked) fx.editTracked(abs)
    for (let i = 0; i < 4; i++) fx.addUntracked(`src/extra-${i}.ts`)

    await openChanges(page)
    await expect(rows(page)).toHaveCount(tracked.length + 4, { timeout: 60_000 })

    const list = page.locator('.wb-panel .cv-list')
    const total = page.locator(CV.total)
    await expect(total).toBeVisible()
    const room = await list.evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(room).toBeGreaterThan(0)

    const topRoundedPastSubpixelNoise = async (): Promise<number> => {
      const box = await total.boundingBox()
      if (!box)
        throw new Error('the summary header left the screen — it must survive every scroll offset')
      return Math.round(box.y)
    }
    const before = await topRoundedPastSubpixelNoise()
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    expect(await topRoundedPastSubpixelNoise()).toBe(before)
  })

  test('a directory split by its subdirectory leaves no orphaned rows — across a poll, or a session switch', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    fx.addUntracked('src/lib/util.ts')
    fx.addUntracked('src/zz-late.ts')

    await openChanges(page)
    await waitStream(page, 4)

    fx.modifyMarkdown()
    await expect(rowOf(page, 'docs/guide.md')).toHaveCount(1, { timeout: 30_000 })
    expect
      .soft(await shownPaths(page))
      .toEqual([
        'docs/guide.md',
        'src/change-1.ts',
        'src/change-2.ts',
        'src/zz-late.ts',
        'src/lib/util.ts'
      ])

    const fb = setupChangeFixture(env.workspaces.b)
    fb.modifyTracked(1)
    await startSessionIn(page, 'ws-b')
    await showChanges(page)
    await expect.poll(() => shownPaths(page), { timeout: 30_000 }).toEqual(['src/change-1.ts'])
  })

  test('WB-C09: an external write updates one block and the badge without moving the viewport', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(5)

    await openChanges(page)
    await waitStream(page, 5)
    await expect(badge(page)).toHaveText('5')

    await rowOf(page, 'src/change-4.ts').click()
    const anchoredTop = await scrollTop(page)
    expect(anchoredTop).toBeGreaterThan(0)
    const anchorOffset = await blockTop(page, 'src/change-4.ts')

    const y = blockOf(page, 'src/change-5.ts')
    expect(await y.locator(CV.hunk).count()).toBe(1)

    fx.editTracked(fx.paths.changeable[4])
    await expect.poll(() => y.locator(CV.hunk).count(), { timeout: 30_000 }).toBe(2)
    await expect(rowOf(page, 'src/change-5.ts').locator('.ft-delta .add')).toHaveText('+2')
    await expect(rowOf(page, 'src/change-5.ts').locator('.ft-delta .del')).toHaveText('−2')

    expect(await scrollTop(page)).toBe(anchoredTop)
    expect(await blockTop(page, 'src/change-4.ts')).toBe(anchorOffset)

    fx.addUntracked('src/zz-late.ts')
    await expect(badge(page)).toHaveText('6', { timeout: 30_000 })
    await expect(rowOf(page, 'src/zz-late.ts')).toHaveCount(1)
    expect(await scrollTop(page)).toBe(anchoredTop)
  })

  test('WB-C10: the badge counts every change, not the filtered ones, and survives ↻', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(4)
    fx.modifyMarkdown()
    fx.modifyHtml()

    await openChanges(page)
    await waitStream(page, 6)
    await expect(badge(page)).toHaveText('6')

    await pickChip(page, 'Type', 'docs')
    await expect.poll(() => shownPaths(page)).toEqual(['docs/guide.md', 'docs/report.html'])
    await expect(badge(page)).toHaveText('6')

    fx.editTracked(fx.paths.changeable[4])
    await expect(badge(page)).toHaveText('7', { timeout: 30_000 })
    expect(await shownPaths(page)).toEqual(['docs/guide.md', 'docs/report.html'])

    await reloadBtn(page).click()
    await expect(badge(page)).toHaveText('7')
    await expect.poll(() => shownPaths(page)).toEqual(['docs/guide.md', 'docs/report.html'])
    await expect(blockOf(page, 'docs/guide.md').locator(CV.diffRow).first()).toBeVisible()

    await pickChip(page, 'Type', 'all')
    await expect.poll(() => shownPaths(page)).toHaveLength(7)
    await expect(badge(page)).toHaveText('7')
  })

  test('WB-C11: an over-sized change set shows the truncation banner and labels what was cut off', async ({
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(240_000)
    const fx = setupChangeFixture(env.workspaces.a)
    fx.overflowAggregateDiff()
    fx.modifyTracked(1)

    await openChanges(page)
    await expect(rows(page)).toHaveCount(2, { timeout: 180_000 })

    const banner = page.locator(CV.banner)
    await expect(banner).toHaveCount(1, { timeout: 180_000 })
    await expect(banner).toHaveText(/^Change set too large — showing the first \d+ files\.$/)

    const huge = blockOf(page, 'bulk/huge.txt')
    await expect(huge.locator('.cv-bigdiff')).toBeVisible({ timeout: 60_000 })
    await expect(huge.locator(CV.diffRow)).toHaveCount(0)
    await huge.locator('.cv-bigdiff').click()
    await expect(huge.locator(CV.diffRow).first()).toBeVisible({ timeout: 60_000 })
    await expect(blockOf(page, 'src/change-1.ts').locator('.cv-note')).toHaveText(
      'Not shown — the change set was truncated.'
    )
  })

  test('WB-C12: a clean repo shows the empty state with the base and filter controls still usable', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    expect(fx.isClean()).toBe(true)

    await openChanges(page)
    await expect(page.locator(CV.empty)).toHaveText('No changes against the base.', {
      timeout: 30_000
    })
    expect(await rows(page).count()).toBe(0)
    expect(await badge(page).count()).toBe(0)

    await baseBtn(page).click()
    await expect(filesMenu(page)).toBeVisible()
    await filesMenu(page).getByRole('menuitemradio', { name: 'vs HEAD' }).click()
    await expect(baseBtn(page)).toHaveText(/^vs HEAD ▾$/)
    await expect(page.locator(CV.empty)).toHaveText('No changes against the base.')

    await filterBtn(page).click()
    await expect(page.locator('.fv-filters .fv-fgroup')).toHaveCount(3)
    await page.keyboard.press('Escape')
  })

  test('WB-C13: a non-git workspace fails Changes only — no whole-tab placeholder, and Browse still lists and opens files', async ({
    page,
    env
  }) => {
    const paths = seedBrowseTree(env.workspaces.a)
    expect(fs.existsSync(`${env.workspaces.a}/.git`)).toBe(false)

    await openChanges(page)
    await expect(page.locator(CV.empty)).toHaveText('Not a git repository.', { timeout: 30_000 })
    expect(await page.locator('.wb-panel .fv.fv-empty').count()).toBe(0)

    await openInBrowse(page, paths.deepFile)
    await expect(page.locator(WORKBENCH.readingTitle)).toContainText('beacon.ts', {
      timeout: 30_000
    })
    await expect(page.locator(WORKBENCH.readingBody)).toBeVisible()
  })

  test('WB-C14: a deleted worktree shows the placeholder, keeps other tabs readable, and stops polling', async ({
    app,
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    const relaunched = await relaunchWithGitLog(app, env)
    const p = relaunched.page
    try {
      await openChanges(p)
      await waitStream(p, 2)

      await openFileTab(p, env, `${env.workspaces.b}/README.md`)
      await expect(p.locator(`${WORKBENCH.artifact}:visible`)).toContainText('koloft-e2e-bravo', {
        timeout: 30_000
      })
      await p.locator(WORKBENCH.tabFiles).click()

      const errors: string[] = []
      p.on('pageerror', (e) => errors.push(String(e)))

      fs.rmSync(env.workspaces.a, { recursive: true, force: true })

      await expect(p.locator('.wb-panel .fv.fv-empty')).toHaveText(
        'This directory no longer exists.',
        { timeout: 60_000 }
      )
      await p
        .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
        .filter({ hasText: 'Browse' })
        .click()
      await expect(p.locator('.wb-panel .fv.fv-empty')).toHaveText(
        'This directory no longer exists.'
      )

      const quiet = await waitGitQuiet(env, { root: env.workspaces.a })
      await p.waitForTimeout(10_000)
      expect(countGitSpawns(env, { root: env.workspaces.a })).toBe(quiet)
      expect(errors).toEqual([])

      await p.locator(WORKBENCH.tab).filter({ hasText: 'README.md' }).click()
      await expect(p.locator(`${WORKBENCH.artifact}:visible`)).toContainText('koloft-e2e-bravo')
    } finally {
      await relaunched.app.close().catch(() => {})
    }
  })

  test('WB-C15: two sessions on one worktree share the change set and differ only by ownership', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)

    setNextSessionTitle(env, 'Session A')
    await openChanges(page)
    await runIn(page, centerTerm(page), `/write ${fx.rel(fx.paths.agentTs)}`)

    setNextSessionTitle(env, 'Session B')
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await runIn(page, centerTerm(page), `/write ${fx.rel(fx.paths.agentTsB)}`)

    const rowFor = (title: string): Locator =>
      page.locator('.ws-tab').filter({ has: page.locator('.ws-tab-title', { hasText: title }) })
    await expect(rowFor('Session A')).toHaveCount(1, { timeout: 40_000 })
    await expect(rowFor('Session B')).toHaveCount(1, { timeout: 40_000 })
    const rowA = rowFor('Session A')
    const rowB = rowFor('Session B')

    await rowB.click()
    await showChanges(page)
    await expect
      .poll(() => shownPaths(page), { timeout: 30_000 })
      .toEqual(['src/agent-notes-b.ts', 'src/agent-notes.ts'])
    await pickChip(page, 'Ownership', 'session')
    await expect.poll(() => shownPaths(page), { timeout: 30_000 }).toEqual(['src/agent-notes-b.ts'])

    await rowA.click()
    await showChanges(page)
    await expect
      .poll(() => shownPaths(page), { timeout: 30_000 })
      .toEqual(['src/agent-notes-b.ts', 'src/agent-notes.ts'])
    await pickChip(page, 'Ownership', 'session')
    await expect.poll(() => shownPaths(page), { timeout: 30_000 }).toEqual(['src/agent-notes.ts'])
  })

  test('WB-C16: only the blocks that have been scrolled to are syntax-highlighted — an unscrolled block has ZERO tokens, never merely fewer — and nothing is truncated or dropped to afford it', async ({
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    fx.bigChange()

    await openChanges(page)
    await waitStream(page, 6, 60_000)

    const first = blockOf(page, 'bulk/part-1.ts')
    const far = blockOf(page, 'bulk/part-6.ts')

    await expect(first.locator(CV.diffRow).first()).toBeVisible()
    await expect.poll(() => first.locator(CV.token).count(), { timeout: 60_000 }).toBeGreaterThan(0)

    expect(await far.locator(CV.diffRow).count()).toBeGreaterThan(0)
    expect.soft(await far.locator(CV.token).count()).toBe(0)
    expect(await page.locator(CV.banner).count()).toBe(0)
    expect(await page.locator('.wb-panel .idiff-hint').count()).toBe(0)

    const top = await blockTop(page, 'bulk/part-6.ts')
    await stream(page).evaluate((el, y) => {
      el.scrollTop = y
    }, top)
    await expect.poll(() => far.locator(CV.token).count(), { timeout: 60_000 }).toBeGreaterThan(0)
    expect(await first.locator(CV.token).count()).toBeGreaterThan(0)
  })

  test('WB-C17: one Changes refresh resolves the baseline exactly once — also when a file tab watches a changed file — and a no-op directory event reruns no aggregate diff', async ({
    app,
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(3)
    fx.addUntracked()
    const ws = env.workspaces.a

    const relaunched = await relaunchWithGitLog(app, env)
    const p = relaunched.page
    const mergeBases = (): number => countGitSpawns(env, { root: ws, subcommand: 'merge-base' })
    const aggregates = (): number => countGitSpawns(env, { root: ws, argv: isAggregateDiff })
    try {
      await openChanges(p)
      await waitStream(p, 4)
      await expect(blockOf(p, 'src/brand-new.ts').locator(CV.diffRow).first()).toBeVisible({
        timeout: 30_000
      })
      await waitGitQuiet(env, { root: ws })

      let baseBefore = mergeBases()
      let aggBefore = aggregates()
      await reloadBtn(p).click()
      await expect.poll(aggregates, { timeout: 30_000 }).toBe(aggBefore + 1)
      await waitGitQuiet(env, { root: ws })
      expect(mergeBases()).toBe(baseBefore + 1)

      expect(await shownPaths(p)).toEqual([
        'src/brand-new.ts',
        'src/change-1.ts',
        'src/change-2.ts',
        'src/change-3.ts'
      ])
      await expect(rowOf(p, 'src/change-1.ts').locator('.ft-delta .add')).toHaveText('+1')
      await expect(blockOf(p, 'src/change-1.ts').locator(CV.diffRow).first()).toBeVisible()

      await openFileTab(p, env, fx.paths.changeable[0])
      await expect(p.locator(WORKBENCH.viewSegOn)).toHaveText('Diff', { timeout: 30_000 })
      await p.locator(WORKBENCH.tabFiles).click()
      await expect.poll(() => activeView(p), { timeout: 20_000 }).toBe('changes')
      await waitGitQuiet(env, { root: ws })

      baseBefore = mergeBases()
      aggBefore = aggregates()
      fx.editTracked(fx.paths.changeable[0])

      await expect.poll(aggregates, { timeout: 30_000 }).toBe(aggBefore + 1)
      await expect
        .poll(
          () =>
            countGitSpawns(env, {
              root: ws,
              subcommand: 'diff',
              argv: (argv) => argv.includes(fx.paths.changeable[0])
            }),
          { timeout: 30_000 }
        )
        .toBeGreaterThan(0)
      await waitGitQuiet(env, { root: ws })

      expect(mergeBases()).toBe(baseBefore + 1)
      await expect(rowOf(p, 'src/change-1.ts').locator('.ft-delta .add')).toHaveText('+2')

      aggBefore = aggregates()
      const lsBefore = countGitSpawns(env, { root: ws, subcommand: 'ls-files' })
      fs.writeFileSync(fx.paths.changeable[0], fs.readFileSync(fx.paths.changeable[0]))
      await expect
        .poll(() => countGitSpawns(env, { root: ws, subcommand: 'ls-files' }), { timeout: 30_000 })
        .toBeGreaterThan(lsBefore)
      await waitGitQuiet(env, { root: ws })
      expect(aggregates()).toBe(aggBefore)
    } finally {
      await relaunched.app.close().catch(() => {})
    }
  })

  test('WB-R08: ↗ New tab splits the block out with its view and its scroll offset', async ({
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.editTracked(fx.paths.bulk[0])
    fx.modifyTracked(1)
    const subject = 'bulk/part-1.ts'

    await openChanges(page)
    await waitStream(page, 2)

    const blk = blockOf(page, subject)
    const seg = blk.locator(CV.blockSeg)
    await seg.locator('button', { hasText: 'Source' }).click()
    await expect(seg.locator('button[aria-pressed="true"]')).toHaveText('Source')
    await expect(blk.locator('.cv-src')).toBeVisible({ timeout: 20_000 })

    const top = await blockTop(page, subject)
    const offsetIntoBlock = 120
    await stream(page).evaluate((el, y) => {
      el.scrollTop = y
    }, top + offsetIntoBlock)
    expect((await scrollTop(page)) - top).toBe(offsetIntoBlock)

    const hd = await blk.locator('.cv-blk-hd').boundingBox()
    const view = await stream(page).boundingBox()
    const blockHeaderStuckOnScreenWithoutPlaywrightScrollingIt = !!(
      hd &&
      view &&
      hd.y + hd.height > view.y
    )
    expect(blockHeaderStuckOnScreenWithoutPlaywrightScrollingIt).toBe(true)

    const tabsBefore = await wbTabs(page).count()
    await seg.locator('button', { hasText: '↗ New tab' }).click()
    await expect(wbTabs(page)).toHaveCount(tabsBefore + 1)

    await expect(page.locator(WORKBENCH.tabActive)).toContainText('part-1.ts')
    await expect(page.locator(WORKBENCH.viewSegOn)).toHaveText('Source', { timeout: 20_000 })
    await expect
      .poll(
        () =>
          page
            .locator(`${WORKBENCH.artifact}:visible .code-body`)
            .evaluate((el) => (el as HTMLElement).scrollTop),
        { timeout: 20_000 }
      )
      .toBe(offsetIntoBlock)

    await page.locator(WORKBENCH.tabFiles).click()
    await expect(blockOf(page, subject)).toHaveCount(1)
    await expect(blockOf(page, subject).locator('.cv-src')).toBeVisible()
  })

  test('WB-K08: a collapsed panel spawns no git for the workspace, and catches up on expand', async ({
    app,
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    const ws = env.workspaces.a

    const relaunched = await relaunchWithGitLog(app, env)
    const p = relaunched.page
    try {
      await openChanges(p)
      await waitStream(p, 2)

      await clickAppMenuItem(relaunched.app, p, 'toggle-browser')
      await expect.poll(() => layoutState(p)).toBe('T1')
      await waitGitQuiet(env, { root: ws })
      const before = countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })

      fx.addUntracked('src/while-collapsed.ts')
      fx.editTracked(fx.paths.changeable[0])
      await p.waitForTimeout(10_000)

      expect(countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })).toBe(before)

      await clickAppMenuItem(relaunched.app, p, 'toggle-browser')
      await expect.poll(() => layoutState(p)).toBe('T2')
      await showChanges(p)
      await waitStream(p, 3)
      await expect(rowOf(p, 'src/while-collapsed.ts')).toHaveCount(1)
      expect(countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })).toBeGreaterThan(before)
    } finally {
      await relaunched.app.close().catch(() => {})
    }
  })

  test('WB-K08b: a session whose panel starts collapsed spawns no git before main has answered', async ({
    app,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    const ws = env.workspaces.a

    await app.close().catch(() => {})
    seedWorkbenchDefault(env, false)

    const relaunched = await relaunchWithGitLog(app, env)
    const p = relaunched.page
    try {
      await startSessionIn(p, 'ws-a')
      await expect.poll(() => layoutState(p)).toBe('T1')
      await waitGitQuiet(env, { root: ws })
      expect(countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })).toBe(0)

      await clickAppMenuItem(relaunched.app, p, 'toggle-browser')
      await expect.poll(() => layoutState(p)).toBe('T2')
      await showChanges(p)
      await waitStream(p, 2)
      expect(countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })).toBeGreaterThan(0)
    } finally {
      await relaunched.app.close().catch(() => {})
    }
  })

  test('WB-C18: a collapsed panel forgets its change set, so a new session reads afresh', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    await openChanges(page)
    await waitStream(page, 2)

    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect.poll(() => layoutState(page)).toBe('T1')
    await expect(rows(page)).toHaveCount(0)

    fx.commitAll('while collapsed')
    fx.addUntracked('src/next-session.ts')

    await startSessionIn(page, 'ws-a')
    await showChanges(page)
    await waitStream(page, 1)
    expect(await shownPaths(page)).toEqual(['src/next-session.ts'])
  })

  test('the file list drags wider, both halves and a relaunch keep the width, and a clipped name slides under the pointer', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const LONG = 'src/a-very-long-file-name-that-the-column-cannot-show-in-full-at-all.ts'
    fx.addUntracked(LONG)
    await openChanges(page)
    await waitStream(page, 1)

    const width = (loc: Locator): Promise<number> =>
      loc.evaluate((el) => Math.round(el.getBoundingClientRect().width))
    const DEFAULT_LIST_WIDTH_PX = 230
    const READING_COLUMN_MIN_PX = 240
    const DRAG_PX = 60
    const side = page.locator('.wb-panel .cv-side')
    expect(await width(side)).toBe(DEFAULT_LIST_WIDTH_PX)

    const fv = (await page.locator('.wb-panel .fv').boundingBox())!
    const grip = page.locator('.wb-panel .fv-gutter')
    const box = (await grip.boundingBox())!
    const gx = Math.round(box.x + box.width / 2)
    const gy = Math.round(box.y + box.height / 2)
    const want = Math.min(
      Math.round(gx + DRAG_PX - fv.x),
      Math.round(fv.width) - READING_COLUMN_MIN_PX
    )
    await page.mouse.move(gx, gy)
    await page.mouse.down()
    await page.mouse.move(gx + DRAG_PX, gy, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => width(side)).toBe(want)

    await showBrowse(page)
    expect(await width(page.locator('.wb-panel .fv-tree'))).toBe(want)

    await app.close().catch(() => {})
    const next = await launchApp(env)
    const page2 = await next.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await waitBooted(page2)
    await openChanges(page2)
    await waitStream(page2, 1)
    expect(await width(page2.locator('.wb-panel .cv-side'))).toBe(want)

    const name = rowOf(page2, LONG).locator('.ft-name')
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    await rowOf(page2, LONG).hover()
    await expect(name).toHaveClass(/\bfs-slide\b/)
    expect(
      await name.evaluate((el) => parseFloat(el.style.getPropertyValue('--fs-shift')))
    ).toBeLessThan(0)
    await page2.locator('.wb-panel .cv-total').hover()
    await expect(name).not.toHaveClass(/\bfs-slide\b/)

    await next.close().catch(() => {})
  })

  test('the file-list grip starts at the border line, so a press on the list scrollbar’s outer pixels never resizes the column', async ({
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const ENOUGH_ROWS_TO_SCROLL = 40
    for (let i = 0; i < ENOUGH_ROWS_TO_SCROLL; i++) fx.addUntracked(`src/extra-${i}.ts`)
    await openChanges(page)
    await expect(rows(page)).toHaveCount(ENOUGH_ROWS_TO_SCROLL, { timeout: 60_000 })

    const list = page.locator('.wb-panel .cv-list')
    const side = page.locator('.wb-panel .cv-side')
    expect(
      await list.evaluate(
        (el) =>
          el.scrollHeight > el.clientHeight && (el as HTMLElement).offsetWidth > el.clientWidth
      )
    ).toBe(true)
    const listBox = (await list.boundingBox())!
    const grip = (await page.locator('.wb-panel .fv-gutter').boundingBox())!
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(grip.x)

    const sideWidth = (): Promise<number> => side.evaluate((el) => el.getBoundingClientRect().width)
    const before = await sideWidth()
    const x = Math.round(grip.x) - 1
    const y = Math.round(listBox.y + listBox.height - 20)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 40, y, { steps: 4 })
    await page.mouse.up()
    expect(await sideWidth()).toBe(before)
  })

  test('a clipped directory header slides with no ellipsis: while it slides its text-overflow is clip', async ({
    page,
    env
  }) => {
    setupChangeFixture(env.workspaces.a).addUntracked(
      'src/a-directory-name-far-too-long-for-the-file-list-column/and-deeper-still/x.ts'
    )
    await openChanges(page)
    await waitStream(page, 1)

    const header = page.locator('.wb-panel .cv-grp', {
      hasText: 'a-directory-name-far-too-long-for-the-file-list-column'
    })
    expect(await header.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    await header.hover()
    await expect(header).toHaveClass(/\bfs-slide\b/)
    expect(await header.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('clip')
  })

  test('⌘F on the pinned Files tab searches the missing-worktree placeholder that replaced the stream, not the stream it replaced', async ({
    app,
    page,
    env
  }) => {
    setupChangeFixture(env.workspaces.a).modifyTracked(2)
    await openChanges(page)
    await waitStream(page, 2)

    fs.rmSync(env.workspaces.a, { recursive: true, force: true })
    const placeholder = page.locator('.wb-panel .fv.fv-empty')
    await expect(placeholder).toHaveText('This directory no longer exists.', { timeout: 60_000 })

    await placeholder.click()
    await sendShortcut(app, 'shortcut:find')
    const bar = page.locator('.find-bar')
    await expect(bar.locator('.find-input')).toBeFocused()
    await page.keyboard.type('directory')
    await expect(bar.locator('.find-count')).toHaveText('1/1')
  })

  test('a git status/numstat refresh that fails keeps the last good status letters, ±N and badge instead of blanking them', async ({
    app,
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    const hangFromNowOn = path.join(env.home, 'git-status-hangs')
    const hung = path.join(env.home, 'git-status-hung')
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    fs.writeFileSync(
      path.join(env.fakeBin, 'git'),
      `#!/usr/bin/env bash\n` +
        `if [ -e "${hangFromNowOn}" ] && [ "$1" = "-C" ] && [ "$2" = "${fx.root}" ]; then\n` +
        `  case " $* " in\n` +
        `    *" --name-status "*|*" --numstat "*) : > "${hung}"; exec sleep 60 ;;\n` +
        `  esac\n` +
        `fi\n` +
        `exec "${realGit}" "$@"\n`,
      { mode: 0o755 }
    )
    const GIT_KILLED_AFTER_MS = 3000
    env.launchEnv.KOLOFT_GIT_TIMEOUT_MS = String(GIT_KILLED_AFTER_MS)
    await app.close().catch(() => {})
    const next = await launchApp(env)
    try {
      const page = await next.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await openChanges(page)
      await waitStream(page, 2)
      await expect(badge(page)).toHaveText('2')
      await expect(rowOf(page, 'src/change-1.ts').locator('.ft-gbadge')).toHaveText('M')
      const good = await rows(page).allInnerTexts()

      fs.writeFileSync(hangFromNowOn, '')
      await reloadBtn(page).click()
      await expect.poll(() => fs.existsSync(hung), { timeout: 30_000 }).toBe(true)
      await page.waitForTimeout(2 * GIT_KILLED_AFTER_MS)

      expect(await rows(page).allInnerTexts()).toEqual(good)
      await expect(badge(page)).toHaveText('2')
    } finally {
      await next.close().catch(() => {})
    }
  })

  test('the stream keeps saying "Reading the change set…" while the aggregate diff has files but the status rows have not arrived', async ({
    app,
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    const statusAnswered = installStallingGit(env, {
      root: fx.root,
      subcommand: 'ls-files',
      ms: 8000
    })
    await app.close().catch(() => {})
    const next = await launchApp(env)
    try {
      const page = await next.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await openChanges(page)

      const seen = new Set<string>()
      const deadline = Date.now() + 30_000
      while (!fs.existsSync(statusAnswered) && Date.now() < deadline) {
        const shown = await page
          .locator(CV.empty)
          .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))
        for (const s of shown) seen.add(s)
        await page.waitForTimeout(100)
      }
      expect(fs.existsSync(statusAnswered)).toBe(true)
      expect([...seen]).toContain('Reading the change set…')
      expect([...seen]).not.toContain('No changes against the base.')
      await waitStream(page, 2)
    } finally {
      await next.close().catch(() => {})
    }
  })

  test('WB-K08c: switching to a session with a collapsed panel spawns no git for its workspace', async ({
    app,
    env
  }) => {
    test.setTimeout(240_000)
    setupChangeFixture(env.workspaces.a).modifyTracked(1)
    setupChangeFixture(env.workspaces.b).modifyTracked(1)
    const { app: p1app, page } = await relaunchWithGitLog(app, env)
    try {
      setNextSessionTitle(env, 'S1')
      await startSessionIn(page, 'ws-a')
      await showChanges(page)
      await waitStream(page, 1)
      setNextSessionTitle(env, 'S2')
      await startSessionIn(page, 'ws-b')
      if (await workbenchPanel(page).isVisible()) await workbenchIcon(page).click()
      await expect.poll(() => layoutState(page)).toBe('T1')
      await page
        .locator('.ws-tab', { has: page.locator('.ws-tab-title', { hasText: 'S1' }) })
        .click()
      await expect.poll(() => layoutState(page)).toBe('T2')
      await waitStream(page, 1)
      const before = await waitGitQuiet(env, { root: env.workspaces.b })

      await page
        .locator('.ws-tab', { has: page.locator('.ws-tab-title', { hasText: 'S2' }) })
        .click()
      await expect.poll(() => layoutState(page)).toBe('T1')
      await page.waitForTimeout(3000)
      expect(countGitSpawns(env, { root: env.workspaces.b })).toBe(before)
    } finally {
      await p1app.close().catch(() => {})
    }
  })
})

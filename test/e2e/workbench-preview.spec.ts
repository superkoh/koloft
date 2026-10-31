import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  machineHome,
  REMOTE_WS_NAME,
  remoteDir,
  remoteKey
} from './helpers/remote'
import {
  centerTerm,
  ENDED_ROW_NOTE,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  openMenu,
  runIn,
  seedJsonl,
  setWindowWidth,
  shownCenterTerm,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import {
  WORKBENCH,
  layoutState,
  seedWorkbench,
  seedWorkbenchDefault,
  waitPanelAttached,
  wbActiveTab
} from './helpers/workbench'

const card = (page: Page): Locator => page.locator(WORKBENCH.previewCard)
const diffLabel = (page: Page): Locator => page.locator(WORKBENCH.previewDiffLabel)
const docRows = (page: Page): Locator => page.locator(WORKBENCH.previewDocs)
const docNames = (page: Page): Promise<string[]> =>
  docRows(page).locator('.ft-name').allInnerTexts()
const readingView = (page: Page): Locator =>
  page.locator(`${WORKBENCH.panel} .fv-artifact-hd .seg[aria-label="View mode"] .on`)
const CANNED_STARTUP_TURN_WRITES = 'NOTES.md'
const BIND_WELL_AFTER_THE_TERMINAL_SHOWS_MS = 6000
const WINDOW_WHERE_THE_CARD_COSTS_COLUMNS_PX = 1500
const FIT_SETTLE_MS = 500

function recordShownTermEveryFrame(page: Page): Promise<void> {
  return page.evaluate(() => {
    const frames: string[] = []
    const w = window as unknown as {
      __termFrames: string[]
      __stopTermFrames?: boolean
      __koloftTerms?: Record<string, { cols: number; element?: HTMLElement }>
    }
    w.__termFrames = frames
    w.__stopTermFrames = false
    const tick = (): void => {
      const masked = !!document.querySelector('.term-island .empty')
      for (const t of masked ? [] : Object.values(w.__koloftTerms ?? {})) {
        const wrap = t.element?.closest<HTMLElement>('.term-island .term-wrap')
        if (wrap && wrap.style.display !== 'none' && wrap.style.visibility !== 'hidden') {
          const left = Math.round(wrap.querySelector('.term')!.getBoundingClientRect().left)
          const frame = `${t.cols} cols at ${left}px`
          if (frames[frames.length - 1] !== frame) frames.push(frame)
          break
        }
      }
      if (!w.__stopTermFrames) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

function recordedTermFrames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __termFrames: string[]; __stopTermFrames?: boolean }
    w.__stopTermFrames = true
    return w.__termFrames
  })
}

function collapsedWithoutTips(env: E2EEnv): void {
  seedWorkbenchDefault(env, false)
  seedSettings(env, { hintsOff: true })
}

async function launchCollapsed(env: E2EEnv) {
  collapsedWithoutTips(env)
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

test.afterEach(({ env }) => killFakeRemote(env))

test.describe('Workbench preview: the card beside the terminal while the Workbench is collapsed', () => {
  test('WB-P01: lists the Markdown and HTML files the agent wrote, newest first, and opens each where it is read', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(1)
    const { app, page } = await launchCollapsed(env)
    try {
      await startSessionIn(page, 'ws-a')
      await expect.poll(() => layoutState(page)).toBe('T1')
      await expect(diffLabel(page)).toHaveText('1 file')
      await expect.poll(() => docNames(page)).toEqual([CANNED_STARTUP_TURN_WRITES])

      await runIn(page, centerTerm(page), '/write docs/plan.md')
      await expect(docRows(page)).toHaveCount(2, { timeout: 30_000 })
      await runIn(page, centerTerm(page), '/write src/not-a-doc.ts')
      await expect(diffLabel(page)).toHaveText('3 files', { timeout: 30_000 })
      await runIn(page, centerTerm(page), '/write site/mock.html')
      await expect(docRows(page)).toHaveCount(3, { timeout: 30_000 })
      expect(await docNames(page)).toEqual(['mock.html', 'plan.md', CANNED_STARTUP_TURN_WRITES])

      await docRows(page).filter({ hasText: 'plan.md' }).click()
      await expect.poll(() => layoutState(page)).toBe('T2')
      await expect(card(page)).toHaveCount(0)
      await expect(page.locator(`${WORKBENCH.panel} .fv`)).toHaveAttribute('data-view', 'browse')
      await expect(page.locator(WORKBENCH.readingTitle)).toContainText('plan.md')
      await expect(readingView(page)).toHaveText('Rendered')

      await page.locator('.aux-ico.wb-toggle').click()
      await expect.poll(() => layoutState(page)).toBe('T1')
      await docRows(page).filter({ hasText: 'mock.html' }).click()
      await expect.poll(() => layoutState(page)).toBe('T2')
      await expect(wbActiveTab(page)).toHaveAttribute('title', /^file:\/\/.*\/site\/mock\.html$/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('WB-P02: an HTML page the agent opened with koloft open comes up in the Workbench, and once it is collapsed again the page heads the list', async ({
    env
  }) => {
    test.setTimeout(180_000)
    setupChangeFixture(env.workspaces.a)
    fs.writeFileSync(path.join(env.workspaces.a, 'report.html'), '<h1>report</h1>\n')
    const { app, page } = await launchCollapsed(env)
    try {
      await startSessionIn(page, 'ws-a')
      await runIn(page, centerTerm(page), '/write docs/plan.md')
      await expect(docRows(page)).toHaveCount(2, { timeout: 30_000 })
      await runIn(page, centerTerm(page), '/koloft open report.html')
      await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T2')
      await expect(wbActiveTab(page)).toHaveAttribute('title', /report\.html$/)

      await page.locator('.aux-ico.wb-toggle').click()
      await expect.poll(() => layoutState(page)).toBe('T1')
      await expect(docRows(page)).toHaveCount(3, { timeout: 30_000 })
      expect(await docNames(page)).toEqual(['report.html', 'plan.md', CANNED_STARTUP_TURN_WRITES])
    } finally {
      await quitAndClose(app)
    }
  })

  test('WB-P03: a Codex session gets the same card with its total diff', async ({ env }) => {
    test.setTimeout(180_000)
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    installCodex(env)
    const { app, page } = await launchCollapsed(env)
    try {
      await newSessionInWith(page, 'ws-a', 'Codex')
      await waitPanelAttached(page)
      await expect.poll(() => layoutState(page)).toBe('T1')
      await expect(diffLabel(page)).toHaveText('2 files', { timeout: 30_000 })
      await page.locator(WORKBENCH.previewDiff).click()
      await expect.poll(() => layoutState(page)).toBe('T2')
      await expect(page.locator(`${WORKBENCH.panel} .fv`)).toHaveAttribute('data-view', 'changes')
    } finally {
      await quitAndClose(app)
    }
  })

  for (const tab of [
    {
      kind: 'a local Claude Code tab',
      menuItem: 'New session',
      open: async (env: E2EEnv) => {
        fs.writeFileSync(env.claudeDelayFile, String(BIND_WELL_AFTER_THE_TERMINAL_SHOWS_MS))
        return { ...(await launchCollapsed(env)), wsName: 'ws-a' }
      }
    },
    {
      kind: 'a local Codex tab',
      menuItem: 'New Codex session',
      open: async (env: E2EEnv) => {
        installCodex(env)
        fs.writeFileSync(
          path.join(env.home, 'fake-codex-delay'),
          String(BIND_WELL_AFTER_THE_TERMINAL_SHOWS_MS)
        )
        return { ...(await launchCollapsed(env)), wsName: 'ws-a' }
      }
    },
    {
      kind: 'a remote (ssh) Claude Code tab',
      menuItem: 'New session',
      open: async (env: E2EEnv) => {
        collapsedWithoutTips(env)
        const { app, page } = await launchWithRemote(env)
        await addRemoteWorkspace(page, env)
        fs.writeFileSync(
          path.join(machineHome(env), 'fake-claude-delay'),
          String(BIND_WELL_AFTER_THE_TERMINAL_SHOWS_MS)
        )
        return { app, page, wsName: REMOTE_WS_NAME }
      }
    }
  ]) {
    test(`WB-P08: in ${tab.kind}, the card has its place beside the terminal from the start, so binding neither moves the terminal nor costs it columns`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      const { app, page, wsName } = await tab.open(env)
      try {
        await setWindowWidth(app, WINDOW_WHERE_THE_CARD_COSTS_COLUMNS_PX)
        await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
        await page.locator('.menu .mi', { hasText: tab.menuItem }).click()
        await expect.poll(() => shownCenterTerm(page), { timeout: 20_000 }).toBeDefined()
        await expect(page.locator('.terminals > .empty')).toHaveCount(0, { timeout: 20_000 })
        await page.waitForTimeout(FIT_SETTLE_MS)
        await recordShownTermEveryFrame(page)
        await expect(page.locator('.ws .ws-tab.st-pending')).toHaveCount(1)

        await expect(card(page)).toBeVisible({ timeout: 60_000 })
        await page.waitForTimeout(FIT_SETTLE_MS)
        expect(await recordedTermFrames(page)).toHaveLength(1)
      } finally {
        await quitAndClose(app)
      }
    })
  }

  for (const tab of [
    {
      kind: 'a Claude Code session',
      coldRow: async (env: E2EEnv) => {
        const id = seedJsonl(env, env.workspaces.a, { summary: 'Resumed beside the card' })
        seedWorkbench(env, id, { open: false, tabs: [] })
        fs.writeFileSync(env.claudeDelayFile, String(BIND_WELL_AFTER_THE_TERMINAL_SHOWS_MS))
        const { app, page } = await launchCollapsed(env)
        const row = page.locator('.ws .ws-tab', { hasText: 'Resumed beside the card' })
        await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
        return { app, page, row }
      }
    },
    {
      kind: 'a Codex session',
      coldRow: async (env: E2EEnv) => {
        installCodex(env)
        const { app, page } = await launchCollapsed(env)
        await newSessionInWith(page, 'ws-a', 'Codex')
        await waitPanelAttached(page)
        const row = wsRows(page, 'ws-a').first()
        await openMenu(page, row)
        await page.locator('.menu .mi', { hasText: /^Close$/ }).click()
        await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
        fs.writeFileSync(
          path.join(env.home, 'fake-codex-delay'),
          String(BIND_WELL_AFTER_THE_TERMINAL_SHOWS_MS)
        )
        return { app, page, row }
      }
    }
  ]) {
    test(`WB-P10: resuming ${tab.kind} whose Workbench was left collapsed, the terminal shows where it stays once the card shows`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      const { app, page, row } = await tab.coldRow(env)
      try {
        await setWindowWidth(app, WINDOW_WHERE_THE_CARD_COSTS_COLUMNS_PX)
        await page.waitForTimeout(FIT_SETTLE_MS)
        await recordShownTermEveryFrame(page)
        await row.click()

        await expect(card(page)).toBeVisible({ timeout: 60_000 })
        await expect(page.locator('.term-island .empty')).toHaveCount(0)
        await page.waitForTimeout(FIT_SETTLE_MS)
        expect(await recordedTermFrames(page)).toHaveLength(1)
      } finally {
        await quitAndClose(app)
      }
    })
  }

  test('WB-P09: a tab whose agent quits before it binds gives the card’s place back to its terminal', async ({
    env
  }) => {
    test.setTimeout(120_000)
    fs.writeFileSync(env.claudeExitFile, '1')
    const { app, page } = await launchCollapsed(env)
    try {
      await setWindowWidth(app, WINDOW_WHERE_THE_CARD_COSTS_COLUMNS_PX)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'New session' }).click()
      await expect(page.locator('.ws .ws-tab .ws-tab-sub')).toHaveText(ENDED_ROW_NOTE, {
        timeout: 30_000
      })
      await expect(page.locator('.wb-peek-slot')).toHaveCount(0)
      await expect(card(page)).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('WB-P04: a remote (ssh) session lists the docs it wrote on the machine, and opens a page there as a web page', async ({
    env
  }) => {
    test.setTimeout(300_000)
    collapsedWithoutTips(env)
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      fs.writeFileSync(path.join(dir, '.gitignore'), 'NOTES.md\n')
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n')
      gitInit(dir)
      gitCommitAll(dir)
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo\n')

      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await wsRows(page, REMOTE_WS_NAME).first().click()
      await waitPanelAttached(page)
      await expect.poll(() => layoutState(page)).toBe('T1')
      await expect(diffLabel(page)).toHaveText('1 file', { timeout: 60_000 })

      await runIn(page, centerTerm(page), '/write mock.html')
      const mock = docRows(page).filter({ hasText: 'mock.html' })
      await expect(mock).toHaveAttribute('data-path', `${remoteKey(env)}/mock.html`, {
        timeout: 60_000
      })

      await mock.click()
      await expect.poll(() => layoutState(page)).toBe('T2')
      await expect(wbActiveTab(page)).toHaveAttribute(
        'title',
        /^koloft-machine:\/\/m[0-9a-f]+\/.*\/mock\.html$/
      )
    } finally {
      await quitAndClose(app)
    }
  })
})

test.describe('Workbench preview: Assist picks the docs that are for the reader', () => {
  test('WB-P05: a draft the agent wrote to post elsewhere leaves the list, and a doc it only pointed to joins it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    setupChangeFixture(env.workspaces.a)
    const madeByAShell = path.join(env.workspaces.a, 'out', 'summary.md')
    const { app, page } = await launchCollapsed(env)
    try {
      await startSessionIn(page, 'ws-a')
      await expect.poll(() => docNames(page)).toEqual([CANNED_STARTUP_TURN_WRITES])
      await runIn(page, centerTerm(page), '/write docs/draft-pr-body.md')
      await runIn(page, centerTerm(page), '/write docs/plan.md')
      await expect
        .poll(() => docNames(page), { timeout: 30_000 })
        .toEqual(['plan.md', CANNED_STARTUP_TURN_WRITES])

      fs.mkdirSync(path.dirname(madeByAShell), { recursive: true })
      fs.writeFileSync(madeByAShell, '# summary\n')
      await runIn(page, centerTerm(page), `/answer see ${madeByAShell}`)
      await expect
        .poll(() => docNames(page), { timeout: 30_000 })
        .toEqual(['summary.md', 'plan.md', CANNED_STARTUP_TURN_WRITES])
    } finally {
      await quitAndClose(app)
    }
  })

  test('WB-P06: a Codex session lists a doc its reply pointed to', async ({ env }) => {
    test.setTimeout(180_000)
    setupChangeFixture(env.workspaces.a)
    installCodex(env)
    const madeByAShell = path.join(env.workspaces.a, 'out', 'summary.md')
    fs.mkdirSync(path.dirname(madeByAShell), { recursive: true })
    fs.writeFileSync(madeByAShell, '# summary\n')
    const { app, page } = await launchCollapsed(env)
    try {
      await newSessionInWith(page, 'ws-a', 'Codex')
      await waitPanelAttached(page)
      await runIn(page, centerTerm(page), `see ${madeByAShell}`)
      await expect.poll(() => docNames(page), { timeout: 30_000 }).toEqual(['summary.md'])
    } finally {
      await quitAndClose(app)
    }
  })

  test('WB-P07: a remote (ssh) session drops a draft and lists a doc on the machine its reply pointed to', async ({
    env
  }) => {
    test.setTimeout(300_000)
    collapsedWithoutTips(env)
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      fs.writeFileSync(path.join(dir, '.gitignore'), 'NOTES.md\n')
      gitInit(dir)
      gitCommitAll(dir)
      fs.mkdirSync(path.join(dir, 'notes'))
      fs.writeFileSync(path.join(dir, 'notes', 'summary.md'), '# summary\n')

      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await wsRows(page, REMOTE_WS_NAME).first().click()
      await waitPanelAttached(page)
      await runIn(page, centerTerm(page), '/write draft-pr-body.md')
      await runIn(page, centerTerm(page), '/write mock.html')
      await expect(docRows(page).filter({ hasText: 'mock.html' })).toHaveCount(1, {
        timeout: 60_000
      })
      await expect.poll(() => docNames(page), { timeout: 60_000 }).not.toContain('draft-pr-body.md')

      await runIn(page, centerTerm(page), `/answer see ${dir}/notes/summary.md`)
      await expect(docRows(page).filter({ hasText: 'summary.md' })).toHaveAttribute(
        'data-path',
        `${remoteKey(env)}/notes/summary.md`,
        { timeout: 60_000 }
      )
    } finally {
      await quitAndClose(app)
    }
  })
})

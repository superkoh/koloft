import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  REMOTE_WS_NAME,
  remoteDir,
  remoteKey
} from './helpers/remote'
import {
  centerTerm,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import {
  WORKBENCH,
  layoutState,
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

  test('WB-P04: a remote (ssh) session lists the docs it wrote on the machine, and opens a page there as source', async ({
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
      await expect(page.locator(`${WORKBENCH.panel} .fv`)).toHaveAttribute('data-view', 'browse')
      await expect(page.locator(WORKBENCH.readingTitle)).toContainText('mock.html')
      await expect(readingView(page)).toHaveText('Source')
    } finally {
      await quitAndClose(app)
    }
  })
})

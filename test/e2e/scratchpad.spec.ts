import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  centerTerm,
  FAKE_SESSION_TITLE,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  runIn,
  sendShortcut,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { barePath } from '../../src/shared/remoteKey'
import {
  E2E_AGY_ACCOUNT,
  agySessionCalls,
  installAgy,
  installCodex,
  seedSettings,
  trustInAgy
} from './helpers/env'
import { codexAnswers, startCodex, type CodexWireLine } from './helpers/codex'
import {
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  agyReady,
  boundRemoteSession,
  installCodexOnFakeRemote,
  installFakeRemote,
  installRemoteAgy,
  killFakeRemote,
  launchWithRemote,
  machineCodexLog,
  machineHome,
  seedRemoteWorkspace
} from './helpers/remote'
import { openTabs } from './helpers/browser'
import { activeKind, showBrowse, WORKBENCH, workbenchPanel } from './helpers/workbench'
import type { Locator, Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const LONGER_THAN_RELIST_THROTTLE_MS = 1200
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
)

async function tickSessionActivityToRelist(page: Page): Promise<void> {
  await runIn(page, centerTerm(page), 'ping')
}

function scratchpadNode(page: Page): Locator {
  return workbenchPanel(page).locator('.ft-scratchpad')
}

function scratchpadNames(page: Page): Promise<string[]> {
  return workbenchPanel(page)
    .locator('[data-section="scratchpad"] > .ft-children .ft-name')
    .allTextContents()
}

test.describe('the ⌗ Scratchpad node in Browse: Claude’s per-session scratch dir, outside every workspace root', () => {
  test('a file claude drops in its scratchpad with no tool_use behind it is listed in Browse and opens under its absolute path', async ({
    page,
    env
  }) => {
    test.setTimeout(150_000)

    gitInit(env.workspaces.a)
    gitCommitAll(env.workspaces.a)

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
      timeout: 40_000
    })

    await runIn(page, centerTerm(page), '/scratch analysis.py')
    await tickSessionActivityToRelist(page)

    await showBrowse(page)
    const panel = workbenchPanel(page)
    const scratchpad = panel.locator('.ft-scratchpad')
    await expect(scratchpad).toBeVisible({ timeout: 40_000 })
    await expect(scratchpad.locator('.ft-ext-icon')).toHaveText('⌗')
    await expect(scratchpad.locator('.ft-name')).toHaveText('Scratchpad')
    await expect(scratchpad.locator('.ft-dir-agg')).toHaveText('1')

    // CC§2
    const dir = await scratchpad.getAttribute('data-path')
    expect(dir?.startsWith(env.scratchpadBase + path.sep)).toBe(true)
    expect(path.basename(dir!)).toBe('scratchpad')
    expect(fs.existsSync(path.join(dir!, 'analysis.py'))).toBe(true)

    const analysis = page.locator(`${WORKBENCH.browseRows}.ft-file`, { hasText: /analysis\.py/ })
    await expect(analysis).toHaveCount(1)
    await expect(analysis).toBeVisible()

    await analysis.click()
    await expect.poll(() => activeKind(page), { timeout: 15_000 }).toBe('files')
    await expect(openTabs(page)).toHaveCount(0)
    const title = page.locator(WORKBENCH.readingTitle)
    await expect(title).toContainText('analysis.py', { timeout: 15_000 })
    await expect(title.locator('.dir')).toHaveText(`${dir}/`)
    await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft_e2e_scratch_body', {
      timeout: 15_000
    })
  })

  test('a session that has written nothing to its scratchpad shows no Scratchpad node, even after a re-list', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
      timeout: 40_000
    })

    await showBrowse(page)
    const panel = workbenchPanel(page)
    await expect(
      page.locator(`${WORKBENCH.browseRows}.ft-file`, { hasText: /NOTES\.md/ })
    ).toHaveCount(1, {
      timeout: 40_000
    })
    await expect(panel.locator('.ft-scratchpad')).toHaveCount(0)

    await tickSessionActivityToRelist(page)
    await expect(centerTerm(page)).toContainText('handled: ping', { timeout: 30_000 })
    await page.waitForTimeout(LONGER_THAN_RELIST_THROTTLE_MS)
    await expect(panel.locator('.ft-scratchpad')).toHaveCount(0)
  })
})

test.describe('the same ⌗ Scratchpad node for the other agents: the folder outside the workspace where the agent keeps what it made for this session', () => {
  test.setTimeout(240_000)
  test.afterEach(({ env }) => killFakeRemote(env))

  // CODEX§12
  test('a Codex tab lists the images Codex saved for its thread in the account home it runs in, and the node opens on that folder', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const call = await startCodex(page, env)
      const images = path.join(call.codexHome!, 'generated_images', call.sessionId)
      fs.mkdirSync(images, { recursive: true })
      fs.writeFileSync(path.join(images, 'exec-1.png'), ONE_PIXEL_PNG)

      await showBrowse(page)
      await expect(scratchpadNode(page)).toBeVisible({ timeout: 40_000 })
      await expect(scratchpadNode(page)).toHaveAttribute('data-path', images)
      await expect.poll(() => scratchpadNames(page)).toEqual(['exec-1.png'])
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§12
  test('a remote Codex tab lists the images Codex saved for its thread on that machine, under the Codex home that holds the thread’s rollout, once the thread has one', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
      const row = wsRows(page, REMOTE_WS_NAME)
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await runIn(page, centerTerm(page), 'draw it')
      await expect
        .poll(() => codexAnswers(machineCodexLog<CodexWireLine>(env, 'fake-codex-wire.jsonl')), {
          timeout: 60_000
        })
        .toContain('Codex fixture answered: draw it')
      await sendShortcut(app, 'shortcut:restart-session')

      const scratchpadDir = async (): Promise<string | undefined> =>
        (await page.evaluate(() => window.api.sessions.list())).find(
          (s) => s.backendId === 'codex' && s.alive
        )?.scratchpadDir
      await expect.poll(scratchpadDir, { timeout: 60_000 }).toMatch(/^ssh:\/\//)
      const images = barePath((await scratchpadDir())!)
      expect(images.startsWith(machineHome(env) + path.sep)).toBe(true)
      expect(path.basename(path.dirname(images))).toBe('generated_images')
      fs.mkdirSync(images, { recursive: true })
      fs.writeFileSync(path.join(images, 'exec-1.png'), ONE_PIXEL_PNG)

      await showBrowse(page)
      await expect(scratchpadNode(page)).toBeVisible({ timeout: 60_000 })
      await expect.poll(() => scratchpadNames(page), { timeout: 30_000 }).toEqual(['exec-1.png'])
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§8 AGY§19
  test('an Antigravity tab lists the plan agy wrote and its scratch folder from agy’s own folder for the conversation, never agy’s logs or the plan’s metadata file', async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Antigravity')
      await expect.poll(() => agySessionCalls(env).length).toBe(1)
      await runIn(page, centerTerm(page), '/plan')

      await showBrowse(page)
      await expect(scratchpadNode(page)).toBeVisible({ timeout: 40_000 })
      const dir = (await scratchpadNode(page).getAttribute('data-path'))!
      expect(path.dirname(dir)).toBe(
        path.join(env.userData, 'agy-homes', E2E_AGY_ACCOUNT, 'antigravity-cli', 'brain')
      )
      await expect
        .poll(() => scratchpadNames(page), { timeout: 30_000 })
        .toEqual(['scratch', 'implementation_plan.md'])
      expect(fs.existsSync(path.join(dir, '.system_generated'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'implementation_plan.md.metadata.json'))).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§12
  test('a remote Antigravity tab lists agy’s folder for the conversation on that machine, named by agy’s hooks, and a file agy leaves there shows after its next turn', async ({
    env
  }) => {
    installAgy(env)
    installFakeRemote(env)
    installRemoteAgy(env)
    seedRemoteWorkspace(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'remote words')
      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'remote words' })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const { id } = await boundRemoteSession(page, 'agy')

      await showBrowse(page)
      await expect(scratchpadNode(page)).toBeVisible({ timeout: 60_000 })
      expect(await scratchpadNode(page).getAttribute('data-path')).toMatch(
        new RegExp(`^ssh://[^/]+/.+/antigravity-cli/brain/${id}$`)
      )
      await expect.poll(() => scratchpadNames(page), { timeout: 30_000 }).toEqual(['scratch'])

      const onMachine = path.join(machineHome(env), '.gemini', 'antigravity-cli', 'brain', id)
      fs.writeFileSync(path.join(onMachine, 'walkthrough.md'), '# Walkthrough\n')
      await runIn(page, centerTerm(page), 'again')
      await expect
        .poll(() => scratchpadNames(page), { timeout: 60_000 })
        .toEqual(['scratch', 'walkthrough.md'])
    } finally {
      await quitAndClose(app)
    }
  })
})

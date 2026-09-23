import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { seedJsonl, settingsOnDisk, snap, waitForCalls } from './helpers/p1'
import {
  changelog,
  notesBody,
  release,
  withFixtureEnv,
  writeFixture
} from './helpers/updateFixture'

const BEAT_FOR_A_MODAL_THAT_MUST_NOT_OPEN_MS = 3000

function firstRun(env: E2EEnv, settings: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({ version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} })
  )
  seedSettings(env, { onboardingSeen: false, ...settings })
}

function welcome(page: Page): Locator {
  return page.locator('.w-empty.onboarding')
}

async function expectStep(page: Page, n: number): Promise<void> {
  await expect(welcome(page).locator('.eyebrow')).toHaveText(`Welcome · ${n} of 4`, {
    timeout: 20_000
  })
  await expect(welcome(page).locator('.ob-dots .ob-dot.on')).toHaveCount(1)
}

async function clickPrimary(page: Page): Promise<void> {
  await welcome(page).locator('.btn-primary').click()
}

async function advanceTo(page: Page, step: number): Promise<void> {
  await expect(welcome(page)).toBeVisible({ timeout: 20_000 })
  for (let n = 1; n < step; n++) {
    if (n === 2) {
      await expect(welcome(page).locator('.disc-row')).not.toHaveCount(0, { timeout: 20_000 })
    }
    await clickPrimary(page)
  }
  await expectStep(page, step)
}

test.describe("first-run help: the welcome steps, Settings ▸ Welcome, and What's new once per upgrade", () => {
  test('T-OB-01: a first run lands on welcome step 1', async ({ env }) => {
    test.setTimeout(120_000)
    firstRun(env)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(welcome(page)).toBeVisible({ timeout: 20_000 })
      await expectStep(page, 1)
      await expect(welcome(page).locator('.big')).toHaveText(
        'Koloft runs Claude Code — and Codex, if you have it.'
      )
      await expect(welcome(page).locator('.ob-skip')).toHaveText('Skip')
      await expect(welcome(page).locator('.ob-back')).toHaveCount(0)
      await expect(page.locator('.tb-ico[aria-label="Add workspace"]')).toHaveClass(/\bon\b/)
      await expect(page.locator('.hint')).toHaveCount(0)
      await snap(page, 'T-OB-01')
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-02: step 2 lists the folders Claude Code was used in (a worktree counts as its repo, a gone folder not at all), and pins the checked ones', async ({
    env
  }) => {
    test.setTimeout(120_000)
    firstRun(env)
    const now = Date.now()
    seedJsonl(env, env.workspaces.a, { summary: 'A one', mtime: now - 60_000 })
    seedJsonl(env, env.workspaces.a, { summary: 'A two', mtime: now - 30_000 })
    seedJsonl(env, env.workspaces.b, { summary: 'B one', mtime: now - 86_400_000 })
    const wt = path.join(env.home, 'repo', '.claude', 'worktrees', 'wt-1')
    fs.mkdirSync(wt, { recursive: true })
    seedJsonl(env, wt, { summary: 'Worktree one', mtime: now - 172_800_000 })
    seedJsonl(env, path.join(env.home, 'deleted-ws'), { summary: 'Deleted one' })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 2)

      const rows = welcome(page).locator('.disc-row')
      await expect(rows).toHaveCount(3, { timeout: 20_000 })
      await expect(rows.nth(0).locator('.disc-name')).toHaveText('ws-a')
      await expect(rows.nth(0).locator('.disc-meta')).toContainText('2 sessions')
      await expect(rows.nth(1).locator('.disc-name')).toHaveText('ws-b')
      await expect(rows.nth(1).locator('.disc-meta')).toContainText('1 session')
      await expect(rows.nth(2).locator('.disc-name')).toHaveText('repo')
      await expect(rows.nth(2).locator('.disc-meta')).toContainText('1 session')
      await expect(welcome(page)).not.toContainText('wt-1')
      await expect(welcome(page)).not.toContainText('deleted-ws')
      await snap(page, 'T-OB-02')

      await expect(welcome(page).locator('.btn-primary')).toHaveText('Pin 3 workspaces')
      await rows.nth(1).locator('input[type=checkbox]').click()
      await rows.nth(2).locator('input[type=checkbox]').click()
      await expect(welcome(page).locator('.btn-primary')).toHaveText('Pin 1 workspace')
      await clickPrimary(page)

      await expect(page.locator('.ws-head')).toHaveCount(1, { timeout: 20_000 })
      await expect(page.locator('.ws-name')).toHaveText('ws-a')
      await expect(welcome(page)).toBeVisible()
      await expectStep(page, 3)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-03: with no history behind it step 2 is a plain folder pick', async ({ env }) => {
    test.setTimeout(120_000)
    firstRun(env)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 2)
      await expect(welcome(page).locator('.big')).toHaveText('Pick a folder to work in.')
      await expect(welcome(page).locator('.disc-row')).toHaveCount(0)
      await expect(welcome(page).locator('.btn-primary')).toHaveText('Choose Folder…')

      fs.writeFileSync(env.fileDialogFile, env.workspaces.a + '\n')
      await clickPrimary(page)
      await expect(page.locator('.ws-name')).toHaveText('ws-a', { timeout: 20_000 })
      await expectStep(page, 3)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-04: Skip hands the slot back to the plain panel, for good', async ({ env }) => {
    test.setTimeout(180_000)
    firstRun(env)

    const app1 = await launchApp(env)
    try {
      const page = await app1.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(welcome(page)).toBeVisible({ timeout: 20_000 })
      await welcome(page).locator('.ob-skip').click()

      await expect(welcome(page)).toHaveCount(0)
      await expect(page.locator('.w-empty .big')).toHaveText('No workspace yet')
      await expect.poll(() => settingsOnDisk(env).onboardingSeen, { timeout: 20_000 }).toBe(true)
    } finally {
      await quitAndClose(app1)
    }

    const app2 = await launchApp(env)
    try {
      const page = await app2.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.w-empty .big')).toHaveText('No workspace yet', {
        timeout: 20_000
      })
      await expect(welcome(page)).toHaveCount(0)
    } finally {
      await quitAndClose(app2)
    }
  })

  test('T-OB-05: finishing the welcome starts the first session in the pinned folder', async ({
    env
  }) => {
    test.setTimeout(180_000)
    firstRun(env)
    seedJsonl(env, env.workspaces.a, { summary: 'A one', mtime: Date.now() - 60_000 })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 4)

      const primary = welcome(page).locator('.btn-primary')
      await expect(primary).toHaveText('＋ Start first session', { timeout: 20_000 })
      await expect(primary).toBeEnabled()
      await primary.click()

      const [call] = await waitForCalls(env, 1)
      expect(call.cwd).toBe(env.workspaces.a)
      await expect(welcome(page)).toHaveCount(0)
      await expect.poll(() => settingsOnDisk(env).onboardingSeen, { timeout: 20_000 }).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-06: with no supported CLI installed step 4 says how to get one and launches nothing', async ({
    env
  }) => {
    test.setTimeout(120_000)
    firstRun(env)
    env.launchEnv.KOLOFT_TEST_CLAUDE_PROBE = 'missing'
    seedJsonl(env, env.workspaces.a, { summary: 'A one', mtime: Date.now() - 60_000 })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 4)

      const warn = welcome(page).locator('.ob-warn')
      await expect(warn).toBeVisible({ timeout: 20_000 })
      await expect(warn).toContainText('Install Claude Code or a supported Codex CLI')
      await expect(warn.locator('code.ob-cmd')).toHaveText([
        'npm install -g @anthropic-ai/claude-code',
        'npm install -g @openai/codex'
      ])
      const primary = welcome(page).locator('.btn-primary')
      await expect(primary).toHaveText('Check again')
      await snap(page, 'T-OB-06')

      await primary.click()
      await expect(primary).toHaveText('Check again', { timeout: 20_000 })
      await expect(welcome(page)).toBeVisible()
      expect(fs.existsSync(env.claudeCalls)).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-07: picking the balancing card ends in Settings ▸ Accounts — no launch, no setting changed', async ({
    env
  }) => {
    test.setTimeout(120_000)
    firstRun(env)
    seedJsonl(env, env.workspaces.a, { summary: 'A one', mtime: Date.now() - 60_000 })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 3)

      const choices = welcome(page).locator('.ob-choices .choice')
      await expect(choices.nth(0)).toHaveClass(/\bon\b/)
      await choices.nth(1).click()
      await expect(choices.nth(1)).toHaveClass(/\bon\b/)
      await expect(choices.nth(0)).not.toHaveClass(/\bon\b/)
      await clickPrimary(page)
      await expectStep(page, 4)

      await expect(welcome(page).locator('.btn-primary')).toHaveText('Set up accounts', {
        timeout: 20_000
      })
      await clickPrimary(page)
      await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.set-ni.on')).toHaveText('Accounts')
      await snap(page, 'T-OB-07')
      await expect.poll(() => settingsOnDisk(env).onboardingSeen, { timeout: 20_000 }).toBe(true)
      expect(settingsOnDisk(env).multiAccount).toBe(false)
      expect(fs.existsSync(env.claudeCalls)).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-08: Settings ▸ Welcome is the same help on demand, and can replay it', async ({
    env
  }) => {
    test.setTimeout(120_000)
    firstRun(env, { onboardingSeen: true, hintsSeen: ['workbench'], hintsOff: true })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.w-empty .big')).toHaveText('No workspace yet', {
        timeout: 20_000
      })

      await page.locator('.tb-ico[title="Settings"]').click()
      await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.set-ni').first()).toHaveText('Welcome')
      await page.locator('.set-ni', { hasText: 'Welcome' }).click()

      const pane = page.locator('.settings-modal .set-main')
      await expect(pane).toContainText('What Koloft does')
      await expect(pane.locator('.wp-cards .wp-card')).toHaveCount(8)
      await expect(pane.locator('table.wp-diff tbody tr')).toHaveCount(7)
      await expect(pane.locator('table.wp-diff')).toContainText('Plain terminal')
      await snap(page, 'T-OB-08')

      await pane.locator('.set-row button.mini', { hasText: 'Reset tips' }).click()
      await expect.poll(() => settingsOnDisk(env).hintsOff, { timeout: 20_000 }).toBe(false)
      expect(settingsOnDisk(env).hintsSeen).toEqual([])

      await pane.locator('.set-row button.mini', { hasText: 'Show welcome again' }).click()
      await page.keyboard.press('Escape')
      await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 20_000 })
      await expect(welcome(page)).toBeVisible({ timeout: 20_000 })
      await expectStep(page, 1)
    } finally {
      await quitAndClose(app)
    }
  })

  // PLATFORM§4
  function withWhatsNew(env: E2EEnv, versions: [string, string][]): string {
    const file = withFixtureEnv(env)
    writeFixture(
      file,
      versions.map(([v, item]) => release(v, notesBody(changelog(item))))
    )
    return file
  }

  async function runningVersion(app: ElectronApplication): Promise<string> {
    return app.evaluate(({ app: a }) => a.getVersion())
  }

  async function expectNoModal(page: Page, env: E2EEnv, recorded?: string): Promise<void> {
    await expect(page.locator('.isl-sessions')).toBeVisible({ timeout: 20_000 })
    if (recorded) {
      await expect
        .poll(() => settingsOnDisk(env).lastSeenVersion, { timeout: 20_000 })
        .toBe(recorded)
    } else {
      await page.waitForTimeout(BEAT_FOR_A_MODAL_THAT_MUST_NOT_OPEN_MS)
    }
    await expect(page.locator('.update-modal')).toHaveCount(0)
  }

  test('T-OB-09: an upgrade shows what changed once, then remembers', async ({ env }) => {
    test.setTimeout(180_000)
    const fixture = withWhatsNew(env, [
      ['0.1.2', 'the newer thing'],
      ['0.1.1', 'the older thing']
    ])
    seedSettings(env, { onboardingSeen: true, lastSeenVersion: '0.1.0' })

    const app1 = await launchApp(env)
    try {
      const page = await app1.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const version = await runningVersion(app1)

      const modal = page.locator('.update-modal')
      await expect(modal).toBeVisible({ timeout: 30_000 })
      await expect(modal.locator('.modal-header span').first()).toHaveText(
        `What’s new in Koloft ${version}`
      )
      const notes = modal.locator('.update-notes')
      await expect(notes).toContainText('the newer thing')
      await expect(notes).toContainText('the older thing')
      await expect(notes.locator('.update-notes-ver')).toHaveText(['v0.1.2', 'v0.1.1'])
      await expect(page.getByRole('button', { name: 'Download & Restart' })).toHaveCount(0)
      await snap(page, 'T-OB-09')

      await modal.locator('.update-actions .btn-primary').click()
      await expect(modal).toHaveCount(0)
      await expect
        .poll(() => settingsOnDisk(env).lastSeenVersion, { timeout: 20_000 })
        .toBe(version)
    } finally {
      await quitAndClose(app1)
    }

    expect(JSON.parse(fs.readFileSync(fixture, 'utf8')).length).toBe(2)
    const app2 = await launchApp(env)
    try {
      const page = await app2.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expectNoModal(page, env)
    } finally {
      await quitAndClose(app2)
    }
  })

  test('T-OB-10: a fresh install and an unreadable feed say nothing; an unreadable feed also records nothing, so the next launch tries again', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const fixture = withWhatsNew(env, [['0.1.2', 'the newer thing']])
    seedSettings(env, { onboardingSeen: true, lastSeenVersion: '' })

    const app1 = await launchApp(env)
    let version = ''
    try {
      const page = await app1.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      version = await runningVersion(app1)
      await expectNoModal(page, env, version)
    } finally {
      await quitAndClose(app1)
    }

    const app2 = await launchApp(env)
    try {
      const page = await app2.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expectNoModal(page, env)
      expect(settingsOnDisk(env).lastSeenVersion).toBe(version)
    } finally {
      await quitAndClose(app2)
    }

    fs.writeFileSync(fixture, 'not json at all')
    seedSettings(env, { lastSeenVersion: '0.1.0' })
    const app3 = await launchApp(env)
    try {
      const page = await app3.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expectNoModal(page, env)
      expect(settingsOnDisk(env).lastSeenVersion).toBe('0.1.0')
    } finally {
      await quitAndClose(app3)
    }
  })
})

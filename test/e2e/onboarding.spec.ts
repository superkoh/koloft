import fs from 'fs'
import http from 'http'
import { execFileSync } from 'child_process'
import type { AddressInfo } from 'net'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  codexMissingWhoseCheckAnswersOnlyWhenLetGo,
  installAgy,
  installCodex,
  installMuse,
  ownersGemini,
  seedSettings,
  type E2EEnv
} from './helpers/env'
import {
  expectNoCodexWhileTheCheckIsOutNorAfter,
  seedJsonl,
  settingsOnDisk,
  snap,
  terminalText,
  termIds,
  waitForCalls
} from './helpers/p1'

const BEAT_FOR_A_MODAL_THAT_MUST_NOT_OPEN_MS = 3000
const SETTLE_FOR_A_TAB_THAT_MUST_STAY_OPEN_MS = 1500
const HOUR = 3_600_000
const DAY = 24 * HOUR

function codexInstalledOnlyLater(env: E2EEnv): string {
  const codex = path.join(env.home, '.local', 'bin', 'codex')
  env.launchEnv.KOLOFT_CODEX_CMD = codex
  env.launchEnv.CODEX_HOME = path.join(env.home, '.codex')
  env.launchEnv.KOLOFT_TEST_TOOL_INSTALLER = path.join(
    __dirname,
    'fixtures',
    'fake-tool-installer.js'
  )
  return codex
}

function firstRun(env: E2EEnv, settings: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({
      version: 6,
      workspaces: [],
      workbench: { defaultOpen: true },
      members: [],
      panels: {}
    })
  )
  seedSettings(env, { onboardingSeen: false, ...settings })
}

function terminalSession(env: E2EEnv, folder: string, title: string, ago: number): string {
  return seedJsonl(env, folder, { summary: title, mtime: Date.now() - ago, owned: false })
}

function codexThreadIn(env: E2EEnv, folder: string, title: string, agoSeconds: number): void {
  const now = Math.floor(Date.now() / 1000)
  const id = `0199a1b2-c3d4-7e5f-8a6b-${String(agoSeconds).padStart(12, '0')}`
  const saved = path.join(env.home, '.codex', 'sessions')
  fs.mkdirSync(saved, { recursive: true })
  fs.writeFileSync(
    path.join(saved, id + '.json'),
    JSON.stringify({
      id,
      cwd: folder,
      name: title,
      preview: title,
      createdAt: now - agoSeconds,
      updatedAt: now - agoSeconds,
      turns: []
    })
  )
}

// CC§7
async function answerEveryProbeOk(): Promise<{ base: string; close(): Promise<void> }> {
  const reset = String(Math.floor(Date.now() / 1000) + 7200)
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () =>
      res
        .writeHead(200, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-utilization': '0.1',
          'anthropic-ratelimit-unified-7d-utilization': '0.2',
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-5h-reset': reset,
          'anthropic-ratelimit-unified-7d-reset': reset
        })
        .end('{}')
    )
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok()))
  }
}

function welcome(page: Page): Locator {
  return page.locator('.wl')
}

async function expectStep(page: Page, n: number): Promise<void> {
  await expect(welcome(page)).toHaveAttribute('data-step', String(n), { timeout: 20_000 })
}

function primary(page: Page): Locator {
  return welcome(page).locator('[data-welcome-go]').first()
}

function agentCard(page: Page, name: string): Locator {
  return welcome(page)
    .locator('.wl-agent')
    .filter({
      has: page.locator('.wl-agent-name', { hasText: new RegExp(`^${name}$`) })
    })
}

async function advanceTo(page: Page, step: number): Promise<void> {
  await expectStep(page, 1)
  for (let n = 1; n < step; n++) {
    await expect(primary(page)).toBeEnabled({ timeout: 20_000 })
    await primary(page).click()
    await expectStep(page, n + 1)
  }
}

function sidebarFolders(page: Page): Locator {
  return page.locator('.isl-sessions .ws-name')
}

test.describe('first-run help: the welcome and Settings ▸ Welcome', () => {
  test('T-OB-01: a first run opens the welcome over the whole window, the four agents side by side, the one on this Mac ready and the rest offered to install', async ({
    env
  }) => {
    test.setTimeout(120_000)
    firstRun(env)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expectStep(page, 1)
      await expect(welcome(page).locator('.wl-title')).toHaveText('Four agents. One window.')
      await expect(welcome(page).locator('.wl-sub')).toHaveText(
        'Koloft runs Claude Code, Codex, Muse and Antigravity.'
      )
      await expect(welcome(page).locator('.wl-agent-name')).toHaveText([
        'Claude Code',
        'Codex',
        'Muse Code',
        'Antigravity CLI'
      ])
      await expect(agentCard(page, 'Claude Code')).toHaveClass(/\bready\b/, { timeout: 20_000 })
      for (const missing of ['Codex', 'Muse Code', 'Antigravity CLI']) {
        await expect(agentCard(page, missing)).toContainText('Not on this Mac')
        await expect(
          agentCard(page, missing).locator('button', { hasText: 'Install' })
        ).toBeVisible()
      }
      await expect(welcome(page).locator('.wl-skip')).toContainText('Skip setup')
      await snap(page, 'T-OB-01')
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-02: screen 2 pins the folders used in the last two weeks (a gone or stale folder never) and brings their terminal sessions into the sidebar, grey', async ({
    env
  }) => {
    test.setTimeout(120_000)
    firstRun(env)
    terminalSession(env, env.workspaces.a, 'A one', 2 * HOUR)
    terminalSession(env, env.workspaces.a, 'A two', 3 * HOUR)
    terminalSession(env, env.workspaces.b, 'B one', DAY)
    terminalSession(env, path.join(env.home, 'deleted-ws'), 'Deleted one', HOUR)
    const stale = path.join(env.home, 'stale')
    fs.mkdirSync(stale)
    terminalSession(env, stale, 'Stale one', 40 * DAY)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 2)

      await expect(sidebarFolders(page)).toHaveText(['ws-a', 'ws-b'], { timeout: 20_000 })
      const rows = welcome(page).locator('.wl-row-t')
      await expect(rows).toHaveText(['A one', 'A two', 'B one'], { timeout: 20_000 })
      await expect(welcome(page).locator('.wl-chip')).toHaveText(/Found 3 sessions in 2 folders/)
      await expect(page.locator('.isl-sessions .ws-tab.cold', { hasText: 'A one' })).toHaveCount(1)
      await expect(welcome(page)).not.toContainText('Deleted one')
      await expect(welcome(page)).not.toContainText('Stale one')
      await expect(welcome(page).locator('.wl-key')).toContainText('Grey: started in your terminal')
      await snap(page, 'T-OB-02')
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§15 MUSE§5 AGY§8
  test('T-OB-17: the welcome also finds the folders Codex, Muse and Antigravity were used in, with no Claude Code history at all, and counts each agent’s sessions', async ({
    env
  }) => {
    test.setTimeout(120_000)
    firstRun(env)
    installCodex(env)
    installMuse(env)
    installAgy(env)
    const now = Math.floor(Date.now() / 1000)
    codexThreadIn(env, env.workspaces.a, 'Codex in ws-a', 60)
    const museSession = '01a17db8-7cda-7722-8212-7f60790ea9c8'
    const museListed = path.join(env.home, '.local', 'share', 'muse', 'sessions', 'fake')
    fs.mkdirSync(museListed, { recursive: true })
    fs.writeFileSync(
      path.join(museListed, museSession + '.json'),
      JSON.stringify({
        id: museSession,
        cwd: fs.realpathSync(env.workspaces.b),
        title: 'Muse in ws-b',
        createdAt: new Date((now - 120) * 1000).toISOString(),
        updatedAt: new Date((now - 120) * 1000).toISOString(),
        items: []
      })
    )
    fs.mkdirSync(path.join(env.home, 'agy-ws'))
    const agyFolder = fs.realpathSync(path.join(env.home, 'agy-ws'))
    const agyApp = path.join(ownersGemini(env), 'antigravity-cli')
    fs.mkdirSync(agyApp, { recursive: true })
    fs.writeFileSync(
      path.join(agyApp, 'settings.json'),
      JSON.stringify({ trustedWorkspaces: [agyFolder], modelProvider: 'gemini' })
    )
    execFileSync(
      process.execPath,
      [path.join(__dirname, 'fixtures', 'fake-agy.js'), '-p', 'Antigravity in agy-ws'],
      {
        cwd: agyFolder,
        env: { ...env.launchEnv, PWD: agyFolder, GEMINI_API_KEY: 'fake-gemini-key' }
      }
    )

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expectStep(page, 1)
      for (const agent of ['Codex', 'Muse Code', 'Antigravity CLI'])
        await expect(agentCard(page, agent)).toContainText('1 session · 1 folder', {
          timeout: 20_000
        })
      await expect(agentCard(page, 'Claude Code')).toContainText('No sessions yet')

      await advanceTo(page, 2)
      await expect(sidebarFolders(page)).toHaveText(['agy-ws', 'ws-a', 'ws-b'], {
        timeout: 20_000
      })
      await snap(page, 'T-OB-17')
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-03: with no history behind it, screen 2 is a plain folder pick that pins the chosen folder, and offers a folder on another machine', async ({
    env
  }) => {
    test.setTimeout(120_000)
    firstRun(env)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 2)
      await expect(welcome(page).locator('.wl-title')).toHaveText('Pick a folder to work in.')
      await expect(primary(page)).toHaveText(/Choose Folder…/)

      await welcome(page)
        .locator('button', { hasText: 'A folder on another machine (SSH)' })
        .click()
      await expect(page.locator('.modal.remotews')).toBeVisible({ timeout: 20_000 })
      await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } })
      await expect(page.locator('.modal.remotews')).toHaveCount(0)
      await expectStep(page, 2)

      fs.writeFileSync(env.fileDialogFile, env.workspaces.a + '\n')
      await primary(page).click()
      await expect(sidebarFolders(page)).toHaveText(['ws-a'], { timeout: 20_000 })
      await expect(welcome(page).locator('.wl-chip')).toHaveText(/ws-a is pinned/)
      await expect(primary(page)).toHaveText(/Continue/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-04: Skip setup (or Esc) ends the welcome for good and leaves the plain app', async ({
    env
  }) => {
    test.setTimeout(180_000)
    firstRun(env)

    const app1 = await launchApp(env)
    try {
      const page = await app1.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expectStep(page, 1)
      await page.keyboard.press('Escape')

      await expect(welcome(page)).toHaveCount(0, { timeout: 20_000 })
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

  // CC§10
  test('T-OB-05: the last screen resumes the newest terminal session with its own agent, says sessions skip the step-by-step asking, and Claude Code’s own first-run page is marked done', async ({
    env
  }) => {
    test.setTimeout(180_000)
    firstRun(env, { skipPermissionsAgreed: false })
    terminalSession(env, env.workspaces.a, 'Older one', DAY)
    const newest = terminalSession(env, env.workspaces.a, 'Fix login bug', 2 * HOUR)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 4)
      await expect(welcome(page).locator('.wl-title')).toHaveText(
        'Built for you. And for your agents.'
      )
      await expect(primary(page)).toHaveText(/Resume “Fix login bug”/)
      await expect(welcome(page).locator('.wl-perm')).toContainText(
        'Sessions run each step without stopping to ask.'
      )
      await snap(page, 'T-OB-05')
      await page.keyboard.press('Enter')

      const [call] = await waitForCalls(env, 1)
      expect(call.argv).toContain(newest)
      expect(call.cwd).toBe(env.workspaces.a)
      expect(
        JSON.parse(fs.readFileSync(path.join(env.home, '.claude.json'), 'utf8'))
          .hasCompletedOnboarding
      ).toBe(true)
      await expect(welcome(page)).toHaveCount(0, { timeout: 20_000 })
      await expect.poll(() => settingsOnDisk(env).onboardingSeen, { timeout: 20_000 }).toBe(true)
      expect(settingsOnDisk(env).skipPermissionsAgreed).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-20: someone who already pinned folders but never finished the old welcome is not stopped by the new one after an upgrade', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedSettings(env, { onboardingSeen: false })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(sidebarFolders(page)).toHaveText(['ws-a', 'ws-b'], { timeout: 20_000 })
      await page.waitForTimeout(BEAT_FOR_A_MODAL_THAT_MUST_NOT_OPEN_MS)
      await expect(welcome(page)).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-18: a sentence typed on the last screen starts a new session with it as the first prompt, in the session’s folder, and Tab walks the four agents', async ({
    env
  }) => {
    test.setTimeout(180_000)
    firstRun(env)
    terminalSession(env, env.workspaces.a, 'Fix login bug', 2 * HOUR)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 4)
      const ask = welcome(page).locator('.wl-ask input')
      const tag = welcome(page).locator('.wl-agtag')
      await expect(tag).toContainText('Claude')
      await ask.press('Tab')
      await expect(tag).toContainText('Codex')
      await ask.press('Tab')
      await ask.press('Tab')
      await expect(tag).toContainText('Antigravity')
      await ask.press('Tab')
      await expect(tag).toContainText('Claude')

      await welcome(page).locator('.wl-perm button', { hasText: 'Ask me first instead' }).click()
      await expect(welcome(page).locator('.wl-perm')).toContainText(
        'Sessions ask you before each step.'
      )
      await expect.poll(() => settingsOnDisk(env).skipPermissions, { timeout: 20_000 }).toBe(false)

      await ask.fill('explain this project')
      await ask.press('Enter')
      const [call] = await waitForCalls(env, 1)
      expect(call.argv).toContain('explain this project')
      expect(call.argv).not.toContain('--resume')
      expect(call.cwd).toBe(env.workspaces.a)
      await expect(welcome(page)).toHaveCount(0, { timeout: 20_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-06: with no agent installed, screen 1 offers to install each one, never through npm, and screen 3 installs before it signs in', async ({
    env
  }) => {
    test.setTimeout(120_000)
    firstRun(env, { accounts: [] })
    env.launchEnv.KOLOFT_TEST_CLAUDE_PROBE = 'missing'
    terminalSession(env, env.workspaces.a, 'A one', HOUR)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expectStep(page, 1)
      for (const agent of ['Claude Code', 'Codex', 'Muse Code', 'Antigravity CLI'])
        await expect(agentCard(page, agent)).toContainText('Not on this Mac', { timeout: 20_000 })
      await expect(welcome(page).locator('.wl-chip')).toHaveText(/0 of 4 ready/)
      await expect(welcome(page)).not.toContainText('npm')
      await snap(page, 'T-OB-06')

      await advanceTo(page, 3)
      await expect(primary(page)).toHaveText(/Install Claude and sign in/)
      await expect(welcome(page).locator('.wl-sign')).toContainText(
        'Koloft installs Claude Code first.'
      )
      expect(fs.existsSync(env.claudeCalls)).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§22
  test('T-OB-14: Install on a screen 1 card runs the installer in a terminal tab while the welcome steps aside; a failed install keeps the tab and its error, a good one closes it and the card turns ready', async ({
    env
  }) => {
    test.setTimeout(180_000)
    firstRun(env)
    codexInstalledOnlyLater(env)
    const failing = path.join(env.home, 'fake-tool-installer-fails')
    fs.writeFileSync(failing, '')

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expectStep(page, 1)
      const install = agentCard(page, 'Codex').locator('button', { hasText: 'Install' })

      await install.click()
      await expect(page.locator('.wl-aside')).toBeVisible({ timeout: 20_000 })
      await expect(welcome(page)).toHaveCount(0)
      await expect.poll(() => termIds(page), { timeout: 20_000 }).toHaveLength(1)
      const [tabId] = await termIds(page)
      await expect
        .poll(() => terminalText(page, tabId), { timeout: 30_000 })
        .toContain('Could not resolve host')
      await page.waitForTimeout(SETTLE_FOR_A_TAB_THAT_MUST_STAY_OPEN_MS)
      await expect(page.locator('.wl-aside')).toBeVisible()

      fs.rmSync(failing)
      await page.evaluate((id) => window.api.terminal.write(id, 'exit\r'), tabId)
      await expectStep(page, 1)
      await install.click()
      await expect(agentCard(page, 'Codex')).toHaveClass(/\bready\b/, { timeout: 30_000 })
      await expect(page.locator('.wl-aside')).toHaveCount(0)
      expect(fs.readFileSync(path.join(env.home, 'fake-tool-installs.txt'), 'utf8')).toBe(
        'codex\ncodex\n'
      )
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0030 CC§7
  test('T-OB-07: with no Koloft account, screen 3 signs in to Claude in the browser in one press, names the account Claude, and moves on by itself', async ({
    env
  }) => {
    test.setTimeout(180_000)
    firstRun(env, { accounts: [], assist: null })
    const probe = await answerEveryProbeOk()
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    terminalSession(env, env.workspaces.a, 'A one', HOUR)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 3)
      await expect(welcome(page).locator('.wl-chip')).toHaveText(/One step needs you/)
      await expect(welcome(page).locator('.wl-sign')).toContainText('The account is named “Claude”')
      await expect(primary(page)).toHaveText(/Sign in to Claude/)
      await snap(page, 'T-OB-07')

      await page.keyboard.press('Enter')
      await expectStep(page, 4)
      const accounts = settingsOnDisk(env).accounts as { name: string; kind: string }[]
      expect(accounts.map((a) => [a.name, a.kind])).toEqual([['Claude', 'oauth']])
      expect(settingsOnDisk(env).assist).toBeNull()
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  // ADR-0030 CODEX§15
  test('T-OB-11: with Codex used last, screen 3 picks Codex and signs in through a terminal tab with the welcome stepped aside, then comes back on its own', async ({
    env
  }) => {
    test.setTimeout(180_000)
    firstRun(env, { accounts: [], assist: null })
    installCodex(env)
    seedSettings(env, { accounts: [] })
    terminalSession(env, env.workspaces.a, 'Claude one', 3 * DAY)
    codexThreadIn(env, env.workspaces.a, 'Codex one', 600)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 3)
      await expect(welcome(page).locator('.wl-seg button.on')).toContainText('Codex')
      await expect(welcome(page).locator('.wl-seg button.on')).toContainText('last used')
      await expect(primary(page)).toHaveText(/Sign in to Codex/)

      await primary(page).click()
      await expect
        .poll(() => fs.existsSync(path.join(env.userData, 'codex-homes', 'Codex', 'auth.json')), {
          timeout: 30_000
        })
        .toBe(true)
      await expectStep(page, 4)
      await expect(page.locator('.wl-aside')).toHaveCount(0)
      const accounts = settingsOnDisk(env).accounts as { name: string }[]
      expect(accounts.map((a) => a.name)).toEqual(['Codex'])
      await expect(primary(page)).toHaveText(/Resume “Codex one”/)
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0030 CODEX§15
  test('T-OB-19: an account that has to sign in again is signed in again on screen 3, never shadowed by a second one', async ({
    env
  }) => {
    test.setTimeout(180_000)
    firstRun(env, { assist: null })
    installCodex(env)
    seedSettings(env, {
      accounts: [
        {
          name: 'me',
          kind: 'codex-home',
          enabled: true,
          fable: 'unknown',
          status: 'unverified',
          addedAt: 1
        }
      ]
    })
    codexThreadIn(env, env.workspaces.a, 'Codex one', 600)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await advanceTo(page, 3)
      await expect(welcome(page).locator('.wl-seg button.on')).toContainText('Codex')
      await expect(welcome(page).locator('.wl-sign')).toContainText('This signs “me” in again.')

      await primary(page).click()
      await expect
        .poll(() => fs.existsSync(path.join(env.userData, 'codex-homes', 'me', 'auth.json')), {
          timeout: 30_000
        })
        .toBe(true)
      await expectStep(page, 4)
      const accounts = settingsOnDisk(env).accounts as { name: string }[]
      expect(accounts.map((a) => a.name)).toEqual(['me'])
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0030 CC§9
  test('T-OB-12: an upgrade from before Koloft Assist is never stopped by an Assist question; the butler row asks it, and Not now closes it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, {
      onboardingSeen: true,
      assist: null,
      skipPermissionsAgreed: undefined
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const assist = page.locator('.assist-modal')
      await expect(page.locator('.isl-sessions')).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(BEAT_FOR_A_MODAL_THAT_MUST_NOT_OPEN_MS)
      await expect(assist).toHaveCount(0)

      await page.locator('.isl-butler .ws-tab', { hasText: 'Not set up — click to start' }).click()
      await expect(assist).toBeVisible({ timeout: 20_000 })
      await snap(page, 'T-OB-12')
      await assist.locator('button', { hasText: 'Not now' }).click()
      await expect(assist).toHaveCount(0)
      expect(settingsOnDisk(env).assist).toBeNull()
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-13: with no Codex and a slow Codex check, the Assist question from the butler row never offers Codex, before or after the check answers', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedSettings(env, { onboardingSeen: true, assist: null })
    const letTheCheckAnswer = codexMissingWhoseCheckAnswersOnlyWhenLetGo(env)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page
        .locator('.isl-butler .ws-tab', { hasText: 'Not set up — click to start' })
        .click({ timeout: 20_000 })
      const assist = page.locator('.assist-modal')
      const choice = (name: string) =>
        assist.locator('.assist-setup .choice-t', { hasText: new RegExp(`^${name}$`) })
      await expect(choice('Claude')).toBeVisible({ timeout: 20_000 })

      await expectNoCodexWhileTheCheckIsOutNorAfter(
        page,
        letTheCheckAnswer,
        () => choice('Codex').count(),
        'a Codex choice'
      )
      await expect(choice('Claude')).toBeVisible()
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-OB-08: Settings ▸ Welcome is the help on demand, and Show welcome again opens the welcome at once, folders untouched', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedSettings(env, { onboardingSeen: true, hintsSeen: ['workbench'], hintsOff: true })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(sidebarFolders(page)).toHaveText(['ws-a', 'ws-b'], { timeout: 20_000 })

      await page.locator('.tb-ico[title="Settings"]').click()
      await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.set-ni').first()).toHaveText('Welcome')
      await page.locator('.set-ni', { hasText: 'Welcome' }).click()

      const pane = page.locator('.settings-modal .set-main')
      await expect(pane).toContainText('What Koloft does')
      await expect(pane).toContainText('Claude Code, Codex, Muse and Antigravity sessions')
      await expect(pane.locator('.wp-cards .wp-card')).toHaveCount(8)
      await expect(pane.locator('table.wp-diff tbody tr')).toHaveCount(7)
      await expect(pane.locator('table.wp-diff')).toContainText('Plain terminal')
      await snap(page, 'T-OB-08')

      await pane.locator('.set-row button.mini', { hasText: 'Reset tips' }).click()
      await expect.poll(() => settingsOnDisk(env).hintsOff, { timeout: 20_000 }).toBe(false)
      expect(settingsOnDisk(env).hintsSeen).toEqual([])

      await pane.locator('.set-row button.mini', { hasText: 'Show welcome again' }).click()
      await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 20_000 })
      await expectStep(page, 1)
      await expect(sidebarFolders(page)).toHaveText(['ws-a', 'ws-b'])
    } finally {
      await quitAndClose(app)
    }
  })
})

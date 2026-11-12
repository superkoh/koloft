import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installAgy,
  installCodex,
  installMuse,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  addRemoteWorkspace,
  agyReady,
  installFakeRemote,
  killFakeRemote,
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_HOST,
  REMOTE_WS_NAME
} from './helpers/remote'
import {
  addWorkspace,
  centerTerm,
  closeActiveTab,
  newSessionInWith,
  openMenu,
  readCalls,
  runIn,
  seedJsonl,
  startSessionIn,
  waitBooted,
  wsRows,
  type AgentName
} from './helpers/p1'
import { identityOf } from '../../src/shared/sessionBackend'
import type { BackendId } from '../../src/shared/types'

test.setTimeout(240_000)
test.afterEach(({ env }) => killFakeRemote(env))

const DAY_MS = 24 * 60 * 60 * 1000
const AN_AGENT_BINDS_WITHIN_MS = 60_000

function emptyPanel(page: Page) {
  return page.locator('.w-empty')
}

function pastSessions(page: Page) {
  return emptyPanel(page).locator('.recent-list', {
    has: page.locator('.recent-hd', { hasText: /^Past sessions$/ })
  })
}

function noFolderYet(env: E2EEnv): void {
  const file = path.join(env.userData, 'layout.json')
  const layout = JSON.parse(fs.readFileSync(file, 'utf8')) as { workspaces: unknown[] }
  layout.workspaces = []
  fs.writeFileSync(file, JSON.stringify(layout))
}

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

async function boundSession(page: Page, backend: BackendId, remote: boolean): Promise<string> {
  let id: string | undefined
  await expect
    .poll(
      async () => {
        const all = await page.evaluate(() => window.api.sessions.list())
        const s = all.find(
          (x) =>
            x.backendId === backend &&
            x.alive &&
            !x.butler &&
            (x.remote?.host === REMOTE_HOST || identityOf(x.sessionId).sourceId === REMOTE_HOST) ===
              remote &&
            identityOf(x.sessionId).nativeSessionId
        )
        id = s && identityOf(s.sessionId).nativeSessionId
        return !!id
      },
      { timeout: AN_AGENT_BINDS_WITHIN_MS }
    )
    .toBe(true)
  return id!
}

const BACKEND_OF: Record<AgentName, BackendId> = {
  Claude: 'claude',
  Codex: 'codex',
  Muse: 'muse',
  Antigravity: 'agy'
}

const EVERY_AGENT_ON_THIS_MAC: { label: AgentName; install?: (env: E2EEnv) => void }[] = [
  { label: 'Claude' },
  { label: 'Codex', install: (env) => installCodex(env) },
  {
    label: 'Muse',
    install: (env) => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
    }
  },
  {
    label: 'Antigravity',
    install: (env) => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    }
  }
]

const EVERY_AGENT_ON_THE_MACHINE: { label: AgentName; install?: (env: E2EEnv) => void }[] = [
  { label: 'Claude' },
  ...OTHER_AGENTS_ON_THE_MACHINE
]

const EVERY_KIND = [
  ...EVERY_AGENT_ON_THIS_MAC.map((a) => ({ ...a, remote: false })),
  ...EVERY_AGENT_ON_THE_MACHINE.map((a) => ({ ...a, remote: true }))
]

test.describe('past sessions in a folder’s empty panel', () => {
  test('the first folder added by hand lists its newest three past sessions with branch and age under the New buttons; the fourth is behind a last row that opens Restore session; a click resumes one, and once the folder has a row of its own its panel shows Recent and no Past sessions', async ({
    env
  }) => {
    const dir = path.join(env.home, 'old-work')
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const seed = (summary: string, ageMs: number): string =>
      seedJsonl(env, dir, { summary, owned: false, mtime: now - ageMs })
    const newest = seed('Fix the login redirect', DAY_MS)
    seed('Add CSV export to reports', 3 * DAY_MS)
    seed('Write the release notes', 5 * DAY_MS)
    seed('Upgrade the build to Node 22', 20 * DAY_MS)
    noFolderYet(env)
    const { app, page } = await launch(env)
    try {
      expect((await addWorkspace(page, dir)).code).toBe('added')
      await expect(emptyPanel(page).locator('.big')).toHaveText('old-work', { timeout: 20_000 })
      await expect(wsRows(page, 'old-work')).toHaveCount(0)

      const rows = pastSessions(page).locator('.recent-row')
      await expect(rows.locator('.ws-tab-title')).toHaveText(
        ['Fix the login redirect', 'Add CSV export to reports', 'Write the release notes'],
        { timeout: 20_000 }
      )
      await expect(rows.first().locator('.ws-tab-sub')).toHaveText(/ · 1d ago$/)

      await pastSessions(page).getByRole('button', { name: 'All 4 past sessions…' }).click()
      const dialog = page.getByRole('dialog', { name: 'Restore session · old-work', exact: true })
      await expect(dialog.locator('.restore-row')).toHaveCount(4, { timeout: 15_000 })
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      await rows.first().click()
      await expect
        .poll(() => readCalls(env).map((c) => c.sessionId), { timeout: AN_AGENT_BINDS_WITHIN_MS })
        .toContain(newest)
      await expect(wsRows(page, 'old-work')).toHaveCount(1)
      await expect(wsRows(page, 'old-work')).toHaveClass(/st-waiting/, {
        timeout: AN_AGENT_BINDS_WITHIN_MS
      })

      await closeActiveTab(app, page)
      await page.locator('.ws-head', { hasText: 'old-work' }).click()
      const recent = emptyPanel(page).locator('.recent-list', {
        has: page.locator('.recent-hd', { hasText: /^Recent$/ })
      })
      await expect(recent.locator('.ws-tab-title')).toHaveText(['Fix the login redirect'], {
        timeout: 20_000
      })
      await expect(pastSessions(page)).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  for (const kind of EVERY_KIND) {
    const where = kind.remote ? 'on the machine' : 'on this Mac'
    test(`a ${kind.label} session ${where} taken off the folder’s list shows in the folder’s empty panel under Past sessions, and a click there resumes that same session`, async ({
      env
    }) => {
      kind.install?.(env)
      if (kind.remote) installFakeRemote(env)
      const { app, page } = await launch(env)
      try {
        let ws = 'ws-a'
        if (kind.remote) {
          await addRemoteWorkspace(page, env)
          ws = REMOTE_WS_NAME
        }
        if (kind.label === 'Claude') await startSessionIn(page, ws, { remote: kind.remote })
        else await newSessionInWith(page, ws, kind.label)
        if (kind.label === 'Antigravity') {
          await agyReady(page)
          await runIn(page, centerTerm(page), 'first words')
        }
        const backend = BACKEND_OF[kind.label]
        const id = await boundSession(page, backend, kind.remote)
        const row = wsRows(page, ws)
        await expect(row).toHaveClass(/st-waiting/, { timeout: AN_AGENT_BINDS_WITHIN_MS })

        await closeActiveTab(app, page)
        await expect(row).toHaveClass(/cold/, { timeout: 30_000 })
        await openMenu(page, row)
        await page.locator('.menu .mi', { hasText: 'Remove from list' }).click()
        await expect(row).toHaveCount(0)
        await page.locator('.ws-head', { hasText: ws }).click()
        await expect(emptyPanel(page).locator('.big')).toHaveText(ws)

        const past = pastSessions(page).locator('.recent-row')
        await expect(past).toHaveCount(1, { timeout: 30_000 })
        await past.click()
        expect(await boundSession(page, backend, kind.remote)).toBe(id)
        await expect(row).toHaveCount(1)
        await expect(pastSessions(page)).toHaveCount(0)
      } finally {
        await quitAndClose(app)
      }
    })
  }
})

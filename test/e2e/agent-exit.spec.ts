import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agySessionCalls,
  installAgy,
  installCodex,
  installMuse,
  museCalls,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import { codexCalls } from './helpers/codex'
import {
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  killSession,
  menuItemTexts,
  newSessionInWith,
  openMenu,
  processAlive,
  readCalls,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  switchToRow,
  termIds,
  terminalText,
  waitBooted,
  wsGroup,
  wsRows
} from './helpers/p1'

test.setTimeout(120_000)

const exitLog = (env: E2EEnv): string => path.join(env.userData, 'agent-exits.log')

const loggedExits = (env: E2EEnv): string[] =>
  fs.existsSync(exitLog(env))
    ? fs
        .readFileSync(exitLog(env), 'utf8')
        .split('\n')
        .filter((l) => / tab \S+ (exited with code|was killed by signal) /.test(l))
    : []

const AGENT = {
  claude: {
    label: 'Claude',
    install: (): void => {},
    calls: (env: E2EEnv): number => readCalls(env).length
  },
  codex: {
    label: 'Codex',
    install: installCodex,
    calls: (env: E2EEnv): number => codexCalls(env).length
  },
  muse: {
    label: 'Muse',
    install: (env: E2EEnv): void => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
    },
    calls: (env: E2EEnv): number => museCalls(env).length
  },
  agy: {
    label: 'Antigravity',
    install: (env: E2EEnv): void => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    },
    calls: (env: E2EEnv): number => agySessionCalls(env).length
  }
} as const

const startupExitFile = (env: E2EEnv, backend: keyof typeof AGENT): string =>
  path.join(env.home, `fake-${backend}-exit`)

test.describe('an agent that exits on its own keeps its tab: the row says so, the last screen stays, ⇧⌘R starts it again', () => {
  for (const backend of ['codex', 'muse', 'agy'] as const)
    test(`when ${AGENT[backend].label} dies before its session starts, the tab keeps its row and last screen, logs that screen, and ⇧⌘R starts it again in the same tab`, async ({
      env
    }) => {
      const agent = AGENT[backend]
      agent.install(env)
      const failOnStart = startupExitFile(env, backend)
      fs.writeFileSync(failOnStart, '3')
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await newSessionInWith(page, 'ws-a', agent.label)
        await expect(page.locator('.toast-msg')).toHaveText(
          `${agent.label} closed before the session started (exit code 3)`,
          { timeout: 20_000 }
        )

        const row = wsRows(page, 'ws-a')
        await expect(row).toHaveCount(1)
        await expect(row).toHaveClass(/\bcold\b/)
        await expect(row).toHaveClass(/\bactive\b/)
        await expect(row.locator('.ws-tab-sub')).toHaveText('main · exited (code 3)')
        await expect.poll(() => termIds(page)).toHaveLength(1)
        const [tabId] = await termIds(page)
        await expect
          .poll(() => terminalText(page, tabId))
          .toContain(`[Koloft] ${agent.label} closed before the session started (exit code 3)`)
        expect(await terminalText(page, tabId)).toContain(`${agent.label} fixture startup failure`)
        await expect.poll(() => loggedExits(env)).toHaveLength(1)
        expect(loggedExits(env)[0]).toContain(`${backend} tab ${tabId} exited with code 3`)
        expect(fs.readFileSync(exitLog(env), 'utf8')).toContain(
          `  | ${agent.label} fixture startup failure`
        )
        if (backend === 'codex') await snap(page, 'agent-exit-kept-row')
        const callsBefore = agent.calls(env)

        fs.rmSync(failOnStart)
        await sendShortcut(app, 'shortcut:restart-session')
        await expect.poll(() => agent.calls(env), { timeout: 30_000 }).toBe(callsBefore + 1)
        await expect(row).toHaveCount(1)
        // AGY§8
        if (backend === 'agy') {
          await expect.poll(() => termIds(page)).not.toContain(tabId)
          await runIn(page, centerTerm(page), 'hello again')
        }
        await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
        await expect(row).toHaveClass(/\bactive\b/)
        await expect(row.locator('.ws-tab-sub')).not.toContainText('exited')
        expect(await termIds(page)).toHaveLength(1)
      } finally {
        await quitAndClose(app)
      }
    })

  test('a Claude that dies before it starts keeps a row whose Close ends it for good; a tab the user closes logs nothing', async ({
    env
  }) => {
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      fs.writeFileSync(env.claudeExitFile, '1')
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-b' }))
      await page.locator('.menu .mi', { hasText: /^New session/ }).click()
      await expect(page.locator('.toast-msg')).toHaveText(
        'Claude closed before the session started (exit code 1)',
        { timeout: 20_000 }
      )
      const kept = wsRows(page, 'ws-b')
      await expect(kept).toHaveCount(1)
      await expect(kept.locator('.ws-tab-sub')).toHaveText('main · exited (code 1)')
      await expect.poll(() => loggedExits(env)).toHaveLength(1)
      expect(loggedExits(env)[0]).toMatch(/ claude tab \S+ exited with code 1 /)

      await openMenu(page, kept)
      expect(await menuItemTexts(page)).toEqual(['Start again⇧⌘R', 'Close⌘W'])
      await page.locator('.menu .mi', { hasText: /^Close/ }).click()
      await expect(kept).toHaveCount(0, { timeout: 20_000 })
      await expect.poll(() => termIds(page)).toHaveLength(0)

      fs.rmSync(env.claudeExitFile)
      await startSessionIn(page, 'ws-a')
      const closed = wsRows(page, 'ws-a')
      await expect(closed).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await openMenu(page, closed)
      await page.locator('.menu .mi', { hasText: /^Close$/ }).click()
      await expect(closed).toHaveClass(/\bcold\b/, { timeout: 20_000 })
      await expect(closed.locator('.ws-tab-sub')).toHaveText('main')
      expect(loggedExits(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  for (const backend of ['claude', 'codex', 'muse', 'agy'] as const)
    test(`when ${AGENT[backend].label} that koloft session new started dies before it starts, its row stays; ⇧⌘R starts it again in the same tab, still listed under the session that started it`, async ({
      env
    }) => {
      const agent = AGENT[backend]
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const exitFile = startupExitFile(env, backend)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startSessionIn(page, 'ws-a', backend === 'claude' ? {} : { method: 'Claude' })
        const parentTab = (await wsRows(page, 'ws-a').first().getAttribute('data-tab-id'))!
        fs.writeFileSync(exitFile, '1')
        await runIn(
          page,
          centerTerm(page),
          `/koloft session new --backend ${backend} --name kid -- hello`
        )
        const kid = wsRows(page, 'ws-a').filter({ hasText: 'kid' })
        await expect(kid.locator('.ws-tab-sub')).toContainText('exited (code 1)', {
          timeout: 30_000
        })
        const callsBefore = agent.calls(env)

        fs.rmSync(exitFile)
        await switchToRow(page, kid)
        await sendShortcut(app, 'shortcut:restart-session')
        await expect.poll(() => agent.calls(env), { timeout: 30_000 }).toBe(callsBefore + 1)
        await expect(kid).toHaveCount(1)
        await expect(kid).toHaveClass(/st-waiting/, { timeout: 30_000 })
        await expect(kid.locator('.ws-tab-sub')).not.toContainText('exited')
        expect(await termIds(page)).toHaveLength(2)
        await expect(
          wsGroup(page, 'ws-a').locator(
            `.ws-tab[data-tab-id="${parentTab}"] + .ws-subtabs > .ws-tab`
          )
        ).toHaveClass(/st-waiting/)
      } finally {
        await quitAndClose(app)
      }
    })

  test('a kept tab closes by itself once its session runs again in another tab, as when another session resumes it, so no tab stays open with no row', async ({
    env
  }) => {
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const killed = wsRows(page, 'ws-a')
      await expect(killed).toHaveClass(/st-waiting/, { timeout: 30_000 })
      const [first] = readCalls(env)
      killSession(first.pid, env)
      await expect(killed.locator('.ws-tab-sub')).toContainText(/killed|exited/, {
        timeout: 20_000
      })
      const [keptTab] = await termIds(page)

      await startSessionIn(page, 'ws-b')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await runIn(page, centerTerm(page), `/koloft session resume ${first.sessionId}`)

      await expect
        .poll(() => readCalls(env).filter((c) => c.argv.includes(first.sessionId)).length, {
          timeout: 30_000
        })
        .toBe(1)
      await expect.poll(() => termIds(page), { timeout: 30_000 }).not.toContain(keptTab)
      expect(await termIds(page)).toHaveLength(2)
      await expect(killed).toHaveCount(1)
      await expect(killed.locator('.ws-tab-sub')).not.toContainText(/killed|exited/)
    } finally {
      await quitAndClose(app)
    }
  })
})

test.describe('Antigravity quit with /exit leaves the list for Restore session, as Claude, Codex and Muse do', () => {
  // AGY§1
  test('/exit typed inside Antigravity ends it, its row leaves the list, and Restore session brings the same conversation back', async ({
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
      const [first] = agySessionCalls(env)
      const row = wsRows(page, 'ws-a')
      await runIn(page, centerTerm(page), 'keep me')
      await expect(row.filter({ hasText: 'keep me' })).toHaveClass(/st-waiting/, {
        timeout: 30_000
      })
      const { id: conversation } = await agyConversationOnceFirstTurnEnded(page)

      await runIn(page, centerTerm(page), '/exit')
      await expect.poll(() => processAlive(first.pid)).toBe(false)
      await expect(row).toHaveCount(0)

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      await history.getByRole('button').filter({ hasText: 'keep me' }).click()
      await expect.poll(() => agySessionCalls(env).length).toBe(2)
      expect(agySessionCalls(env)[1].argv).toContain(`--conversation=${conversation}`)
      await expect(row.filter({ hasText: 'keep me' })).toHaveClass(/st-waiting/, {
        timeout: 30_000
      })
    } finally {
      await quitAndClose(app)
    }
  })
})

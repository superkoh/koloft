import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Locator, Page } from '@playwright/test'
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
import { runGit, setupGitFixture } from './helpers/gitFixture'
import { installHalfWayWorktreeRemoval, installStallingGit } from './helpers/gitSpawnLog'
import { codexAnswers, fakeCodexLog, startLocalSession, type CodexWireLine } from './helpers/codex'
import { setupChangeFixture } from './helpers/filesFixture'
import { WORKBENCH } from './helpers/workbench'
import {
  centerTerm,
  chooseBackend,
  gitInit,
  killSession,
  newSessionInWith,
  notesOnDisk,
  notesPath,
  openMenu,
  openSessionTerminal,
  openWorktreeSession,
  panelTerm,
  processAlive,
  readCalls,
  runIn,
  startSessionIn,
  termIds,
  waitBooted,
  waitForCalls,
  wsGroup,
  wsRows
} from './helpers/p1'

const CENTER = '.term-island .term-wrap'
const PANEL = '.wb-panel .wb-term'
const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000
const HOLD_KID_BEFORE_IT_BINDS_MS = 5_000
const A_WORKTREE_REMOVAL_SLOWER_THAN_A_QUICK_GIT_CALL_MS = 7_000
const A_REMOVAL_STILL_DELETING_WHEN_CLOSE_ASKS_MS = 3_000
const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_SLEEP_MS = 3000

function shownTermText(page: Page, box: string): Promise<string> {
  return page.evaluate((sel) => {
    const terms =
      (
        window as unknown as {
          __koloftTerms?: Record<
            string,
            {
              element?: HTMLElement
              buffer: {
                active: {
                  length: number
                  getLine(
                    i: number
                  ): { isWrapped: boolean; translateToString(trim?: boolean): string } | undefined
                }
              }
            }
          >
        }
      ).__koloftTerms ?? {}
    for (const t of Object.values(terms)) {
      const wrap = t.element?.closest(sel)
      if (!t.element || !wrap || wrap.getClientRects().length === 0) continue
      if (getComputedStyle(t.element).visibility === 'hidden') continue
      const b = t.buffer.active
      let text = ''
      for (let i = 0; i < b.length; i++) {
        const line = b.getLine(i)
        if (!line) continue
        text += (i === 0 || line.isWrapped ? '' : '\n') + line.translateToString(true)
      }
      return text
    }
    return ''
  }, box)
}

async function koloftExits(page: Page): Promise<string[]> {
  const text = await shownTermText(page, CENTER)
  return [...text.matchAll(/\[fake-(?:claude|codex)\] koloft exit=(\d+)/g)].map((m) => m[1])
}

async function koloftInSession(page: Page, args: string): Promise<string> {
  const before = (await koloftExits(page)).length
  await runIn(page, centerTerm(page), `/koloft ${args}`)
  await expect
    .poll(async () => (await koloftExits(page)).length, {
      timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS
    })
    .toBe(before + 1)
  return (await koloftExits(page))[before]
}

async function openCron(page: Page, wsName: string): Promise<Locator> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
  const dlg = page.locator('.modal.cronjobs')
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

async function aChildWhoseParentTabWasClosed(
  page: Page,
  env: E2EEnv,
  backend: 'claude' | 'codex'
): Promise<{ parentId: string; kidTab: string }> {
  await startLocalSession(page, env, backend)
  const parentTab = (await wsRows(page, 'ws-a').first().getAttribute('data-tab-id'))!
  const parent = (await page.evaluate(() => window.api.sessions.list())).find(
    (s) => s.tabId === parentTab
  )!
  expect(await koloftInSession(page, 'session new -- report back when done')).toBe('0')
  const kidRow = wsGroup(page, 'ws-a').locator(
    `.ws-tab[data-tab-id="${parentTab}"] + .ws-subtabs > .ws-tab`
  )
  await expect(kidRow).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
  const kidTab = (await kidRow.getAttribute('data-tab-id'))!
  await page.evaluate((tab) => window.api.terminal.kill(tab), parentTab)
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.api.sessions.list())).some(
        (s) => s.alive && s.tabId === parentTab
      )
    )
    .toBe(false)
  return { parentId: parent.nativeSessionId ?? parent.sessionId, kidTab }
}

test.describe('`koloft` inside a Koloft tab: the command Koloft puts on PATH reaches Koloft and acts for the session it runs in', () => {
  for (const backend of ['claude', 'codex'] as const)
    test(`koloft cron add from a ${backend} session adds a job to its pinned workspace, shown in Scheduled jobs and in koloft cron list, and show and off find it by its name with spaces given without quotes`, async ({
      env
    }) => {
      test.setTimeout(120_000)
      if (backend === 'codex') installCodex(env)
      seedSettings(env, { hintsOff: true })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startLocalSession(page, env, backend)

        expect(
          await koloftInSession(page, 'cron add --name "Nightly tests" --daily 09:00 -- say hi')
        ).toBe('0')
        expect(await koloftInSession(page, 'cron list')).toBe('0')
        expect(await shownTermText(page, CENTER)).toMatch(/^1\. Nightly tests · /m)
        expect(await koloftInSession(page, 'cron off Nightly tests')).toBe('0')
        expect(await koloftInSession(page, 'cron show Nightly tests')).toBe('0')
        expect(await shownTermText(page, CENTER)).toMatch(/^On: no · no next run$/m)

        const dlg = await openCron(page, 'ws-a')
        await expect(
          dlg
            .locator('.job-row')
            .filter({ has: page.locator('.job-name', { hasText: /^Nightly tests$/ }) })
        ).toHaveCount(1)
      } finally {
        await quitAndClose(app)
      }
    })

  for (const backend of ['claude', 'codex'] as const)
    test(`koloft open and koloft diff from a ${backend} session show a file, then its change as a diff, in that session's Workbench, a source file too, and koloft note reads and adds to its workspace note`, async ({
      env
    }) => {
      test.setTimeout(120_000)
      const appTs = path.join(env.workspaces.a, 'src', 'app.ts')
      fs.mkdirSync(path.dirname(appTs), { recursive: true })
      fs.writeFileSync(appTs, 'export const app = 1\n')
      setupChangeFixture(env.workspaces.a)
      fs.appendFileSync(path.join(env.workspaces.a, 'README.md'), 'a line the agent added\n')
      fs.appendFileSync(appTs, 'export const addedByTheAgent = 2\n')
      const note = notesPath(env, env.workspaces.a)
      fs.mkdirSync(path.dirname(note), { recursive: true })
      fs.writeFileSync(note, 'from the owner')
      if (backend === 'codex') installCodex(env)
      seedSettings(env, { hintsOff: true })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startLocalSession(page, env, backend)

        expect(await koloftInSession(page, 'open README.md')).toBe('0')
        await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md')
        await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft-e2e-alpha')

        const viewMode = page.locator(WORKBENCH.viewSegOn)
        await expect(viewMode).toHaveText('Rendered')
        expect(await koloftInSession(page, 'diff README.md')).toBe('0')
        await expect(viewMode).toHaveText('Diff')
        await expect(page.locator(WORKBENCH.readingBody)).toContainText('a line the agent added')

        expect(await koloftInSession(page, 'open src/app.ts')).toBe('0')
        await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('src/app.ts')
        await expect(page.locator(WORKBENCH.readingBody)).toContainText('export const app = 1')
        expect(await koloftInSession(page, 'diff src/app.ts')).toBe('0')
        await expect(viewMode).toHaveText('Diff')
        await expect(page.locator(WORKBENCH.readingBody)).toContainText('addedByTheAgent')

        expect(await koloftInSession(page, 'note')).toBe('0')
        expect(await shownTermText(page, CENTER)).toContain('from the owner')
        expect(await koloftInSession(page, 'note append from the agent')).toBe('0')
        expect(notesOnDisk(env, env.workspaces.a)).toBe('from the owner\nfrom the agent\n')
      } finally {
        await quitAndClose(app)
      }
    })

  test('koloft session new starts a sibling in the same workspace, named and titled by a short title made from its task, nested under the caller while it is still starting, and leaves the caller on screen', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const callerTabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
    expect(callerTabId).toBeTruthy()
    const callsBefore = readCalls(env).length
    const caller = wsGroup(page, 'ws-a').locator(`.ws-tab[data-tab-id="${callerTabId}"]`)
    const nested = wsGroup(page, 'ws-a').locator(
      `.ws-tab[data-tab-id="${callerTabId}"] + .ws-subtabs > .ws-tab`
    )
    fs.writeFileSync(path.join(env.home, 'fake-claude-delay'), String(HOLD_KID_BEFORE_IT_BINDS_MS))

    expect(await koloftInSession(page, 'session new -- hello')).toBe('0')

    await expect(nested).toHaveClass(/\bst-pending\b/, { timeout: 30_000 })
    await expect(wsRows(page, 'ws-a')).toHaveCount(2)
    const calls = await waitForCalls(env, callsBefore + 1, 60_000)
    const kid = calls[calls.length - 1]
    expect(kid.argv[kid.argv.indexOf('--name') + 1]).toBe('hello (titled)')
    expect(kid.firstPrompt).toMatch(/\n\nhello$/)
    await expect(nested).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
    await expect(nested.locator('.ws-tab-title', { hasText: /^hello \(titled\)$/ })).toHaveCount(
      1,
      {
        timeout: 30_000
      }
    )
    await expect(wsGroup(page, 'ws-a').locator('.ws-tab.active')).toHaveAttribute(
      'data-tab-id',
      callerTabId!
    )

    await expect(nested.locator('.ws-tab-unread')).toHaveCount(1, { timeout: 30_000 })
    await caller.locator('.ws-tab-fold').click()
    await expect(nested).toHaveCount(0)
    await expect(caller.locator('.ws-unread-count')).toHaveText('1')
    await expect(caller.locator('.ws-tab-parked:not(.ws-unread-count)')).toHaveText('1')
    await caller.locator('.ws-tab-fold').click()
    await expect(nested).toHaveCount(1)
    await expect(caller.locator('.ws-tab-parked')).toHaveCount(0)
  })

  test('koloft session list gives every open session’s transcript, Claude, Codex, Muse and Antigravity alike, as a file on this Mac that holds what the session was asked', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodex(env)
    installMuse(env)
    installAgy(env)
    trustInMuse(env, env.workspaces.a)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      const children = [
        { label: 'Codex', backend: 'codex', marker: 'codex-marker' },
        { label: 'Muse', backend: 'muse', marker: 'muse-marker' },
        { label: 'Antigravity', backend: 'agy', marker: 'agy-marker' }
      ]
      for (const { backend, marker } of children)
        expect(await koloftInSession(page, `session new --backend ${backend} -- ${marker}`)).toBe(
          '0'
        )
      await expect(wsRows(page, 'ws-a')).toHaveCount(4, { timeout: 60_000 })

      const listed = async (): Promise<Record<string, string>> => {
        await koloftInSession(page, 'session list')
        const text = await shownTermText(page, CENTER)
        const lastList = text.slice(text.lastIndexOf('(you) · Claude'))
        const found: Record<string, string> = {}
        for (const m of lastList.matchAll(
          /· (Claude|Codex|Muse|Antigravity) · .*· transcript: (\S+)$/gm
        ))
          found[m[1]] = m[2]
        return found
      }
      const holds = (file: string | undefined, words: string): boolean =>
        !!file && fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(words)
      await expect
        .poll(
          async () => {
            const files = await listed()
            return [
              fs.existsSync(files.Claude ?? ''),
              ...children.map(({ label, marker }) => holds(files[label], marker))
            ]
          },
          { timeout: 90_000, intervals: [3_000] }
        )
        .toEqual([true, true, true, true])
    } finally {
      await quitAndClose(app)
    }
  })

  test('with Codex switched off in Settings ▸ Sessions, koloft session new --backend codex and a new Codex tab both start nothing and say Codex is turned off', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodex(env)
    seedSettings(env, {
      hintsOff: true,
      sessionMethods: {
        defaultBackend: 'claude',
        enabled: { claude: true, codex: false, muse: true, agy: true }
      }
    })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      expect(await koloftInSession(page, 'session new --backend codex -- hello')).not.toBe('0')
      expect((await shownTermText(page, CENTER)).replace(/\s+/g, '')).toContain(
        'CodexisturnedoffinSettings▸Sessions'
      )
      const refusal = await page.evaluate(async (cwd) => {
        try {
          await window.api.terminal.create({ kind: 'codex', cwd })
          return ''
        } catch (e) {
          return String(e)
        }
      }, env.workspaces.a)
      expect(refusal).toContain('Codex is turned off in Settings ▸ Sessions')
      await expect(wsRows(page, 'ws-a')).toHaveCount(1)
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0031
  test('a Claude child started by koloft session new has its reply-language hook start from the owner’s last words to its starter, not from its own task', async ({
    page,
    env
  }) => {
    const ownerWords = 'make the sidebar a little darker'
    const saidFiles = (): string[] => {
      const dir = path.join(env.userData, 'hook-sessions')
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.said'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim())
    }
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const callerTabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
    const kid = wsGroup(page, 'ws-a').locator(
      `.ws-tab[data-tab-id="${callerTabId}"] + .ws-subtabs > .ws-tab`
    )
    await runIn(page, centerTerm(page), ownerWords)
    await expect.poll(saidFiles, { timeout: 30_000 }).toEqual([ownerWords])
    expect(await koloftInSession(page, 'session new -- hello')).toBe('0')
    await expect(kid).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
    expect(saidFiles()).toEqual([ownerWords, ownerWords])
  })

  // CODEX§17
  test('a Codex session started by koloft session new --name in a Codex session is nested under it, titled by that name, which Koloft gives its thread with thread/name/set, and the reply that ends its first turn, which it never sent back itself, is handed to its starter', async ({
    env
  }) => {
    test.setTimeout(120_000)
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Codex')
      const caller = wsRows(page, 'ws-a')
      await expect(caller).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const callerTabId = await caller.getAttribute('data-tab-id')

      expect(await koloftInSession(page, 'session new --name kid-codex -- hello')).toBe('0')

      const kid = wsGroup(page, 'ws-a').locator(
        `.ws-tab[data-tab-id="${callerTabId}"] + .ws-subtabs > .ws-tab`
      )
      await expect(kid).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await expect(wsRows(page, 'ws-a')).toHaveCount(2)
      await expect(kid.locator('.ws-tab-title', { hasText: /^kid-codex$/ })).toHaveCount(1)
      const wire = path.join(env.home, 'fake-codex-wire.jsonl')
      const wireText = (): string => (fs.existsSync(wire) ? fs.readFileSync(wire, 'utf8') : '')
      await expect
        .poll(wireText, { timeout: 60_000 })
        .toMatch(
          /"thread\/queue\/add".+\(From the session \\".+\\", id \S+:\) Codex fixture answered: /
        )
      expect(wireText()).toMatch(/"thread\/name\/set".*"name":"kid-codex"/)
    } finally {
      await quitAndClose(app)
    }
  })

  for (const backend of ['claude', 'codex'] as const)
    test(`a ${backend} child reports to the ${backend} session that started it after that session’s tab was closed: koloft session send with the id from its first message starts the parent again and delivers the report marked with who sent it`, async ({
      env
    }) => {
      test.setTimeout(120_000)
      if (backend === 'codex') installCodex(env)
      seedSettings(env, { hintsOff: true })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        const { parentId, kidTab } = await aChildWhoseParentTabWasClosed(page, env, backend)
        await page.evaluate(
          ([tab, line]) => window.api.terminal.write(tab, line + '\r'),
          [kidTab, `/koloft session send ${parentId} all done`]
        )
        const parentGot = (): string => {
          const file = path.join(
            env.home,
            backend === 'claude' ? 'fake-claude-peer.jsonl' : 'fake-codex-wire.jsonl'
          )
          return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
        }
        await expect
          .poll(parentGot, { timeout: 60_000 })
          .toMatch(/\(From the session \\".+\\", id \S+:\) all done/)
      } finally {
        await quitAndClose(app)
      }
    })

  // CODEX§34
  test('a codex child’s report whose turn has just begun in the reopened codex parent when that parent’s app-server dies is sent again, once, after Koloft starts a new app-server and the parent’s screen joins it, and the parent answers it', async ({
    env
  }) => {
    test.setTimeout(120_000)
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    fs.writeFileSync(path.join(env.home, 'fake-codex-reconnects'), '')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const { parentId, kidTab } = await aChildWhoseParentTabWasClosed(page, env, 'codex')
      fs.writeFileSync(path.join(env.home, 'fake-codex-server-dies-on'), ':) all done')
      await page.evaluate(
        ([tab, line]) => window.api.terminal.write(tab, line + '\r'),
        [kidTab, `/koloft session send ${parentId} all done`]
      )
      const wire = (): CodexWireLine[] => fakeCodexLog<CodexWireLine>(env, 'fake-codex-wire.jsonl')
      const report = /^\(From the session ".+", id \S+:\) all done$/
      const answered = /^Codex fixture answered: \(From the session ".+", id \S+:\) all done$/
      await expect
        .poll(() => codexAnswers(wire()).filter((text) => answered.test(text)), {
          timeout: 60_000
        })
        .toHaveLength(1)
      expect(
        fakeCodexLog<{ text: string }>(env, 'fake-codex-server-deaths.jsonl').map((d) =>
          report.test(d.text)
        )
      ).toEqual([true])
      expect(fakeCodexLog(env, 'fake-codex-reconnects.jsonl')).toEqual([
        expect.objectContaining({ sessionId: parentId })
      ])
      expect(
        wire().filter(
          ({ frame }) =>
            frame.method === 'thread/queue/add' &&
            JSON.stringify(frame.params).includes(':) all done')
        )
      ).toHaveLength(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a codex child reports to the codex worktree session that started it after that session’s tab was closed and its untouched worktree went with it: koloft session send makes the worktree again in place and delivers the report', async ({
    env
  }) => {
    test.setTimeout(120_000)
    installCodex(env)
    gitInit(env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'ws-a')
      await dlg.locator('input').fill('reports-here')
      await chooseBackend(page, 'Codex')
      const parentRow = wsRows(page, 'ws-a').first()
      await expect(parentRow).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const parentTab = (await parentRow.getAttribute('data-tab-id'))!
      const parent = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.tabId === parentTab
      )!
      const parentId = parent.nativeSessionId ?? parent.sessionId
      const tree = parent.cwd
      expect(tree).not.toBe(env.workspaces.a)

      expect(await koloftInSession(page, 'session new -- report back when done')).toBe('0')
      const kidRow = wsGroup(page, 'ws-a').locator(
        `.ws-tab[data-tab-id="${parentTab}"] + .ws-subtabs > .ws-tab`
      )
      await expect(kidRow).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const kidTab = (await kidRow.getAttribute('data-tab-id'))!

      await page.evaluate((tab) => window.api.terminal.kill(tab), parentTab)
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      await page.evaluate(
        ([tab, line]) => window.api.terminal.write(tab, line + '\r'),
        [kidTab, `/koloft session send ${parentId} all done`]
      )
      const wire = path.join(env.home, 'fake-codex-wire.jsonl')
      await expect
        .poll(() => fs.readFileSync(wire, 'utf8'), { timeout: 60_000 })
        .toMatch(/\(From the session \\".+\\", id \S+:\) all done/)
      expect(fs.existsSync(tree)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  for (const backend of ['muse', 'agy'] as const)
    test(`a ${backend} session that koloft session new starts in a folder ${backend} never trusted gets past ${backend}’s trust question with nobody at its terminal`, async ({
      env
    }) => {
      test.setTimeout(120_000)
      if (backend === 'muse') installMuse(env)
      else installAgy(env)
      seedSettings(env, { hintsOff: true })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startSessionIn(page, 'ws-a', { method: 'Claude' })

        expect(
          await koloftInSession(page, `session new --workspace ws-b --backend ${backend} -- hello`)
        ).toBe('0')

        await expect(wsRows(page, 'ws-b').first()).toHaveClass(/\bst-waiting\b/, {
          timeout: 60_000
        })
      } finally {
        await quitAndClose(app)
      }
    })

  test('koloft session new --workspace starts the sibling in another sidebar workspace, as a top-level row there', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const callsBefore = readCalls(env).length

    expect(await koloftInSession(page, 'session new --workspace ws-b --name kid -- hello')).toBe(
      '0'
    )

    await expect(wsRows(page, 'ws-b')).toHaveCount(1, { timeout: 60_000 })
    const calls = await waitForCalls(env, callsBefore + 1, 60_000)
    expect(calls[calls.length - 1].cwd).toMatch(/\/ws-b$/)
    await expect(wsRows(page, 'ws-a')).toHaveCount(1)
    await expect(wsGroup(page, 'ws-b').locator('.ws-tabs > .ws-tab')).toHaveCount(1)
  })

  test("koloft in a session's Workbench shell acts for the session that owns the shell", async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)

    await runIn(page, panelTerm(page), 'koloft help; echo "help-exit=$?"')
    await expect
      .poll(async () => /help-exit=(\d+)/.exec(await shownTermText(page, PANEL))?.[1], {
        timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS
      })
      .toBe('0')
  })

  test('koloft session close refuses while the worktree holds uncommitted work, then closes the session for good: tab, row, worktree and branch, even when removing the worktree takes longer than a few seconds', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupGitFixture(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('done')
      await page.keyboard.press('Enter')
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveCount(1, { timeout: 60_000 })
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const tree = path.join(fx.clone, '.claude', 'worktrees', 'done')
      await expect.poll(() => fs.existsSync(path.join(tree, 'NOTES.md'))).toBe(true)

      expect(await koloftInSession(page, 'session close')).toBe('1')
      expect(await shownTermText(page, CENTER)).toContain('nothing was closed')
      await expect(rows).toHaveCount(1)
      expect(fs.existsSync(tree)).toBe(true)

      fs.rmSync(path.join(tree, 'NOTES.md'))
      installStallingGit(env, {
        root: fx.clone,
        subcommand: 'worktree',
        verb: 'remove',
        lastArg: tree,
        ms: A_WORKTREE_REMOVAL_SLOWER_THAN_A_QUICK_GIT_CALL_MS
      })
      await runIn(page, centerTerm(page), '/koloft session close')
      await expect(rows).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', 'worktree-done').trim()).toBe('')
      expect(runGit(fx.clone, 'worktree', 'list')).not.toContain('done')
    } finally {
      await quitAndClose(app)
    }
  })

  test('koloft session close right after koloft session stop on a scheduled run waits while Koloft is still deleting the run’s worktree, then closes it on the first try: row, worktree and branch; a run still open closes the same way with no stop first', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupGitFixture(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('caller')
      await page.keyboard.press('Enter')
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })

      expect(await koloftInSession(page, 'cron add --name tidy --daily 09:00 -- hello')).toBe('0')
      expect(await koloftInSession(page, 'cron run tidy')).toBe('0')
      const runRow = rows.filter({ has: page.locator('.ws-tab-cron') })
      await expect(runRow).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const run = readCalls(env).find((c) => c.argv[c.argv.indexOf('-w') + 1]?.startsWith('tidy-'))!
      const wt = run.argv[run.argv.indexOf('-w') + 1]
      const tree = path.join(fx.clone, '.claude', 'worktrees', wt)

      const halfWay = installHalfWayWorktreeRemoval(
        env,
        wt,
        A_REMOVAL_STILL_DELETING_WHEN_CLOSE_ASKS_MS
      )
      expect(await koloftInSession(page, `session stop ${run.sessionId}`)).toBe('0')
      await expect.poll(() => fs.existsSync(halfWay), { timeout: 30_000 }).toBe(true)
      expect(await koloftInSession(page, `session close ${run.sessionId}`)).toBe('0')
      await expect(runRow).toHaveCount(0, { timeout: 30_000 })
      expect(fs.existsSync(tree)).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', `worktree-${wt}`).trim()).toBe('')
      await expect(rows).toHaveCount(1)

      const before = readCalls(env).length
      expect(await koloftInSession(page, 'cron run tidy')).toBe('0')
      const next = (await waitForCalls(env, before + 1))[before]
      const nextWt = next.argv[next.argv.indexOf('-w') + 1]
      const nextTree = path.join(fx.clone, '.claude', 'worktrees', nextWt)
      await expect(runRow).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      expect(await koloftInSession(page, `session close ${next.sessionId}`)).toBe('0')
      await expect(runRow).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => fs.existsSync(nextTree), { timeout: 30_000 }).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', `worktree-${nextWt}`).trim()).toBe('')
    } finally {
      await quitAndClose(app)
    }
  })

  test('koloft session close in a worktree session that Koloft resumed from the repo root after a restart still removes its worktree and branch', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const fx = setupGitFixture(env)
    const tree = path.join(fx.clone, '.claude', 'worktrees', 'again')
    const before = await launchApp(env)
    try {
      const page = await before.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('again')
      await page.keyboard.press('Enter')
      await expect(wsRows(page, 'repo')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
    } finally {
      await quitAndClose(before)
    }

    const after = await launchApp(env)
    try {
      const page = await after.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const resumed = readCalls(env).at(-1)!
      expect(resumed.argv).toContain('--resume')
      expect(resumed.cwd).toBe(fs.realpathSync(fx.clone))

      fs.rmSync(path.join(tree, 'NOTES.md'), { force: true })
      await runIn(page, centerTerm(page), '/koloft session close')
      await expect(rows).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', 'worktree-again').trim()).toBe('')
    } finally {
      await quitAndClose(after)
    }
  })

  test('koloft session close <child> closes a session the caller started in a worktree, only once nothing in it would be lost, and leaves the caller open', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupGitFixture(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('parent')
      await page.keyboard.press('Enter')
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveCount(1, { timeout: 60_000 })
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const callerTabId = await rows.getAttribute('data-tab-id')
      expect(await koloftInSession(page, 'session new -w kid --name kid -- hello')).toBe('0')
      await expect(rows).toHaveCount(2, { timeout: 60_000 })
      const child = rows.and(page.locator(`.ws-tab:not([data-tab-id="${callerTabId}"])`))
      await expect(child).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const childTabId = await child.getAttribute('data-tab-id')
      const tree = path.join(fx.clone, '.claude', 'worktrees', 'kid')
      expect(fs.existsSync(tree)).toBe(true)

      fs.writeFileSync(path.join(tree, 'left-behind.txt'), 'not committed')
      expect(await koloftInSession(page, `session close ${childTabId}`)).toBe('1')
      expect(await shownTermText(page, CENTER)).toContain('left-behind.txt')
      await expect(rows).toHaveCount(2)

      fs.rmSync(path.join(tree, 'left-behind.txt'))
      expect(await koloftInSession(page, `session close ${childTabId}`)).toBe('0')
      await expect(rows).toHaveCount(1, { timeout: 30_000 })
      await expect(rows).toHaveAttribute('data-tab-id', callerTabId!)
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', 'worktree-kid').trim()).toBe('')
    } finally {
      await quitAndClose(app)
    }
  })

  test('koloft session close <child> whose worktree git cannot delete tells the caller that started it, in git’s own words, with the commands that finish it; once they ran, closing again works', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupGitFixture(env)
    fs.appendFileSync(path.join(fx.clone, '.git', 'info', 'exclude'), 'node_modules/\n')
    const app = await launchApp(env)
    const readOnly = path.join(fx.clone, '.claude', 'worktrees', 'kid', 'node_modules', 'ro')
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('parent')
      await page.keyboard.press('Enter')
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const callerTabId = await rows.getAttribute('data-tab-id')
      expect(await koloftInSession(page, 'session new -w kid --name kid -- hello')).toBe('0')
      await expect(rows).toHaveCount(2, { timeout: 60_000 })
      const child = rows.and(page.locator(`.ws-tab:not([data-tab-id="${callerTabId}"])`))
      await expect(child).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const childTabId = await child.getAttribute('data-tab-id')
      fs.mkdirSync(readOnly, { recursive: true })
      fs.writeFileSync(path.join(readOnly, 'pkg.js'), 'ignored')
      fs.chmodSync(readOnly, 0o555)

      expect(await koloftInSession(page, `session close ${childTabId}`)).toBe('0')
      const callerGot = (): string => {
        const file = path.join(env.home, 'fake-claude-peer.jsonl')
        if (!fs.existsSync(file)) return ''
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        return lines.map((l) => JSON.parse(l).message.content).join('\n')
      }
      await expect.poll(callerGot, { timeout: 60_000 }).toContain('Permission denied')
      expect(callerGot()).toContain('(From Koloft:) Koloft could not finish closing kid.')
      await expect(rows).toHaveCount(2)

      execFileSync('/bin/sh', ['-c', /run: (.*)/.exec(callerGot())?.[1] ?? 'false'])
      expect(await koloftInSession(page, 'session close kid')).toBe('0')
      await expect(rows).toHaveCount(1, { timeout: 30_000 })
      expect(runGit(fx.clone, 'branch', '--list', 'worktree-kid').trim()).toBe('')
    } finally {
      if (fs.existsSync(readOnly)) fs.chmodSync(readOnly, 0o755)
      await quitAndClose(app)
    }
  })

  test('koloft session close also stops the background program the session left running and closes the ended session it started, worktree and branch too', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const fx = setupGitFixture(env)
    const pidFile = path.join(env.home, 'left-running.pid')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('parent')
      await page.keyboard.press('Enter')
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveCount(1, { timeout: 60_000 })
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const callerTabId = await rows.getAttribute('data-tab-id')
      const parentTree = path.join(fx.clone, '.claude', 'worktrees', 'parent')
      await expect.poll(() => fs.existsSync(path.join(parentTree, 'NOTES.md'))).toBe(true)
      fs.rmSync(path.join(parentTree, 'NOTES.md'))

      expect(await koloftInSession(page, 'session new -w kid --name kid -- hello')).toBe('0')
      await expect(rows).toHaveCount(2, { timeout: 60_000 })
      const child = rows.and(page.locator(`.ws-tab:not([data-tab-id="${callerTabId}"])`))
      await expect(child).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const kid = readCalls(env).find((c) => c.argv.includes('kid'))!
      expect(await koloftInSession(page, `session stop ${kid.sessionId}`)).toBe('0')
      await expect(child).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      const kidTree = path.join(fx.clone, '.claude', 'worktrees', 'kid')
      expect(fs.existsSync(kidTree)).toBe(true)

      const parentSession = readCalls(env)[0].sessionId
      await runIn(
        page,
        centerTerm(page),
        `/sh CLAUDE_CODE_SESSION_ID=${parentSession} nohup '${process.execPath}' -e 'setTimeout(()=>{},6e5)' '${env.home}' >/dev/null 2>&1 & echo $! > '${pidFile}'`
      )
      await expect
        .poll(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'))
        .toBeTruthy()
      const leftRunning = Number(fs.readFileSync(pidFile, 'utf8'))
      expect(processAlive(leftRunning)).toBe(true)

      expect(await koloftInSession(page, 'session close')).toBe('0')
      expect(await shownTermText(page, CENTER)).toContain(
        'Also closing the ended sessions it started:'
      )
      await expect(rows).toHaveCount(0, { timeout: 60_000 })
      await expect.poll(() => fs.existsSync(kidTree), { timeout: 30_000 }).toBe(false)
      await expect.poll(() => fs.existsSync(parentTree), { timeout: 30_000 }).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', 'worktree-*').trim()).toBe('')
      await expect.poll(() => processAlive(leftRunning), { timeout: 30_000 }).toBe(false)
    } finally {
      if (fs.existsSync(pidFile)) killSession(Number(fs.readFileSync(pidFile, 'utf8')), env)
      await quitAndClose(app)
    }
  })

  test('koloft session close <a session that went to sleep> closes its tab too, not only its row', async ({
    env
  }) => {
    test.setTimeout(180_000)
    env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
    env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_SLEEP_MS)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const rows = wsRows(page, 'ws-a')
      await startSessionIn(page, 'ws-a')
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const callerTabId = await rows.getAttribute('data-tab-id')
      const caller = rows.and(page.locator(`.ws-tab[data-tab-id="${callerTabId}"]`))
      expect(await koloftInSession(page, 'session new --name sleeper -- hello')).toBe('0')
      await expect(rows).toHaveCount(2, { timeout: 60_000 })
      const child = rows.and(page.locator(`.ws-tab:not([data-tab-id="${callerTabId}"])`))
      await expect(child).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const sleeper = (await waitForCalls(env, 2)).find((c) => c.argv.includes('sleeper'))!
      await child.click()
      await caller.click()
      const asleepTab = await child.getAttribute('data-tab-id')
      await expect.poll(() => processAlive(sleeper.pid), { timeout: 60_000 }).toBe(false)
      await expect(child).toHaveAttribute('data-tab-id', asleepTab!)
      await expect(caller).toHaveClass(/\bactive\b/)

      expect(await koloftInSession(page, `session close ${sleeper.sessionId}`)).toBe('0')
      await expect(rows).toHaveCount(1, { timeout: 30_000 })
      await expect.poll(() => termIds(page), { timeout: 30_000 }).not.toContain(asleepTab)
      await expect
        .poll(() => fs.readFileSync(path.join(env.userData, 'open-tabs.json'), 'utf8'))
        .not.toContain(sleeper.sessionId)
    } finally {
      await quitAndClose(app)
    }
  })

  test('koloft session close <child> still reaches a child its parent started before Koloft restarted, now a cold row still nested under it', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const fx = setupGitFixture(env)
    const rowOf = (page: Page, worktree: string): Locator =>
      wsRows(page, 'repo').filter({
        has: page.locator('.ws-tab-sub', { hasText: new RegExp(`^${worktree}$`) })
      })
    const before = await launchApp(env)
    try {
      const page = await before.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('parent')
      await page.keyboard.press('Enter')
      await expect(rowOf(page, 'parent')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      expect(await koloftInSession(page, 'session new -w kid --name kid -- hello')).toBe('0')
      await expect(rowOf(page, 'kid')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await openMenu(page, rowOf(page, 'kid'))
      await page.locator('.menu .mi', { hasText: /^Close$/ }).click()
      await expect(rowOf(page, 'kid')).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    } finally {
      await quitAndClose(before)
    }
    const kid = readCalls(env).find((c) => c.argv.includes('kid'))!
    const tree = path.join(fx.clone, '.claude', 'worktrees', 'kid')

    const after = await launchApp(env)
    try {
      const page = await after.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await expect(rowOf(page, 'kid')).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect(
        wsGroup(page, 'repo').locator('.ws-subtabs > .ws-tab', {
          has: page.locator('.ws-tab-sub', { hasText: /^kid$/ })
        })
      ).toHaveCount(1)
      await rowOf(page, 'parent').click()
      await expect(rowOf(page, 'parent')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })

      expect(await koloftInSession(page, `session close ${kid.sessionId}`)).toBe('0')
      await expect(rowOf(page, 'kid')).toHaveCount(0, { timeout: 30_000 })
      await expect(rowOf(page, 'parent')).toHaveCount(1)
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', 'worktree-kid').trim()).toBe('')
    } finally {
      await quitAndClose(after)
    }
  })

  // CC§13
  test('a Claude session starts with Koloft’s prompt, which sends work needing a worktree of its own to koloft session new -w', async ({
    page,
    env
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const { argv } = (await waitForCalls(env, 1))[0]
    const prompt = argv[argv.indexOf('--append-system-prompt-file') + 1]
    expect(fs.readFileSync(prompt, 'utf8')).toContain('koloft session new -w')
  })

  // CODEX§17
  test('a Codex session gets the koloft skill through its app-server, from a folder outside the Codex home it shares with the owner’s own codex', async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startLocalSession(page, env, 'codex')
      const sent = fs
        .readFileSync(path.join(env.home, 'fake-codex-wire.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              direction: string
              frame: { method?: string; params?: { extraRoots?: string[] } }
            }
        )
        .filter((e) => e.direction === 'client')
        .map((e) => e.frame)
      const [root] = sent.find((f) => f.method === 'skills/extraRoots/set')!.params!.extraRoots!
      expect(root.startsWith(env.launchEnv.CODEX_HOME!)).toBe(false)
      expect(fs.readFileSync(path.join(root, 'koloft', 'SKILL.md'), 'utf8')).toMatch(
        /^---\nname: koloft\n/
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('with agent tools off in Settings, koloft in a new session is refused, and the session starts without Koloft’s prompt', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedSettings(env, { agentTools: false })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')

      expect(await koloftInSession(page, 'help')).not.toBe('0')
      expect((await waitForCalls(env, 1))[0].argv).not.toContain('--append-system-prompt-file')
    } finally {
      await quitAndClose(app)
    }
  })
})

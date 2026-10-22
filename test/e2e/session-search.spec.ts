import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { codexCalls } from './helpers/codex'
import {
  installAgy,
  installCodex,
  installMuse,
  museSaid,
  seedSettings,
  type E2EEnv
} from './helpers/env'
import {
  readCalls,
  resumedId,
  runIn,
  centerTerm,
  closeActiveTab,
  newSessionInWith,
  seedJsonl,
  sendShortcut,
  startSessionIn,
  transcriptFile,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  agyReady,
  boundRemoteAgy,
  installCodexOnFakeRemote,
  installFakeRemote,
  installMuseOnMachine,
  installRemoteAgy,
  killFakeRemote,
  liveTmuxSessions,
  machineAgyCalls,
  machineHome,
  machineMuseCalls,
  mirrorProjectDir,
  REMOTE_HOST,
  REMOTE_WS_NAME,
  remoteDir,
  seedRemoteWorkspace
} from './helpers/remote'

test.setTimeout(180_000)

function searchDialog(page: Page): Locator {
  return page.locator('.modal.palette')
}

async function searchFor(app: ElectronApplication, page: Page, term: string): Promise<Locator> {
  const dialog = searchDialog(page)
  if (!(await dialog.isVisible())) await sendShortcut(app, 'shortcut:command-palette')
  const box = dialog.getByRole('textbox', { name: 'Ask or jump' })
  await expect(box).toBeFocused()
  if (await dialog.locator('.pal-count').isVisible()) {
    await box.press('Escape')
    await expect(dialog.locator('.pal-count')).toHaveCount(0)
  }
  await box.fill(term)
  await box.press('Alt+Enter')
  await expect(dialog.locator('.pal-count')).toHaveText(/^(No matches|\d+ conversations?)$/, {
    timeout: 30_000
  })
  return dialog
}

function hit(dialog: Locator, title: string): Locator {
  return dialog.locator('.restore-row', { hasText: title })
}

async function remoteHit(
  app: ElectronApplication,
  page: Page,
  term: string,
  title: string,
  brand: string
): Promise<Locator> {
  await expect(async () => {
    const dialog = await searchFor(app, page, term)
    await expect(hit(dialog, title)).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 60_000 })
  const found = hit(searchDialog(page), title)
  await expect(found.locator('.restore-meta')).toContainText(
    `${REMOTE_HOST}:${REMOTE_WS_NAME} · main ·`
  )
  await expect(found.getByRole('img', { name: brand, exact: true })).toBeVisible()
  return found
}

function appendReply(file: string, text: string): void {
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] }
    }) + '\n'
  )
}

function seedCodexThread(env: E2EEnv, cwd: string, name: string, reply: string): string {
  const sessions = path.join(env.home, '.codex', 'sessions')
  fs.mkdirSync(sessions, { recursive: true })
  const id = randomUUID()
  const rollout = path.join(sessions, id + '.jsonl')
  fs.writeFileSync(
    rollout,
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: name } }) + '\n'
  )
  const now = Math.floor(Date.now() / 1000) - 3600
  fs.writeFileSync(
    path.join(sessions, id + '.json'),
    JSON.stringify({
      id,
      cwd,
      path: rollout,
      name,
      preview: name,
      createdAt: now,
      updatedAt: now,
      cliVersion: '0.161.0',
      model: 'gpt-5.5',
      modelProvider: 'openai',
      source: 'cli',
      threadSource: 'user',
      ephemeral: false,
      canAcceptDirectInput: true,
      status: { type: 'idle' },
      turns: [
        {
          id: randomUUID(),
          status: 'completed',
          items: [
            { type: 'userMessage', id: randomUUID(), content: [{ type: 'text', text: name }] },
            { type: 'agentMessage', id: randomUUID(), text: reply, phase: 'final_answer' }
          ]
        }
      ]
    })
  )
  return id
}

test.describe('Search conversations (⌘P, then ⌥⏎) · finds a session by its words, in every workspace and backend, and opens it', () => {
  test('⌥⏎ turns the typed words into a search inside the palette, Esc goes back to the plain palette with the words kept, and a second Esc closes it', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    const dialog = await searchFor(app, page, 'never-said-anywhere')
    await expect(dialog.locator('.pal-count')).toHaveText('No matches')
    const box = dialog.getByRole('textbox', { name: 'Ask or jump' })
    await box.press('Escape')
    await expect(dialog.locator('.pal-count')).toHaveCount(0)
    await expect(box).toHaveValue('never-said-anywhere')
    await box.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('a cold local Claude session is found by its title or by what the model said, shows the words around the match, and resumes on click', async ({
    env
  }) => {
    const found = seedJsonl(env, env.workspaces.a, { summary: 'Benchmarks of the week' })
    appendReply(
      transcriptFile(env.home, env.workspaces.a, found),
      'I traced the crash to ZEBRA-needle-7 inside parse.ts and added a guard.'
    )
    seedJsonl(env, env.workspaces.a, { summary: 'Plain other work' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect(wsRows(page, 'ws-a')).toHaveCount(2, { timeout: 30_000 })

      let dialog = await searchFor(app, page, 'benchmarks')
      await expect(dialog.locator('.pal-count')).toHaveText('1 conversation')
      await expect(hit(dialog, 'Benchmarks of the week').locator('.restore-snippet')).toHaveCount(0)

      dialog = await searchFor(app, page, 'never-said-anywhere')
      await expect(dialog.locator('.pal-count')).toHaveText('No matches')
      await expect(dialog.locator('.restore-row')).toHaveCount(0)

      dialog = await searchFor(app, page, 'zebra-NEEDLE-7')
      await expect(dialog.locator('.pal-count')).toHaveText('1 conversation')
      const row = hit(dialog, 'Benchmarks of the week')
      await expect(row.locator('.restore-snippet b')).toHaveText('ZEBRA-needle-7')
      await expect(row.locator('.restore-snippet')).toContainText('inside parse.ts')
      await expect(row.locator('.restore-meta')).toContainText('ws-a · main ·')
      await expect(row.getByRole('img', { name: 'Claude', exact: true })).toBeVisible()
      expect(readCalls(env)).toHaveLength(0)

      await row.click()
      await expect(dialog).toHaveCount(0)
      const [call] = await waitForCalls(env, 1)
      expect(resumedId(call)).toBe(found)
    } finally {
      await quitAndClose(app)
    }
  })

  test('while typing, before any ⌥⏎, a session that only mentions the words shows under "In conversations" with the words around the match, and ↓ ⏎ resumes it', async ({
    env
  }) => {
    const found = seedJsonl(env, env.workspaces.a, { summary: 'Benchmarks of the week' })
    appendReply(
      transcriptFile(env.home, env.workspaces.a, found),
      'I traced the crash to ZEBRA-needle-7 inside parse.ts and added a guard.'
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect(wsRows(page, 'ws-a')).toHaveCount(1, { timeout: 30_000 })

      await sendShortcut(app, 'shortcut:command-palette')
      const dialog = searchDialog(page)
      await dialog.getByRole('textbox', { name: 'Ask or jump' }).fill('zebra-needle')
      const group = dialog.getByRole('group', { name: 'In conversations' })
      const row = group.locator('.cb-row', { hasText: 'Benchmarks of the week' })
      await expect(row.locator('.note b')).toHaveText('ZEBRA-needle', { timeout: 30_000 })
      await expect(dialog.locator('.cb-row.hot')).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(0)

      await page.keyboard.press('ArrowDown')
      await expect(row).toHaveClass(/\bhot\b/)
      await page.keyboard.press('Enter')
      await expect(dialog).toHaveCount(0)
      const [call] = await waitForCalls(env, 1)
      expect(resumedId(call)).toBe(found)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a running session found by search switches to its own tab, starting nothing', async ({
    app,
    page,
    env
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [first] = await waitForCalls(env, 1)
    await runIn(page, centerTerm(page), '/answer where is the yak-needle-42')
    const said = transcriptFile(env.home, env.workspaces.a, first.sessionId)
    await expect
      .poll(() => fs.existsSync(said) && fs.readFileSync(said, 'utf8').includes('yak-needle-42'), {
        timeout: 30_000
      })
      .toBe(true)
    await startSessionIn(page, 'ws-b')
    await waitForCalls(env, 2)
    const firstRow = wsRows(page, 'ws-a')
    await expect(firstRow).not.toHaveClass(/\bactive\b/)

    await expect(async () => {
      const dialog = await searchFor(app, page, 'yak-needle-42')
      await expect(dialog.locator('.restore-row')).toHaveCount(1, { timeout: 2000 })
    }).toPass({ timeout: 30_000 })
    const row = searchDialog(page).locator('.restore-row')
    await expect(row.locator('.restore-meta')).toContainText('running')
    await row.click()

    await expect(searchDialog(page)).toHaveCount(0)
    await expect(firstRow).toHaveClass(/\bactive\b/)
    expect(readCalls(env)).toHaveLength(2)
  })

  test('a session removed from the list is found too, and clicking it brings it back and resumes it', async ({
    env
  }) => {
    const removed = seedJsonl(env, env.workspaces.a, {
      summary: 'Gone from the sidebar',
      owned: false
    })
    appendReply(
      transcriptFile(env.home, env.workspaces.a, removed),
      'The heron-needle-9 lives in the old config.'
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)

      const dialog = await searchFor(app, page, 'heron-needle-9')
      await hit(dialog, 'Gone from the sidebar').click()

      const [call] = await waitForCalls(env, 1)
      expect(resumedId(call)).toBe(removed)
      await expect(wsRows(page, 'ws-a').filter({ hasText: 'Gone from the sidebar' })).toHaveCount(
        1,
        { timeout: 60_000 }
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('a local Codex thread is found through its app-server by what the model said, and resumes in Codex on click', async ({
    env
  }) => {
    installCodex(env)
    const thread = seedCodexThread(
      env,
      env.workspaces.a,
      'Codex seeded thread',
      'The otter-needle-3 was in the lockfile.'
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)

      await expect(async () => {
        const dialog = await searchFor(app, page, 'OTTER-needle-3')
        await expect(hit(dialog, 'Codex seeded thread')).toBeVisible({ timeout: 2000 })
      }).toPass({ timeout: 30_000 })
      const row = hit(searchDialog(page), 'Codex seeded thread')
      await expect(row.getByRole('img', { name: 'Codex', exact: true })).toBeVisible()
      await expect(row.locator('.restore-snippet b')).toHaveText('otter-needle-3')
      await row.click()

      await expect.poll(() => codexCalls(env).length, { timeout: 60_000 }).toBe(1)
      const call = codexCalls(env)[0]
      expect(call.sessionId).toBe(thread)
      expect(call.argv.slice(-2)).toEqual(['resume', thread])
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test.describe('remote', () => {
    test.afterEach(({ env }) => killFakeRemote(env))

    test('a cold session on an ssh machine is found in its mirrored transcript, named with its host, and resumes on the machine', async ({
      env
    }) => {
      installFakeRemote(env)
      seedRemoteWorkspace(env)
      const remote = seedJsonl(env, remoteDir(env), {
        root: path.join(env.userData, 'remote', REMOTE_HOST, 'projects'),
        cwd: remoteDir(env),
        summary: 'Yesterday on the build machine'
      })
      appendReply(
        path.join(mirrorProjectDir(env), remote + '.jsonl'),
        'The lynx-needle-5 is set in the deploy script.'
      )
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await expect(wsRows(page, REMOTE_WS_NAME)).toHaveCount(1, { timeout: 30_000 })

        const dialog = await searchFor(app, page, 'lynx-needle-5')
        const row = hit(dialog, 'Yesterday on the build machine')
        await expect(row.locator('.restore-meta')).toContainText(
          `${REMOTE_HOST}:${REMOTE_WS_NAME} · main ·`
        )
        await row.click()

        const calls = await waitForCalls(env, 1, 90_000)
        const last = calls[calls.length - 1]
        expect(resumedId(last)).toBe(remote)
        expect(last.cwd).toBe(remoteDir(env))
      } finally {
        await quitAndClose(app)
      }
    })

    test('a cold Muse session on an ssh machine is found by words said after its title, read from its log on the machine, named with its host, and resumes there', async ({
      env
    }) => {
      test.setTimeout(240_000)
      installMuse(env)
      installFakeRemote(env)
      installMuseOnMachine(env)
      seedRemoteWorkspace(env)
      seedSettings(env, { hintsOff: true })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await newSessionInWith(page, REMOTE_WS_NAME, 'Muse')
        await expect.poll(() => machineMuseCalls(env).length, { timeout: 60_000 }).toBe(1)
        const [{ sessionId }] = machineMuseCalls(env)
        await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/st-waiting/, { timeout: 60_000 })
        await runIn(page, centerTerm(page), 'Muse plans on the build machine')
        const row = wsRows(page, REMOTE_WS_NAME).filter({
          hasText: 'Muse plans on the build machine'
        })
        await expect(row).toHaveCount(1)
        await runIn(page, centerTerm(page), 'where is the wolf-needle-6')
        await expect
          .poll(() => museSaid(env, sessionId, machineHome(env)).join('\n'), { timeout: 30_000 })
          .toContain('where is the wolf-needle-6')
        await closeActiveTab(app, page)
        await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).toEqual([])
        await expect(row).toHaveClass(/cold/, { timeout: 30_000 })

        const found = await remoteHit(
          app,
          page,
          'wolf-NEEDLE-6',
          'Muse plans on the build machine',
          'Muse'
        )
        await expect(found.locator('.restore-snippet b')).toHaveText('wolf-needle-6')
        await found.click()

        await expect.poll(() => machineMuseCalls(env).length, { timeout: 60_000 }).toBe(2)
        expect(machineMuseCalls(env)[1].argv.slice(-2)).toEqual(['resume', sessionId])
      } finally {
        await quitAndClose(app)
      }
    })

    test('a cold Antigravity session on an ssh machine is found by words said after its title, in its mirrored transcript, named with its host, and resumes there', async ({
      env
    }) => {
      test.setTimeout(240_000)
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
        await runIn(page, centerTerm(page), 'Antigravity plans on the build machine')
        const row = wsRows(page, REMOTE_WS_NAME).filter({
          hasText: 'Antigravity plans on the build machine'
        })
        await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
        const { id } = await boundRemoteAgy(page)
        await runIn(page, centerTerm(page), 'where is the moth-needle-4')
        const mirrored = path.join(
          env.userData,
          'remote',
          REMOTE_HOST,
          'agy-gemini',
          'antigravity-cli',
          'brain',
          id,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        )
        await expect
          .poll(() => fs.readFileSync(mirrored, 'utf8'), { timeout: 60_000 })
          .toContain('Answer to: where is the moth-needle-4')
        await closeActiveTab(app, page)
        await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).not.toContain(`k-${id}`)
        await expect(row).toHaveClass(/cold/, { timeout: 30_000 })

        const found = await remoteHit(
          app,
          page,
          'MOTH-needle-4',
          'Antigravity plans on the build machine',
          'Antigravity'
        )
        await expect(found.locator('.restore-snippet b')).toHaveText('moth-needle-4')
        await found.click()

        await expect.poll(() => machineAgyCalls(env).length, { timeout: 90_000 }).toBe(2)
        expect(machineAgyCalls(env)[1].argv).toContain(`--conversation=${id}`)
      } finally {
        await quitAndClose(app)
      }
    })

    test('a cold Codex thread on an ssh machine is found by its title, named with its host, and resumes there', async ({
      env
    }) => {
      test.setTimeout(240_000)
      installCodexOnFakeRemote(env)
      installFakeRemote(env)
      seedRemoteWorkspace(env)
      seedSettings(env, { hintsOff: true })
      fs.writeFileSync(
        path.join(machineHome(env), 'fake-codex-next-title'),
        'Codex plans on the build machine'
      )
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
        const row = wsRows(page, REMOTE_WS_NAME).filter({
          hasText: 'Codex plans on the build machine'
        })
        await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
        await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(1)
        const [{ sessionId: thread }] = codexCalls(env)
        await closeActiveTab(app, page)
        await expect(row).toHaveClass(/cold/, { timeout: 30_000 })

        const found = await remoteHit(
          app,
          page,
          'codex PLANS on the build',
          'Codex plans on the build machine',
          'Codex'
        )
        await expect(searchDialog(page).locator('.pal-count')).toHaveText('1 conversation')
        await found.click()

        await expect.poll(() => codexCalls(env).length, { timeout: 60_000 }).toBe(2)
        expect(codexCalls(env)[1]).toMatchObject({ method: 'thread/resume', sessionId: thread })
      } finally {
        await quitAndClose(app)
      }
    })
  })
})

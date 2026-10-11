import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, type E2EEnv } from './helpers/env'
import {
  clickAppMenuItem,
  readCalls,
  resumedId,
  runIn,
  centerTerm,
  seedJsonl,
  startSessionIn,
  transcriptFile,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  installFakeRemote,
  killFakeRemote,
  mirrorProjectDir,
  REMOTE_HOST,
  REMOTE_WS_NAME,
  remoteDir,
  seedRemoteWorkspace
} from './helpers/remote'

test.setTimeout(180_000)

function searchDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Search sessions', exact: true })
}

async function searchFor(app: ElectronApplication, page: Page, term: string): Promise<Locator> {
  const dialog = searchDialog(page)
  if (!(await dialog.isVisible())) await clickAppMenuItem(app, page, 'search-sessions')
  const box = dialog.locator('.find-input')
  await box.fill(term)
  await box.press('Enter')
  await expect(dialog.locator('.field-hint')).toHaveText(/^(No matches|\d+ sessions?)$/, {
    timeout: 30_000
  })
  return dialog
}

function hit(dialog: Locator, title: string): Locator {
  return dialog.locator('.restore-row', { hasText: title })
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

function codexCalls(env: E2EEnv): { argv: string[]; sessionId: string }[] {
  const file = path.join(env.home, 'fake-codex-calls.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test.describe('Search sessions (Edit ▸ Search Sessions, ⌥⌘F) · finds a session by its words, in every workspace and backend, and opens it', () => {
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
      await expect(dialog.locator('.field-hint')).toHaveText('1 session')
      await expect(hit(dialog, 'Benchmarks of the week').locator('.restore-snippet')).toHaveCount(0)

      dialog = await searchFor(app, page, 'never-said-anywhere')
      await expect(dialog.locator('.field-hint')).toHaveText('No matches')
      await expect(dialog.locator('.restore-row')).toHaveCount(0)

      dialog = await searchFor(app, page, 'zebra-NEEDLE-7')
      await expect(dialog.locator('.field-hint')).toHaveText('1 session')
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
          `${REMOTE_WS_NAME} (${REMOTE_HOST}) · main ·`
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
  })
})

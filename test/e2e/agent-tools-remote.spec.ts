import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import type { BackendId, CronJob, SessionInfo } from '../../src/shared/types'
import { test, expect, quitAndClose } from './helpers/app'
import { agyTranscriptOf, museSaid, type E2EEnv } from './helpers/env'
import type { CodexWireLine } from './helpers/codex'
import { setupChangeFixture } from './helpers/filesFixture'
import { WORKBENCH } from './helpers/workbench'
import {
  encodeCwd,
  notesOnDisk,
  notesPath,
  openMenu,
  processAlive,
  readCalls,
  terminalText,
  wsGroup
} from './helpers/p1'
import { installOnTheMachine, koloftInSession, startRemoteTab } from './helpers/remoteTab'
import {
  REMOTE_WS_NAME,
  killFakeRemote,
  launchWithRemote,
  machineAgyCalls,
  machineCodexLog,
  machineHome,
  machineMuseCalls,
  remoteDir,
  remoteKey
} from './helpers/remote'

async function sessionOf(page: Page, tabId: string): Promise<SessionInfo | undefined> {
  return (await page.evaluate(() => window.api.sessions.list())).find((s) => s.tabId === tabId)
}

function machineProcessOf(env: E2EEnv, backend: BackendId, id: string): number | undefined {
  if (backend === 'claude') return readCalls(env).find((c) => c.sessionId === id)?.pid
  if (backend === 'muse') return machineMuseCalls(env).find((c) => c.sessionId === id)?.pid
  if (backend === 'agy') return machineAgyCalls(env)[0]?.pid
  return undefined
}

function codexFramesTo(env: E2EEnv, method: string, threadId: string): string[] {
  return machineCodexLog<CodexWireLine>(env, 'fake-codex-wire.jsonl')
    .filter(
      ({ direction, frame }) =>
        direction === 'client' &&
        frame.method === method &&
        (frame.params as { threadId?: string } | undefined)?.threadId === threadId
    )
    .map(({ frame }) => JSON.stringify(frame.params))
}

function reportReachedOnTheMachine(env: E2EEnv, backend: BackendId, parentId: string): string {
  if (backend === 'claude') {
    const projects = path.join(machineHome(env), '.claude', 'projects')
    const transcript = path.join(
      projects,
      encodeCwd(fs.realpathSync(remoteDir(env))),
      `${parentId}.jsonl`
    )
    return fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8') : ''
  }
  if (backend === 'codex') return codexFramesTo(env, 'thread/queue/add', parentId).join('\n')
  if (backend === 'muse') return JSON.stringify(museSaid(env, parentId, machineHome(env)))
  return agyTranscriptOf(env, parentId, path.join(machineHome(env), '.gemini'))
}

function parentStartedAgainOnTheMachine(
  env: E2EEnv,
  backend: BackendId,
  parentId: string
): boolean {
  if (backend === 'claude')
    return readCalls(env).some(
      (c) =>
        c.argv[c.argv.indexOf('--resume') + 1] === parentId &&
        c.cwd === fs.realpathSync(remoteDir(env))
    )
  if (backend === 'muse')
    return machineMuseCalls(env).filter((c) => c.sessionId === parentId).length > 1
  if (backend === 'agy')
    return machineAgyCalls(env).some((c) => c.argv.includes(`--conversation=${parentId}`))
  return codexFramesTo(env, 'thread/resume', parentId).length > 0
}

test.describe('`koloft` inside a tab on a remote workspace: the agent on the machine runs the koloft Koloft put there, and it acts for that session on this Mac', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

  for (const backend of SESSION_BACKENDS)
    test(`koloft cron add from a ${backend} session on the machine adds a job to its remote workspace, shown in Scheduled jobs and in koloft cron list, and show and off find it by its name`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      installOnTheMachine(env, backend)
      const { app, page } = await launchWithRemote(env)
      try {
        const tab = await startRemoteTab(page, env, backend)

        expect(
          await koloftInSession(
            page,
            tab,
            'cron add --name "Nightly tests" --daily 09:00 -- say hi'
          )
        ).toBe('0')
        expect(await koloftInSession(page, tab, 'cron list')).toBe('0')
        expect(await terminalText(page, tab)).toMatch(/^1\. Nightly tests · /m)
        expect(await koloftInSession(page, tab, 'cron off Nightly tests')).toBe('0')
        expect(await koloftInSession(page, tab, 'cron show Nightly tests')).toBe('0')
        expect(await terminalText(page, tab)).toMatch(/^On: no · no next run$/m)
        const jobs = (
          JSON.parse(fs.readFileSync(path.join(env.userData, 'cron.json'), 'utf8')) as {
            jobs: CronJob[]
          }
        ).jobs
        expect(jobs.map((j) => [j.name, j.workspacePath])).toEqual([
          ['Nightly tests', remoteKey(env)]
        ])

        await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
        await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
        const dlg = page.locator('.modal.cronjobs')
        await expect(
          dlg
            .locator('.job-row')
            .filter({ has: page.locator('.job-name', { hasText: /^Nightly tests$/ }) })
        ).toHaveCount(1, { timeout: 15_000 })
      } finally {
        await quitAndClose(app)
      }
    })

  for (const backend of SESSION_BACKENDS)
    test(`koloft open and koloft diff from a ${backend} session on the machine show a file there, then its change as a diff, in that session's Workbench, and koloft note reads and adds to the remote workspace's note on this Mac`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      installOnTheMachine(env, backend)
      const { app, page } = await launchWithRemote(env)
      try {
        const dir = remoteDir(env)
        const appTs = path.join(dir, 'src', 'app.ts')
        fs.mkdirSync(path.dirname(appTs), { recursive: true })
        fs.writeFileSync(appTs, 'export const app = 1\n')
        setupChangeFixture(dir)
        fs.appendFileSync(appTs, 'export const addedOnTheMachine = 2\n')
        const note = notesPath(env, remoteKey(env))
        fs.mkdirSync(path.dirname(note), { recursive: true })
        fs.writeFileSync(note, 'from the owner')
        const tab = await startRemoteTab(page, env, backend)

        expect(await koloftInSession(page, tab, 'open src/app.ts')).toBe('0')
        await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('src/app.ts', {
          timeout: 60_000
        })
        await expect(page.locator(WORKBENCH.readingBody)).toContainText('export const app = 1')
        expect(await koloftInSession(page, tab, 'diff src/app.ts')).toBe('0')
        await expect(page.locator(WORKBENCH.viewSegOn)).toHaveText('Diff', { timeout: 60_000 })
        await expect(page.locator(WORKBENCH.readingBody)).toContainText('addedOnTheMachine')

        expect(await koloftInSession(page, tab, 'note')).toBe('0')
        expect(await terminalText(page, tab)).toContain('from the owner')
        expect(await koloftInSession(page, tab, 'note append from the agent')).toBe('0')
        expect(notesOnDisk(env, remoteKey(env))).toBe('from the owner\nfrom the agent\n')
      } finally {
        await quitAndClose(app)
      }
    })

  for (const backend of SESSION_BACKENDS)
    test(`a ${backend} child on the machine reports to the ${backend} session on the machine that started it after that session’s tab was closed: koloft session send with the id from its first message starts the parent again on the machine and delivers the report marked with who sent it`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      installOnTheMachine(env, backend)
      const { app, page } = await launchWithRemote(env)
      try {
        const parentTab = await startRemoteTab(page, env, backend)
        await expect
          .poll(async () => (await sessionOf(page, parentTab))?.nativeSessionId)
          .toBeTruthy()
        const parent = (await sessionOf(page, parentTab))!
        const parentId = parent.nativeSessionId!
        const parentPid = machineProcessOf(env, backend, parentId)
        if (backend !== 'codex') expect(parentPid).toBeDefined()

        expect(await koloftInSession(page, parentTab, 'session new -- report back when done')).toBe(
          '0'
        )
        const kidRow = wsGroup(page, REMOTE_WS_NAME).locator(
          `.ws-tab[data-tab-id="${parentTab}"] + .ws-subtabs > .ws-tab`
        )
        await expect(kidRow).toHaveClass(/\bst-waiting\b/, { timeout: 90_000 })
        const kidTab = (await kidRow.getAttribute('data-tab-id'))!
        const kid = await sessionOf(page, kidTab)
        expect(kid?.backendId).toBe(backend)
        expect(kid?.host).toBe('ssh')

        await page.evaluate((tab) => window.api.terminal.kill(tab), parentTab)
        await expect
          .poll(async () => (await sessionOf(page, parentTab))?.alive ?? false)
          .toBe(false)
        if (parentPid)
          await expect.poll(() => processAlive(parentPid), { timeout: 30_000 }).toBe(false)

        await page.evaluate(
          ([tab, line]) => window.api.terminal.write(tab, line + '\r'),
          [kidTab, `/koloft session send ${parentId} all done`]
        )
        await expect
          .poll(() => reportReachedOnTheMachine(env, backend, parentId), { timeout: 90_000 })
          .toMatch(/\(From the session \\".+\\", id \S+:\) all done/)
        expect(parentStartedAgainOnTheMachine(env, backend, parentId)).toBe(true)
      } finally {
        await quitAndClose(app)
      }
    })
})

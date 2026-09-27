import fs from 'fs'
import path from 'path'
import { test, expect } from './helpers/app'
import {
  centerTerm,
  encodeCwd,
  FAKE_SESSION_TITLE,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { WORKBENCH, showBrowse } from './helpers/workbench'

test('starting a session in a workspace surfaces it, its file, and a preview through the real shim, hooks and tracker, with only the LLM faked', async ({
  page
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 25_000
  })

  await expect(page.locator('.ws-name', { hasText: 'ws-a' })).toBeVisible()

  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 15_000 })

  await showBrowse(page)
  const notes = page.locator(`${WORKBENCH.browseRows}.ft-file`, { hasText: 'NOTES.md' })
  await expect(notes).toBeVisible({ timeout: 15_000 })

  await notes.click()
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
  await expect(page.locator(WORKBENCH.readingBody)).toContainText('Written by the fake claude')
})

test('when Claude Code moves the conversation to a new session id (a phantom start, then continued-in), the tab follows it: one live row, bound to the new id', async ({
  page,
  env
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 15_000 })
  const tabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
  const boundOf = (): Promise<string | undefined> =>
    page.evaluate(
      (id) => window.api.sessions.list().then((all) => all.find((s) => s.tabId === id)?.sessionId),
      tabId
    )
  const before = await boundOf()
  expect(before).toBeTruthy()
  const beforeTranscript = path.join(
    env.home,
    '.claude',
    'projects',
    encodeCwd(env.workspaces.a),
    `${before}.jsonl`
  )

  await runIn(page, centerTerm(page), '/move-to-background')
  const continuedIn = (): string | undefined => {
    const last = fs.readFileSync(beforeTranscript, 'utf8').trimEnd().split('\n').pop() ?? ''
    return last.includes('continued-in') ? JSON.parse(last).continuedInSessionId : undefined
  }
  await expect.poll(continuedIn, { timeout: 15_000 }).toBeTruthy()
  await expect.poll(boundOf, { timeout: 15_000 }).toBe(continuedIn())
  await expect(wsRows(page, 'ws-a')).toHaveCount(1)
  await expect(wsRows(page, 'ws-a').first()).not.toHaveClass(/\bcold\b/)
})

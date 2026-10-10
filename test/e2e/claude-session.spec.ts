import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { codexMissingWhoseCheckAnswersOnlyWhenLetGo } from './helpers/env'
import {
  boundSessionId,
  centerTerm,
  continuedInOf,
  expectNoCodexWhileTheCheckIsOutNorAfter,
  FAKE_SESSION_TITLE,
  layoutOnDisk,
  openPicker,
  runIn,
  startSessionIn,
  transcriptFile,
  waitBooted,
  wsRows
} from './helpers/p1'
import { WORKBENCH, showBrowse } from './helpers/workbench'

test('with no Codex and a slow Codex check, the first ⌘N picker after launch never shows a Codex button, before or after the check answers', async ({
  env
}) => {
  const letTheCheckAnswer = codexMissingWhoseCheckAnswersOnlyWhenLetGo(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    const picker = await openPicker(app, page)
    await expect(picker.locator('.modal-foot button[data-default="true"]')).toBeVisible()
    const codexButtons = picker.locator('.modal-foot button[data-default="false"]')

    await expectNoCodexWhileTheCheckIsOutNorAfter(
      page,
      letTheCheckAnswer,
      () => codexButtons.count(),
      'a Codex button'
    )
  } finally {
    await quitAndClose(app)
  }
})

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
  const boundOf = (): Promise<string | undefined> => boundSessionId(page, tabId)
  const before = await boundOf()
  expect(before).toBeTruthy()
  const beforeTranscript = transcriptFile(env.home, env.workspaces.a, before ?? '')

  await runIn(page, centerTerm(page), '/move-to-background')
  const continuedIn = (): string | undefined => continuedInOf(beforeTranscript)
  await expect.poll(continuedIn, { timeout: 15_000 }).toBeTruthy()
  await expect.poll(boundOf, { timeout: 15_000 }).toBe(continuedIn())
  await expect.poll(() => layoutOnDisk(env).members, { timeout: 15_000 }).toEqual([continuedIn()])
  await expect(wsRows(page, 'ws-a')).toHaveCount(1)
  await expect(wsRows(page, 'ws-a').first()).not.toHaveClass(/\bcold\b/)
})

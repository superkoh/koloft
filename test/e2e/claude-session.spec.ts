import { test, expect } from './helpers/app'
import { FAKE_SESSION_TITLE, startSessionIn, waitBooted } from './helpers/p1'
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
  const notes = page.locator(`${WORKBENCH.panel} .ft-node.ft-file`, { hasText: 'NOTES.md' })
  await expect(notes).toBeVisible({ timeout: 15_000 })

  await notes.click()
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
  await expect(page.locator(WORKBENCH.readingBody)).toContainText('Written by the fake claude')
})

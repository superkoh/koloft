import { test, expect } from './helpers/app'
import { FAKE_SESSION_TITLE, startSessionIn, waitBooted } from './helpers/p1'
import { WORKBENCH, showBrowse } from './helpers/workbench'

// The crown-jewel E2E: starting a session the way the product starts one drives the REAL
// detection pipeline end to end — the shim intercepts + registers, the injected hooks
// fire, the tracker tails the jsonl, and the UI surfaces the session, its touched file,
// and the preview. Only the external LLM is faked.
test('starting a session in a workspace surfaces it, its file, and a preview', async ({ page }) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  // 1. the session appears in the sidebar with the ai-title from the transcript
  await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 25_000
  })

  // 2. it is grouped under the workspace folder (derived from the session cwd)
  await expect(page.locator('.ws-name', { hasText: 'ws-a' })).toBeVisible()

  // 3. the run-state dot settles on 'waiting' after the Stop hook (prompt → stop)
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 15_000 })

  // 4. the file the session wrote shows in Browse (rooted at the session cwd). The tree
  //    moved into the Workbench's pinned `files` tab (FR-44), whose default half is
  //    Changes — so reaching Browse is part of the gesture now, not scaffolding.
  await showBrowse(page)
  const notes = page.locator(`${WORKBENCH.panel} .ft-node.ft-file`, { hasText: 'NOTES.md' })
  await expect(notes).toBeVisible({ timeout: 15_000 })

  // 5. clicking it renders the file in the reading area beside the tree (FR-10)
  await notes.click()
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
  await expect(page.locator(WORKBENCH.readingBody)).toContainText('Written by the fake claude')
})

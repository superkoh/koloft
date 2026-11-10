import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { centerTerm, runIn, startSessionIn, waitBooted, wsRows } from './helpers/p1'

const OUT = '/private/tmp/claude-501/-Users-letianwang-Projects-koloft--claude-worktrees-restore-pending-questions/fb27b904-8d25-4be3-b89e-150458d2b473/scratchpad/shots'

test('shot: a question card after a Koloft restart', async ({ env }) => {
  test.setTimeout(180_000)
  let app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    await startSessionIn(page, 'ws-b')
    const asker = wsRows(page, 'ws-b').first()
    await expect(asker).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
    await runIn(page, centerTerm(page), '/ask Which colour should the button be?|Red|Green')
    await expect(asker).toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
    await page.locator('.ibx-entry').click()
    const card = page.locator('.inbox-page .ibx-item').first()
    await expect(card.locator('.ibx-choice').first()).toBeVisible({ timeout: 15_000 })
    fs.mkdirSync(OUT, { recursive: true })
    await card.screenshot({ path: path.join(OUT, 'before-restart.png') })
  } finally {
    await quitAndClose(app)
  }
  fs.writeFileSync(path.join(env.home, 'fake-claude-no-status'), '')
  app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    await page.locator('.ibx-entry').click()
    const card = page.locator('.inbox-page .ibx-item').first()
    await expect(card).toContainText('Your answer reaches it as a message', { timeout: 15_000 })
    await card.screenshot({ path: path.join(OUT, 'after-restart.png') })
  } finally {
    await quitAndClose(app)
  }
})

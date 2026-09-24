import path from 'path'
import { test, expect } from './helpers/app'
import {
  centerTerm,
  FAKE_SESSION_TITLE,
  runIn,
  snap,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { WORKBENCH, showBrowse, wbTabs } from './helpers/workbench'

test('T-AUX-08: a session write never opens itself or builds a tab; a click opens it in the reading area; retired follow controls stay gone', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 40_000
  })

  await runIn(page, centerTerm(page), '/write docs/guide.md')

  await showBrowse(page)
  await page
    .locator(`${WORKBENCH.browseRows}.ft-dir[data-path="${path.join(env.workspaces.a, 'docs')}"]`)
    .click({ timeout: 20_000 })
  const written = page.locator(`${WORKBENCH.browseRows}.ft-file`, { hasText: 'guide.md' })
  await expect(written).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(`${WORKBENCH.panel} .fv-read .fv-empty`)).toBeVisible()
  await expect(page.locator(WORKBENCH.readingBody)).toHaveCount(0)
  await expect(wbTabs(page)).toHaveCount(1)
  await snap(page, 'T-AUX-08')

  await written.click()
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('docs/guide.md', {
    timeout: 15_000
  })
  await expect(page.locator(WORKBENCH.readingBody)).toContainText(
    'Written mid-turn by the fake claude'
  )
  await expect(wbTabs(page)).toHaveCount(1)

  await expect(page.locator('[aria-label="Follow agent"]')).toHaveCount(0)
  await expect(page.locator('[aria-label="Changes overview"]')).toHaveCount(0)
  await expect(page.locator('.diff-pane')).toHaveCount(0)
})

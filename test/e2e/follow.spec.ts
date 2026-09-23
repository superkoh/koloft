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

// T-AUX-08 — follow gone entirely: a file the session writes mid-turn
// (real hooks + real transcript, fake claude's /write) must NOT show itself — the
// reading area fills on user intent alone (a Browse click / a user's own `open`).
// kept the rule and hardened it: FR-14 makes an agent's file open produce no tab and no
// signal at all, so a mere WRITE — which is not even an open — must leave the panel
// exactly as it found it. The write still registers (Browse lists the file), and the
// retired controls stay retired: no follow toggle anywhere, no changes-overview entry,
// no aggregate diff overlay.
test('T-AUX-08: a session write never opens itself; a click opens it; retired controls stay gone', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 40_000
  })

  // the write lands mid-turn (the fake holds the turn open ~2.5s)
  await runIn(page, centerTerm(page), '/write docs/guide.md')

  // wait until the write has observably registered: Browse lists guide.md. The retired
  // tree's Preview filter chip was the old barrier; the expansion of `docs/` is the same
  // one on the new surface. session.files and lastWritten travel on the same session
  // tick, so once the row is visible any auto-open would already have fired — asserting
  // the reading area's emptiness after this point is deterministic, not a timing guess.
  await showBrowse(page)
  await page
    .locator(
      `${WORKBENCH.panel} .ft-node.ft-dir[data-path="${path.join(env.workspaces.a, 'docs')}"]`
    )
    .click({ timeout: 20_000 })
  const written = page.locator(`${WORKBENCH.panel} .ft-node.ft-file`, { hasText: 'guide.md' })
  await expect(written).toBeVisible({ timeout: 20_000 })
  // the panel is up (T2, the default) on Browse, and its reading area is EMPTY — nothing
  // rendered itself. `.fv-empty` is the positive half of that: `readingBody` alone would
  // also read 0 on the Changes half, where the reading column does not exist at all.
  // And the write built no tab either (FR-14): only the pinned `files` is there.
  await expect(page.locator(`${WORKBENCH.panel} .fv-read .fv-empty`)).toBeVisible()
  await expect(page.locator(WORKBENCH.readingBody)).toHaveCount(0)
  await expect(wbTabs(page)).toHaveCount(1)
  await snap(page, 'T-AUX-08')

  // the file is one click away — user intent still opens it, rendered, in the files tab
  await written.click()
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('docs/guide.md', {
    timeout: 15_000
  })
  await expect(page.locator(WORKBENCH.readingBody)).toContainText(
    'Written mid-turn by the fake claude'
  )
  // …and still without a tab of its own: FR-10 keeps a file click inside the reading area
  await expect(wbTabs(page)).toHaveCount(1)

  // negatives: the retirements hold across the whole app
  await expect(page.locator('[aria-label="Follow agent"]')).toHaveCount(0)
  await expect(page.locator('[aria-label="Changes overview"]')).toHaveCount(0)
  await expect(page.locator('.diff-pane')).toHaveCount(0)
})

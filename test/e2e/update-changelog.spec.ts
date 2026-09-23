import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import {
  INSTALL_TEXT,
  changelog,
  higher,
  lower,
  notesBody,
  release,
  withFixtureEnv,
  writeFixture
} from './helpers/updateFixture'

// Black-box coverage of the "Check for Updates..." modal's changelog display (cases
// B1-B16). Written from the feature's requirements ALONE: no src/** implementation was
// read to produce these assertions, so a failure here is either a real regression or a
// requirement that needs deciding (called out per-test below), never "matched the code to
// make it pass".
//
// The bug this pins the fix for: the modal showed the GitHub release body verbatim, and
// v0.3.2 through v0.5.2 all shipped the same body — install instructions, no changelog.
//
// The display contract each case cites by number:
//  1. Markdown renders as real elements (`##`->h2, `-`->li, backticks->code, ```->pre,
//     `**`->strong); no literal marker characters survive into the visible text.
//  2. Nothing from the `<!-- koloft:install -->` marker down is shown — that half is for
//     GitHub web visitors, and this reader's app installs itself.
//  3. No clickable anchors: the app has no will-navigate guard, so a link click would
//     navigate the whole renderer away and take every tab's live terminal with it.
//  4. Injected HTML never executes: no script/iframe elements, no on* attributes.
//  5. Every release newer than the installed one contributes its changelog, newest first;
//     `.update-notes-ver` headings appear only when >=2 versions have content.
//  6. Releases with no changelog are skipped entirely — no orphaned heading; when none of
//     them has content, `.update-notes` itself is absent (never an empty frame).
//  7. `.update-notes` scrolls internally, so a long changelog can't push the modal's
//     buttons out of the viewport.
//  8. Other phases (current / error) and the rest of the modal chrome are unaffected.
//
// Driving mechanism: KOLOFT_UPDATE_FIXTURE points at a JSON file this spec writes itself,
// shaped like a GitHub /releases response; the running version comes from
// `app.evaluate(=> app.getVersion())` -- NEVER hardcoded, because an unpackaged run
// reports ELECTRON's version (33.4.11), not package.json's. The modal opens on the same
// IPC channel as the real menu item, 'shortcut:check-update', gated behind the renderer's
// __koloftShortcutsReady flag exactly like helpers/p1.ts's waitBooted does.
//
// SAFETY: no test here ever clicks "Download & Restart" -- it would download a real dmg
// and relaunch the developer's app. Every case below only asserts on display.

/** Legacy pre-fix body shape: no `<!-- koloft:install -->` marker at all — what every real
 *  release from v0.3.2 through v0.5.2 published. Reused wherever a test needs the "pure
 *  install notes, no changelog" shape -- the bug's pre-fix symptom. */
const LEGACY_BODY = INSTALL_TEXT

/**
 * Send the real 'shortcut:check-update' channel (the same one the "Check for Updates..."
 * menu item uses) and wait for the modal to render. Waits for the renderer's readiness
 * flag first -- a send that lands before listeners are mounted is silently dropped, the
 * same race helpers/p1.ts's waitBooted guards against.
 */
async function openUpdateModal(app: ElectronApplication, page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('shortcut:check-update')
  })
  await page.locator('.update-modal').waitFor({ state: 'visible', timeout: 20_000 })
}

/** Shared "update available, chrome intact, no changelog" assertions used by the cases
 *  that expect contract #6's "nothing to show" rule while the rest of the modal stays normal. */
async function expectNormalChromeNoNotes(
  page: Page,
  oldVersion: string,
  newVersion: string
): Promise<void> {
  await expect(page.locator('.update-notes')).toHaveCount(0)
  await expect(page.locator('.update-ver-old')).toContainText(oldVersion)
  await expect(page.locator('.update-ver-new')).toContainText(newVersion)
  await expect(page.getByRole('button', { name: 'Download & Restart' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Later' })).toBeVisible()
}

// B1 -- markdown renders as real DOM structure, not raw markers.
// Pins contract #1: `## ` -> h2, `- ` -> li, `**x**` -> strong, `` `x` `` -> code, fenced
// ``` -> pre, and none of those literal marker characters survive into .update-notes'
// visible text.
// Regression this catches: the bug's second layer -- bare markdown syntax dumped
// straight into the modal instead of being rendered.
test('B1 markdown renders as real DOM structure, not raw markers', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v = higher(version)
    const body = notesBody(
      [
        "## What's Changed",
        '',
        '- feat: add **bold** emphasis rendering (#1)',
        '- fix: render `inline` code spans correctly (#2)',
        '- docs: update the install guide (#3)',
        '',
        '```bash',
        'echo "fenced block"',
        '```'
      ].join('\n')
    )
    writeFixture(fixturePath, [release(v, body)])

    await openUpdateModal(app, page)
    const notes = page.locator('.update-notes')
    await expect(notes).toBeVisible()
    await expect(notes.locator('h2')).toHaveCount(1)
    await expect(notes.locator('ul li')).toHaveCount(3)
    await expect(notes.locator('strong')).toHaveCount(1)
    expect(await notes.locator('code').count()).toBeGreaterThan(0)
    await expect(notes.locator('pre')).toHaveCount(1)

    const text = await notes.innerText()
    expect(text).not.toContain('##')
    expect(text).not.toContain('**')
    expect(text).not.toContain('```')
  } finally {
    await app.close().catch(() => {})
  }
})

// B2 -- install instructions are cut from the display, not just reflowed.
// Pins contract #2: body = changelog + marker +
// full install text -> .update-notes shows the changelog but neither the install
// commands nor the marker text itself.
// Regression this catches: the marker isn't cut, so the modal is STILL full of install
// steps -- the exact symptom the user originally reported.
test('B2 install instructions after the koloft:install marker are hidden', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v = higher(version)
    const body = notesBody(changelog('feat: a change worth telling users about (#42)'))
    writeFixture(fixturePath, [release(v, body)])

    await openUpdateModal(app, page)
    const notes = page.locator('.update-notes')
    await expect(notes).toBeVisible()
    await expect(notes).toContainText('a change worth telling users about')

    const text = await notes.innerText()
    expect(text).not.toContain('curl -fsSL')
    expect(text).not.toContain('xattr')
    expect(text).not.toContain('未签名个人构建')
    expect(text).not.toContain('koloft:install')
  } finally {
    await app.close().catch(() => {})
  }
})

// B3 -- a legacy (pre-fix) body with no marker at all is hidden entirely, not shown raw
// and not rendered as an empty box.
// Pins contract #6's legacy-body rule: no marker + first non-empty line starting with
// `**未签名个人构建` -> the whole body contributes nothing.
// Regression this catches: any of the 10 already-published releases (v0.3.2..v0.5.2)
// either regresses to showing raw install steps again, or the aggregation logic renders
// an empty bordered box for them.
test('B3 legacy body with no marker produces no changelog area at all', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v = higher(version)
    writeFixture(fixturePath, [release(v, LEGACY_BODY)])

    await openUpdateModal(app, page)
    await expectNormalChromeNoNotes(page, version, v)
  } finally {
    await app.close().catch(() => {})
  }
})

// B4 -- an empty body string must not render an empty box or throw.
// Pins contract #6 (absent, not empty) for the degenerate empty-string case,
// plus the rest-of-modal-still-works half of it.
// Regression this catches: '' renders an empty .update-notes frame, or the
// markdown/DOMPurify pipeline throws on empty input and white-screens the modal.
test('B4 empty release body produces no changelog area, rest of modal intact', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v = higher(version)
    writeFixture(fixturePath, [release(v, '')])

    await openUpdateModal(app, page)
    await expectNormalChromeNoNotes(page, version, v)
  } finally {
    await app.close().catch(() => {})
  }
})

// B5 -- no clickable anchors survive rendering, ever.
// Pins contract #3: `.update-notes a` count is always 0 -- this app has no
// will-navigate/windowOpen interception, so a click would navigate the whole renderer to
// GitHub and lose every tab's terminal state -- while the link TEXT itself stays visible.
// Regression this catches: a markdown link, a linkified bare URL, or a javascript: href
// turns into a real clickable <a>.
test('B5 no clickable links, but link text remains visible', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v = higher(version)
    const body = notesBody(
      changelog(
        '[release page](https://github.com/x)',
        'see https://example.com/x for details',
        '[bad](javascript:alert(1))'
      )
    )
    writeFixture(fixturePath, [release(v, body)])

    await openUpdateModal(app, page)
    const notes = page.locator('.update-notes')
    await expect(notes).toBeVisible()
    await expect(notes.locator('a')).toHaveCount(0)
    await expect(notes).toContainText('release page')
  } finally {
    await app.close().catch(() => {})
  }
})

// B6 -- injected script/event-handler/iframe content in the body never executes.
// Pins contract #4: no script/iframe elements, no on* attributes inside .update-notes, and no
// observable side effect in the renderer's global scope.
// Regression this catches: a compromised GitHub account or a tampered/MITM'd API
// response turns the changelog into an XSS foothold inside the privileged main-window
// renderer (which also drives every terminal tab).
test('B6 injected script/event-handler/iframe content does not execute', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v = higher(version)
    const body = notesBody(
      changelog('feat: normal item (#1)') +
        '\n\n<script>window.__pwned=1</script>\n' +
        '<img src=x onerror="window.__pwned=1">\n' +
        '<iframe src="about:blank"></iframe>\n'
    )
    writeFixture(fixturePath, [release(v, body)])

    await openUpdateModal(app, page)
    const notes = page.locator('.update-notes')
    await expect(notes).toBeVisible()
    await expect(notes.locator('script')).toHaveCount(0)
    await expect(notes.locator('iframe')).toHaveCount(0)
    expect(await notes.locator('[onerror]').count()).toBe(0)
    const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)
    expect(pwned).toBeUndefined()
  } finally {
    await app.close().catch(() => {})
  }
})

// B7 -- skipped versions aggregate: every version newer than the running one shows its
// own changelog, newest first.
// Pins contract #5 (aggregate every skipped version).
// Regression this catches: only the single latest release's notes are shown, so a user
// who skipped several versions never sees what changed in between.
test('B7 aggregates changelogs from all skipped versions, newest first', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v1 = higher(version, 1)
    const v2 = higher(version, 2)
    const v3 = higher(version, 3)
    // deliberately scrambled vs semver order in the fixture array -- display order must
    // come from version comparison, not array/document order
    writeFixture(fixturePath, [
      release(v2, notesBody(changelog(`feat: change for ${v2} (#2)`))),
      release(v3, notesBody(changelog(`feat: change for ${v3} (#3)`))),
      release(v1, notesBody(changelog(`feat: change for ${v1} (#1)`)))
    ])

    await openUpdateModal(app, page)
    const headings = page.locator('.update-notes-ver')
    await expect(headings).toHaveCount(3)
    const texts = await headings.allTextContents()
    expect(texts[0]).toContain(v3)
    expect(texts[1]).toContain(v2)
    expect(texts[2]).toContain(v1)

    const notes = page.locator('.update-notes')
    await expect(notes).toContainText(`change for ${v1}`)
    await expect(notes).toContainText(`change for ${v2}`)
    await expect(notes).toContainText(`change for ${v3}`)
  } finally {
    await app.close().catch(() => {})
  }
})

// B8 -- a single updated version does not get a redundant version heading.
// Pins contract #5's "headings only when >=2 versions have content" clause directly.
// Regression this catches: a lone update shows a heading that just repeats the version
// already shown by the arrow above it.
test('B8 a single update version renders no per-version heading', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v = higher(version)
    writeFixture(fixturePath, [release(v, notesBody(changelog('feat: the only change (#1)')))])

    await openUpdateModal(app, page)
    await expect(page.locator('.update-notes-ver')).toHaveCount(0)
    await expect(page.locator('.update-notes')).toContainText('the only change')
  } finally {
    await app.close().catch(() => {})
  }
})

// B9 -- an empty-contributing version (pure install notes) among several updates is
// skipped without leaving a headless heading.
// Pins contract #6 (empty contributors are skipped) -- the empty version must not get a .update-notes-ver
// heading with nothing under it.
// Regression this catches: the older, content-less version still gets a heading,
// leaving a section title with no changelog beneath it.
//
// SPEC AMBIGUITY (resolved below, see report): case B9's prose says
// ".update-notes-ver has exactly 1 (the newer version)" (exactly one heading, for the newer
// version), but the display contract states `.update-notes-ver` appears only when >=2
// versions have content" (renders only when >=2 versions HAVE CONTENT). Once the
// older version is filtered out as empty (contract #6), only ONE version here has real
// content -- by the table's literal rule that means ZERO headings, the same shape as
// the single-release case B8. Observed app behavior renders 0 headings with the
// content inlined directly under .update-notes, i.e. it follows the table rule over
// that looser reading. This test asserts that (the more precisely-specified, and
// internally-consistent-with-B8) reading; flip the toHaveCount below to 1 if the
// intended contract is actually B9's literal prose.
test('B9 an empty older version is skipped, leaving no orphaned heading', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const older = higher(version, 1)
    const newer = higher(version, 2)
    writeFixture(fixturePath, [
      release(newer, notesBody(changelog('feat: newer-only change (#9)'))),
      release(older, LEGACY_BODY)
    ])

    await openUpdateModal(app, page)
    await expect(page.locator('.update-notes-ver')).toHaveCount(0)
    const notes = page.locator('.update-notes')
    await expect(notes).toContainText('newer-only change')
    const text = await notes.innerText()
    expect(text).not.toContain('curl -fsSL')
    expect(text).not.toContain('未签名个人构建')
  } finally {
    await app.close().catch(() => {})
  }
})

// B10 -- when every skipped version is content-less, the whole changelog area is absent,
// but the update is still offered.
// Pins contract #6's tail clause (no contributor with content -> no .update-notes), plus #8
// (other phase chrome unaffected).
// Regression this catches: the aggregation path renders an empty container when every
// contributor is empty, or breaks the modal entirely in that case.
test('B10 all-empty aggregated versions produce no changelog area', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const older = higher(version, 1)
    const newer = higher(version, 2)
    writeFixture(fixturePath, [release(newer, LEGACY_BODY), release(older, LEGACY_BODY)])

    await openUpdateModal(app, page)
    await expectNormalChromeNoNotes(page, version, newer)
  } finally {
    await app.close().catch(() => {})
  }
})

// B11 -- draft and prerelease releases are excluded from "latest", even when their
// version numbers are higher than the true latest official release.
// Pins the list-endpoint decision: /releases (not /releases/latest) requires
// self-filtering draft/prerelease before picking the semver max.
// Regression this catches: switching to the list endpoint starts offering users a draft
// or prerelease build as if it were a real release.
test('B11 draft/prerelease releases are excluded from latest and its changelog', async ({
  env
}) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const official = higher(version, 1)
    const prereleaseVer = higher(version, 3)
    const draftVer = higher(version, 5)
    writeFixture(fixturePath, [
      release(official, notesBody(changelog('feat: OFFICIAL-ITEM-XYZ (#1)'))),
      release(prereleaseVer, notesBody(changelog('feat: PRERELEASE-ITEM-XYZ (#2)')), {
        prerelease: true
      }),
      release(draftVer, notesBody(changelog('feat: DRAFT-ITEM-XYZ (#3)')), { draft: true })
    ])

    await openUpdateModal(app, page)
    await expect(page.locator('.update-ver-new')).toContainText(official)
    await expect(page.locator('.update-ver-new')).not.toContainText(draftVer)
    await expect(page.locator('.update-ver-new')).not.toContainText(prereleaseVer)

    const notes = page.locator('.update-notes')
    await expect(notes).toContainText('OFFICIAL-ITEM-XYZ')
    const text = await notes.innerText()
    expect(text).not.toContain('PRERELEASE-ITEM-XYZ')
    expect(text).not.toContain('DRAFT-ITEM-XYZ')
  } finally {
    await app.close().catch(() => {})
  }
})

// B12 -- no version newer than the running one -> "latest version" phase, no changelog
// area at all.
// Pins contract #8: other phases are unaffected by the aggregation feature.
// Regression this catches: the new aggregation logic fires even when there is nothing to
// aggregate, rendering a changelog area in the 'current' phase.
test('B12 no newer version renders the current-version phase, no changelog area', async ({
  env
}) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    writeFixture(fixturePath, [release(version, ''), release(lower(version), '')])

    await openUpdateModal(app, page)
    // substring only (not the full "You're on the latest version" copy
    // verbatim) -- the rendered copy uses a typographic apostrophe (U+2019), a
    // cosmetic difference from the doc's plain ' that isn't worth pinning on
    await expect(page.locator('.update-modal')).toContainText('on the latest version')
    await expect(page.locator('.update-notes')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// B13 -- a long changelog scrolls within its own box; it never pushes the primary action
// button out of the viewport.
// Pins contract #7: .update-notes scrolls internally (scrollHeight > clientHeight), and the
// modal itself never exceeds the window.
// Regression this catches: a long aggregated changelog blows out the modal's layout,
// pushing "Download & Restart" off-screen where it can't be clicked.
test('B13 a long changelog scrolls internally without breaking modal layout', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v = higher(version)
    const items = Array.from({ length: 60 }, (_, i) => `feat: changelog entry ${i + 1} (#${i + 1})`)
    writeFixture(fixturePath, [release(v, notesBody(changelog(...items)))])

    await openUpdateModal(app, page)
    const notes = page.locator('.update-notes')
    await expect(notes).toBeVisible()
    const [scrollHeight, clientHeight] = await notes.evaluate((el: HTMLElement) => [
      el.scrollHeight,
      el.clientHeight
    ])
    expect(scrollHeight).toBeGreaterThan(clientHeight)

    const modalBox = await page.locator('.update-modal').boundingBox()
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    expect(modalBox).not.toBeNull()
    expect(modalBox!.height).toBeLessThanOrEqual(viewportHeight)

    await expect(page.getByRole('button', { name: 'Download & Restart' })).toBeVisible()
  } finally {
    await app.close().catch(() => {})
  }
})

// B14 -- more than 20 skipped versions truncate the aggregation, with an explicit count
// of what was omitted.
// Pins the aggregation cap: max 20 versions, and a non-silent
// .update-notes-more line naming how many were cut.
// Regression this catches: silently dropping the extra versions -- the user has no idea
// the list they're looking at is incomplete.
test('B14 more than 20 skipped versions truncate with a stated omitted count', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const releases = Array.from({ length: 25 }, (_, i) => {
      const ver = higher(version, i + 1)
      return release(ver, notesBody(changelog(`feat: change for ${ver} (#${i + 1})`)))
    })
    writeFixture(fixturePath, releases)

    await openUpdateModal(app, page)
    await expect(page.locator('.update-notes-ver')).toHaveCount(20)
    const more = page.locator('.update-notes-more')
    await expect(more).toBeVisible()
    await expect(more).toContainText('5')
  } finally {
    await app.close().catch(() => {})
  }
})

// B15 -- reopening the modal with the same data never duplicates or accumulates the
// changelog.
// Pins the "reopening the modal leaves nothing behind" case directly: identical content across a close->reopen
// cycle, no repeated entries.
// Regression this catches: notes accumulate in a store across opens (or a stale render
// survives the close), so a second open shows the list twice.
test('B15 closing and reopening the modal does not duplicate the changelog', async ({ env }) => {
  const fixturePath = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const version = await app.evaluate(({ app }) => app.getVersion())
    const v = higher(version)
    writeFixture(fixturePath, [
      release(v, notesBody(changelog('feat: first item (#1)', 'feat: second item (#2)')))
    ])

    await openUpdateModal(app, page)
    const notes = page.locator('.update-notes')
    await expect(notes).toBeVisible()
    const firstText = await notes.innerText()
    const firstLiCount = await notes.locator('li').count()

    await page.getByRole('button', { name: 'Later' }).click()
    await expect(page.locator('.update-modal')).toBeHidden()

    await openUpdateModal(app, page)
    const notes2 = page.locator('.update-notes')
    await expect(notes2).toBeVisible()
    const secondText = await notes2.innerText()
    const secondLiCount = await notes2.locator('li').count()

    expect(secondText).toBe(firstText)
    expect(secondLiCount).toBe(firstLiCount)
  } finally {
    await app.close().catch(() => {})
  }
})

// B16 -- a fixture path that can't be read fails into a real, visible error state, never
// a silent/partial changelog.
// Pins the overall "no half-rendered content" rule plus the update mechanism's own
// error path: .update-error with readable text and a working "Try again" affordance.
// Regression this catches: an unreadable fixture (stand-in for a network failure/bad
// response in production) is swallowed, leaving a blank or half-built changelog instead
// of telling the user the check failed.
test('B16 an unreadable fixture surfaces a real error state, not a partial changelog', async ({
  env
}) => {
  // deliberately do NOT create this file -- KOLOFT_UPDATE_FIXTURE must point at a path that
  // genuinely does not exist, unlike withFixtureEnv's pre-seeded '[]'
  const missingPath = path.join(env.home, 'does-not-exist.json')
  env.launchEnv.KOLOFT_UPDATE_FIXTURE = missingPath
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await openUpdateModal(app, page)
    const error = page.locator('.update-error')
    await expect(error).toBeVisible()
    const text = (await error.innerText()).trim()
    expect(text.length).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page.locator('.update-notes')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

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

const LEGACY_INSTALL_ONLY_BODY = INSTALL_TEXT

// PLATFORM§6
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

test.describe('the Check for Updates modal’s changelog — display only, never clicking Download & Restart', () => {
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

  test('B3 legacy body with no marker produces no changelog area at all', async ({ env }) => {
    const fixturePath = withFixtureEnv(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const version = await app.evaluate(({ app }) => app.getVersion())
      const v = higher(version)
      writeFixture(fixturePath, [release(v, LEGACY_INSTALL_ONLY_BODY)])

      await openUpdateModal(app, page)
      await expectNormalChromeNoNotes(page, version, v)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('B4 empty release body produces no changelog area, rest of modal intact', async ({
    env
  }) => {
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

  test('B5 no clickable links (a click would navigate the whole renderer away), but link text remains visible', async ({
    env
  }) => {
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

  test('B9 an empty older version is skipped: one contributing version left means no heading at all', async ({
    env
  }) => {
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
        release(older, LEGACY_INSTALL_ONLY_BODY)
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

  test('B10 all-empty aggregated versions produce no changelog area', async ({ env }) => {
    const fixturePath = withFixtureEnv(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const version = await app.evaluate(({ app }) => app.getVersion())
      const older = higher(version, 1)
      const newer = higher(version, 2)
      writeFixture(fixturePath, [
        release(newer, LEGACY_INSTALL_ONLY_BODY),
        release(older, LEGACY_INSTALL_ONLY_BODY)
      ])

      await openUpdateModal(app, page)
      await expectNormalChromeNoNotes(page, version, newer)
    } finally {
      await app.close().catch(() => {})
    }
  })

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
      await expect(page.locator('.update-modal')).toContainText('on the latest version')
      await expect(page.locator('.update-notes')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('B13 a long changelog scrolls internally without breaking modal layout', async ({ env }) => {
    const fixturePath = withFixtureEnv(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const version = await app.evaluate(({ app }) => app.getVersion())
      const v = higher(version)
      const items = Array.from(
        { length: 60 },
        (_, i) => `feat: changelog entry ${i + 1} (#${i + 1})`
      )
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

  test('B14 more than 20 skipped versions truncate with a stated omitted count', async ({
    env
  }) => {
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

  test('B16 an unreadable fixture surfaces a real error state, not a partial changelog', async ({
    env
  }) => {
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

  test("B17 the What's Changed heading every release body opens with is dropped when several releases are grouped under their own version headings, and kept for a lone release", async ({
    env
  }) => {
    const fixturePath = withFixtureEnv(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const version = await app.evaluate(({ app }) => app.getVersion())
      const older = higher(version, 1)
      const newer = higher(version, 2)
      writeFixture(fixturePath, [
        release(newer, notesBody(changelog('feat: grouped newer (#2)'))),
        release(older, notesBody(changelog('feat: grouped older (#1)')))
      ])

      await openUpdateModal(app, page)
      const grouped = page.locator('.update-notes')
      await expect(grouped.locator('.update-notes-ver')).toHaveCount(2)
      await expect(grouped).toContainText('grouped older')
      await expect(grouped.locator('h2')).toHaveCount(0)
      expect(await grouped.innerText()).not.toMatch(/What.s Changed/)

      await page.getByRole('button', { name: 'Later' }).click()
      await expect(page.locator('.update-modal')).toBeHidden()
      writeFixture(fixturePath, [release(newer, notesBody(changelog('feat: lone change (#3)')))])

      await openUpdateModal(app, page)
      const lone = page.locator('.update-notes')
      await expect(lone).toContainText('lone change')
      await expect(lone.locator('.update-notes-ver')).toHaveCount(0)
      await expect(lone.locator('h2')).toHaveText([/What.s Changed/])
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('B18 release notes never render an <img>, so a release body cannot make the privileged renderer fetch a remote image', async ({
    env
  }) => {
    const fixturePath = withFixtureEnv(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const version = await app.evaluate(({ app }) => app.getVersion())
      const v = higher(version)
      const body = notesBody(
        changelog('feat: item beside a picture (#1)', '![shot](https://example.invalid/shot.png)')
      )
      writeFixture(fixturePath, [release(v, body)])

      await openUpdateModal(app, page)
      const notes = page.locator('.update-notes')
      await expect(notes).toContainText('item beside a picture')
      await expect(notes.locator('img')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })
})

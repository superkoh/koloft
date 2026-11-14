import type { Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings } from './helpers/env'
import { openSettings } from './helpers/extensions'
import { notesArea, startSessionIn, waitBooted } from './helpers/p1'

const ALL_FOUR_FACES_LOADED = [
  'italic 400 loaded',
  'italic 700 loaded',
  'normal 400 loaded',
  'normal 700 loaded'
]

function bundledFaceStates(): string[] {
  return [...document.fonts]
    .filter(
      (f) =>
        f.family.replace(/["']/g, '') === 'JetBrainsMono Nerd Font' &&
        ['normal 400', 'normal 700', 'italic 400', 'italic 700'].includes(`${f.style} ${f.weight}`)
    )
    .map((f) => `${f.style} ${f.weight} ${f.status}`)
    .sort()
}

const DEFINE_BUNDLED_FACE_STATES_IN_THE_PAGE = `window.__bundledFaceStates = ${bundledFaceStates}`

type FontProbeWindow = {
  __bundledFaceStates(): string[]
  __bundledFacesAtFirstTerminal?: string[]
  __bundledFacesAtFontChange?: string[]
  __koloftTerms: Record<string, Terminal>
}

function recorded(page: Page, name: keyof FontProbeWindow): Promise<unknown> {
  return page
    .waitForFunction((key) => (window as unknown as FontProbeWindow)[key], name, {
      timeout: 30_000
    })
    .then((faces) => faces.jsonValue())
}

function focusIn(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((s) => !!document.activeElement?.closest(s), selector)
}

async function restoreWithFacesHeldBack(page: Page, meanwhile: () => Promise<void>) {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await page.addInitScript(() => {
    const w = window as unknown as { __releaseFaces: () => void }
    const released = new Promise<void>((resolve) => (w.__releaseFaces = resolve))
    const load = document.fonts.load.bind(document.fonts)
    document.fonts.load = (...args) => released.then(() => load(...args))
  })
  await page.reload()
  await waitBooted(page)
  await expect(page.locator('.term').first()).toBeAttached()
  await meanwhile()
  expect(await page.locator('.xterm').count()).toBe(0)
  await page.evaluate(() => (window as unknown as { __releaseFaces: () => void }).__releaseFaces())
  await expect(page.locator('.xterm').first()).toBeAttached({ timeout: 30_000 })
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
}

test.describe('the terminal font ships with the app', () => {
  test('the four JetBrainsMono Nerd Font faces a terminal draws with (regular, bold, italic, bold italic) have loaded before the first terminal opens', async ({
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    await page.addInitScript(DEFINE_BUNDLED_FACE_STATES_IN_THE_PAGE)
    await page.addInitScript(() => {
      const w = window as unknown as FontProbeWindow
      const seen = new MutationObserver(() => {
        if (!document.querySelector('.xterm')) return
        seen.disconnect()
        w.__bundledFacesAtFirstTerminal = w.__bundledFaceStates()
      })
      seen.observe(document, { childList: true, subtree: true })
    })
    await page.reload()

    expect(await recorded(page, '__bundledFacesAtFirstTerminal')).toEqual(ALL_FOUR_FACES_LOADED)
  })

  test('a restored terminal built once its faces have loaded takes the keyboard when nobody moved it meanwhile', async ({
    page
  }) => {
    await restoreWithFacesHeldBack(page, async () => {})
    await expect.poll(() => focusIn(page, '.xterm')).toBe(true)
  })

  test('a restored terminal built once its faces have loaded leaves the keyboard in the note the owner clicked meanwhile', async ({
    page
  }) => {
    await restoreWithFacesHeldBack(page, async () => {
      await notesArea(page).click()
      expect(await focusIn(page, '.isl-notes')).toBe(true)
    })
    expect(await focusIn(page, '.isl-notes')).toBe(true)
  })

  test('a change from a system font to JetBrainsMono Nerd Font in Settings reaches an open terminal only once its four faces have loaded', async ({
    env
  }) => {
    seedSettings(env, { fontFamily: 'Menlo' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')

      await page.evaluate(DEFINE_BUNDLED_FACE_STATES_IN_THE_PAGE)
      const openTerminals = await page.evaluate(() => {
        const w = window as unknown as FontProbeWindow
        const terms = Object.values(w.__koloftTerms)
        for (const term of terms) {
          const watched = new Proxy(term.options, {
            set(options, name, value) {
              if (name === 'fontFamily' && value === 'JetBrainsMono Nerd Font')
                w.__bundledFacesAtFontChange ??= w.__bundledFaceStates()
              return Reflect.set(options, name, value)
            }
          })
          Object.defineProperty(term, 'options', { get: () => watched })
        }
        return terms.length
      })
      expect(openTerminals).toBeGreaterThan(0)

      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'Appearance' }).click()
      const chip = page.getByRole('button', { name: 'JetBrainsMono Nerd Font', exact: true })
      await expect(chip).toBeVisible()
      const facesBeforeTheChange = await page.evaluate(() =>
        (window as unknown as FontProbeWindow).__bundledFaceStates()
      )
      expect(facesBeforeTheChange).toHaveLength(ALL_FOUR_FACES_LOADED.length)
      expect(facesBeforeTheChange).not.toEqual(ALL_FOUR_FACES_LOADED)
      await chip.click()

      expect(await recorded(page, '__bundledFacesAtFontChange')).toEqual(ALL_FOUR_FACES_LOADED)
    } finally {
      await quitAndClose(app)
    }
  })
})

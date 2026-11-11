import type { Terminal } from '@xterm/xterm'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings } from './helpers/env'
import { openSettings } from './helpers/extensions'
import { startSessionIn, waitBooted } from './helpers/p1'

const ALL_FOUR_FACES_LOADED = [
  'italic 400 loaded',
  'italic 700 loaded',
  'normal 400 loaded',
  'normal 700 loaded'
]

test.describe('the terminal font ships with the app', () => {
  test('the four JetBrainsMono Nerd Font faces a terminal draws with (regular, bold, italic, bold italic) have loaded before the first terminal opens', async ({
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    await page.addInitScript(() => {
      const w = window as unknown as { __bundledFacesAtFirstTerminal?: string[] }
      const seen = new MutationObserver(() => {
        if (!document.querySelector('.xterm')) return
        seen.disconnect()
        w.__bundledFacesAtFirstTerminal = [...document.fonts]
          .filter(
            (f) =>
              f.family.replace(/["']/g, '') === 'JetBrainsMono Nerd Font' &&
              ['normal 400', 'normal 700', 'italic 400', 'italic 700'].includes(
                `${f.style} ${f.weight}`
              )
          )
          .map((f) => `${f.style} ${f.weight} ${f.status}`)
          .sort()
      })
      seen.observe(document, { childList: true, subtree: true })
    })
    await page.reload()
    const faces = await page.waitForFunction(
      () =>
        (window as unknown as { __bundledFacesAtFirstTerminal?: string[] })
          .__bundledFacesAtFirstTerminal,
      undefined,
      { timeout: 30_000 }
    )

    expect(await faces.jsonValue()).toEqual(ALL_FOUR_FACES_LOADED)
  })

  test('a change from a system font to JetBrainsMono Nerd Font in Settings reaches an open terminal only once its four faces have loaded', async ({
    env
  }) => {
    seedSettings(env, { fontFamily: 'Menlo' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')

      const openTerminals = await page.evaluate(() => {
        const w = window as unknown as {
          __koloftTerms: Record<string, Terminal>
          __bundledFacesAtFontChange?: string[]
        }
        const terms = Object.values(w.__koloftTerms)
        for (const term of terms) {
          const watched = new Proxy(term.options, {
            set(options, name, value) {
              if (name === 'fontFamily' && String(value).includes('JetBrainsMono'))
                w.__bundledFacesAtFontChange ??= [...document.fonts]
                  .filter(
                    (f) =>
                      f.family.replace(/["']/g, '') === 'JetBrainsMono Nerd Font' &&
                      ['normal 400', 'normal 700', 'italic 400', 'italic 700'].includes(
                        `${f.style} ${f.weight}`
                      )
                  )
                  .map((f) => `${f.style} ${f.weight} ${f.status}`)
                  .sort()
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
      await page.getByRole('button', { name: 'JetBrainsMono Nerd Font', exact: true }).click()
      const faces = await page.waitForFunction(
        () =>
          (window as unknown as { __bundledFacesAtFontChange?: string[] })
            .__bundledFacesAtFontChange,
        undefined,
        { timeout: 30_000 }
      )

      expect(await faces.jsonValue()).toEqual(ALL_FOUR_FACES_LOADED)
    } finally {
      await quitAndClose(app)
    }
  })
})

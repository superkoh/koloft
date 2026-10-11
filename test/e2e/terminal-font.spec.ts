import { test, expect } from './helpers/app'
import { startSessionIn, waitBooted } from './helpers/p1'

test.describe('the terminal font ships with the app', () => {
  test('every bundled JetBrainsMono Nerd Font face has loaded before the first terminal opens', async ({
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
          .filter((f) => f.family.replace(/["']/g, '') === 'JetBrainsMono Nerd Font')
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

    expect(await faces.jsonValue()).toEqual([
      'italic 400 loaded',
      'italic 700 loaded',
      'normal 400 loaded',
      'normal 600 loaded',
      'normal 700 loaded'
    ])
  })
})

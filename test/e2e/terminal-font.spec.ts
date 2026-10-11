import { test, expect } from './helpers/app'
import { startSessionIn, termIds, waitBooted } from './helpers/p1'

test.describe('the terminal font ships with the app', () => {
  test('every bundled JetBrainsMono Nerd Font face has loaded by the time the first terminal opens, so xterm measures its cells in it', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const ids = await termIds(page)

    await app.context().addInitScript(() => {
      const w = window as unknown as { __bundledFacesAtFirstTerminal?: string[] }
      const seen = new MutationObserver(() => {
        if (!document.querySelector('.xterm')) return
        seen.disconnect()
        w.__bundledFacesAtFirstTerminal = [...document.fonts]
          .filter((f) => f.family.replace(/["']/g, '') === 'JetBrainsMono Nerd Font')
          .map((f) => `${f.style} ${f.weight} ${f.status}`)
      })
      seen.observe(document, { childList: true, subtree: true })
    })
    await page.reload()
    await waitBooted(page)
    await expect.poll(() => termIds(page), { timeout: 30_000 }).toEqual(ids)

    const faces = await page.evaluate(
      () =>
        (window as unknown as { __bundledFacesAtFirstTerminal?: string[] })
          .__bundledFacesAtFirstTerminal
    )
    expect(faces).toEqual(
      expect.arrayContaining([
        'italic 400 loaded',
        'italic 700 loaded',
        'normal 400 loaded',
        'normal 700 loaded'
      ])
    )
  })
})

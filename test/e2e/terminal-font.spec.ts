import type { Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { launchSettled } from './helpers/blackbox'
import { installAgentFor, seedSettings, type E2EEnv } from './helpers/env'
import { openSettings } from './helpers/extensions'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  agyReady,
  killFakeRemote,
  launchWithRemote,
  type OtherAgentName
} from './helpers/remote'
import {
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  newSessionInWith,
  notesArea,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'

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

const LONG_ENOUGH_FOR_A_LATE_FOCUS_GRAB_MS = 1_000

async function restoreWithFacesHeldBack(page: Page, meanwhile: () => Promise<void>) {
  await page.addInitScript(() => {
    const w = window as unknown as { __releaseFaces: () => void }
    const released = new Promise<void>((resolve) => (w.__releaseFaces = resolve))
    const load = document.fonts.load.bind(document.fonts)
    document.fonts.load = (...args) => released.then(() => load(...args))
  })
  await page.reload()
  await waitBooted(page)
  await expect(page.locator('.term').first()).toBeAttached({ timeout: 30_000 })
  await meanwhile()
  expect(await page.locator('.xterm').count()).toBe(0)
  await page.evaluate(() => (window as unknown as { __releaseFaces: () => void }).__releaseFaces())
  await expect(page.locator('.xterm').first()).toBeAttached({ timeout: 30_000 })
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
}

interface SessionTab {
  name: string
  remote: boolean
  install?: (env: E2EEnv) => void
  start: (page: Page) => Promise<unknown>
}

const wsOf = (tab: SessionTab): string => (tab.remote ? REMOTE_WS_NAME : 'ws-a')

const BOUND_ON_THIS_MAC: Partial<Record<OtherAgentName, (page: Page) => Promise<unknown>>> = {
  // AGY§8
  Antigravity: async (page) => {
    await agyReady(page)
    await runIn(page, centerTerm(page), 'first words')
    await agyConversationOnceFirstTurnEnded(page)
  }
}

const EVERY_SESSION_TAB: SessionTab[] = [
  {
    name: 'Claude tab on this Mac',
    remote: false,
    start: (page) => startSessionIn(page, 'ws-a')
  },
  ...OTHER_AGENTS_ON_THE_MACHINE.map(({ label }): SessionTab => ({
    name: `${label} tab on this Mac`,
    remote: false,
    install: (env) => installAgentFor(env, label, env.workspaces.a),
    start: async (page) => {
      await newSessionInWith(page, 'ws-a', label)
      await BOUND_ON_THIS_MAC[label]?.(page)
    }
  })),
  {
    name: 'Claude tab on a machine reached over SSH',
    remote: true,
    start: (page) => startSessionIn(page, REMOTE_WS_NAME, { remote: true })
  },
  ...OTHER_AGENTS_ON_THE_MACHINE.map(({ label, install, bound }): SessionTab => ({
    name: `${label} tab on a machine reached over SSH`,
    remote: true,
    install,
    start: async (page) => {
      await newSessionInWith(page, REMOTE_WS_NAME, label)
      await bound?.(page)
    }
  }))
]

async function withSessionTab(
  env: E2EEnv,
  tab: SessionTab,
  body: (page: Page) => Promise<void>
): Promise<void> {
  test.setTimeout(tab.remote ? 240_000 : 120_000)
  tab.install?.(env)
  seedSettings(env, { hintsOff: true })
  const { app, page } = tab.remote ? await launchWithRemote(env) : await launchSettled(env)
  try {
    if (tab.remote) await addRemoteWorkspace(page, env)
    await tab.start(page)
    await expect(wsRows(page, wsOf(tab)).first()).toHaveClass(/st-waiting/, { timeout: 60_000 })
    await body(page)
  } finally {
    await quitAndClose(app)
  }
}

test.describe('the terminal font ships with the app', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

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

  for (const tab of EVERY_SESSION_TAB) {
    test(`a restored ${tab.name} built once its faces have loaded takes the keyboard when nobody moved it meanwhile`, async ({
      env
    }) => {
      await withSessionTab(env, tab, async (page) => {
        await restoreWithFacesHeldBack(page, async () => {})
        await expect.poll(() => focusIn(page, '.xterm')).toBe(true)
      })
    })

    test(`a restored ${tab.name} built once its faces have loaded leaves the keyboard in the note the owner clicked meanwhile`, async ({
      env
    }) => {
      await withSessionTab(env, tab, async (page) => {
        await restoreWithFacesHeldBack(page, async () => {
          await notesArea(page).click()
          expect(await focusIn(page, '.isl-notes')).toBe(true)
        })
        await page.waitForTimeout(LONG_ENOUGH_FOR_A_LATE_FOCUS_GRAB_MS)
        expect(await focusIn(page, '.isl-notes')).toBe(true)
      })
    })
  }

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

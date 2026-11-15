import type { Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installAgy,
  installCodex,
  installMuse,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import { openSettings } from './helpers/extensions'
import { startCodex } from './helpers/codex'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  agyReady,
  killFakeRemote,
  launchWithRemote
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

async function restoreWithFacesHeldBack(
  page: Page,
  start: (page: Page) => Promise<unknown>,
  meanwhile: () => Promise<void>
) {
  await waitBooted(page)
  await start(page)
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

type StartTab = (page: Page) => Promise<unknown>

const startClaudeInWsA: StartTab = (page) => startSessionIn(page, 'ws-a')

async function takesTheKeyboardWhenNobodyMovedIt(page: Page, start: StartTab): Promise<void> {
  await restoreWithFacesHeldBack(page, start, async () => {})
  await expect.poll(() => focusIn(page, '.xterm')).toBe(true)
}

async function leavesTheKeyboardInTheClickedNote(page: Page, start: StartTab): Promise<void> {
  await restoreWithFacesHeldBack(page, start, async () => {
    await notesArea(page).click()
    expect(await focusIn(page, '.isl-notes')).toBe(true)
  })
  expect(await focusIn(page, '.isl-notes')).toBe(true)
}

interface OtherTab {
  name: string
  remote: boolean
  install: (env: E2EEnv) => void
  start: (page: Page, env: E2EEnv) => Promise<unknown>
}

const OTHER_TABS: OtherTab[] = [
  {
    name: 'Codex tab on this Mac',
    remote: false,
    install: (env) => installCodex(env),
    start: (page, env) => startCodex(page, env)
  },
  {
    name: 'Muse tab on this Mac',
    remote: false,
    install: (env) => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
    },
    start: async (page) => {
      await newSessionInWith(page, 'ws-a', 'Muse')
      await expect(wsRows(page, 'ws-a').and(page.locator('.active'))).toHaveClass(/st-waiting/, {
        timeout: 30_000
      })
    }
  },
  {
    name: 'Antigravity tab on this Mac',
    remote: false,
    install: (env) => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    },
    // AGY§8
    start: async (page) => {
      await newSessionInWith(page, 'ws-a', 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'first words')
      await agyConversationOnceFirstTurnEnded(page)
    }
  },
  {
    name: 'Claude tab on a machine reached over SSH',
    remote: true,
    install: () => {},
    start: (page) => startSessionIn(page, REMOTE_WS_NAME, { remote: true })
  },
  ...OTHER_AGENTS_ON_THE_MACHINE.map((agent): OtherTab => ({
    name: `${agent.label} tab on a machine reached over SSH`,
    remote: true,
    install: agent.install,
    start: async (page) => {
      await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
      await agent.bound?.(page)
      await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/st-waiting/, {
        timeout: 60_000
      })
    }
  }))
]

async function withAppFor(
  env: E2EEnv,
  tab: OtherTab,
  body: (page: Page, start: StartTab) => Promise<void>
): Promise<void> {
  tab.install(env)
  seedSettings(env, { hintsOff: true })
  const { app, page } = tab.remote
    ? await launchWithRemote(env)
    : await launchApp(env).then(async (app) => ({ app, page: await app.firstWindow() }))
  try {
    if (tab.remote) await addRemoteWorkspace(page, env)
    await body(page, (p) => tab.start(p, env))
  } finally {
    await quitAndClose(app)
    if (tab.remote) killFakeRemote(env)
  }
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
    await takesTheKeyboardWhenNobodyMovedIt(page, startClaudeInWsA)
  })

  test('a restored terminal built once its faces have loaded leaves the keyboard in the note the owner clicked meanwhile', async ({
    page
  }) => {
    await leavesTheKeyboardInTheClickedNote(page, startClaudeInWsA)
  })

  for (const tab of OTHER_TABS) {
    test(`a restored ${tab.name} built once its faces have loaded takes the keyboard when nobody moved it meanwhile`, async ({
      env
    }) => {
      test.setTimeout(tab.remote ? 240_000 : 120_000)
      await withAppFor(env, tab, takesTheKeyboardWhenNobodyMovedIt)
    })

    test(`a restored ${tab.name} built once its faces have loaded leaves the keyboard in the note the owner clicked meanwhile`, async ({
      env
    }) => {
      test.setTimeout(tab.remote ? 240_000 : 120_000)
      await withAppFor(env, tab, leavesTheKeyboardInTheClickedNote)
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

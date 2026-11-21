import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  butlerRow,
  startSessionIn,
  switchToRow,
  terminalText,
  waitBooted,
  waitForCalls
} from './helpers/p1'
import { guestByUrl } from './helpers/browser'
import { closeSettings, openSettings } from './helpers/extensions'
import { startEchoServer } from './helpers/fixtureServer'
import { OWNER_DECLINED, OWNER_FILLED } from '../../src/plugins/passwords/main/secretVerb'

test.setTimeout(120_000)

const SIGN_IN_HOST = 'koloft-a.test'
const SECRET_BAR = '[role="alertdialog"][aria-label="Secret ask"]'
const SUDO_BOX = '.term-wrap .secret-modal'
const SIGN_IN_CODE_NO_SESSION_ID_CAN_CONTAIN = 'owner_only_zq'

function ownerAtTheMac(env: E2EEnv): void {
  const presence = path.join(env.home, 'presence.txt')
  fs.writeFileSync(presence, 'active')
  env.launchEnv.KOLOFT_TEST_PRESENCE_FILE = presence
}

async function sessionTab(page: Page, env: E2EEnv): Promise<string> {
  await startSessionIn(page, 'ws-a')
  const sessionId = (await waitForCalls(env, 1))[0].sessionId
  const all = await page.evaluate(() => window.api.sessions.list())
  return all.find((s) => s.sessionId === sessionId)!.tabId
}

function type(page: Page, tab: string, line: string): Promise<void> {
  return page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [tab, line])
}

const unwrapped = (s: string): string => s.replace(/\s+/g, '')

function servesALoginPage(server: Awaited<ReturnType<typeof startEchoServer>>): string {
  server.page('/done', '<!doctype html><title>done</title>')
  return server.page(
    '/login',
    '<!doctype html><title>login</title><form id="f" action="/done"><label for="pw">Password</label><input type="password" id="pw" name="pw"><button id="go">Sign in</button></form>'
  )
}

async function askSudo(page: Page, tab: string): Promise<void> {
  await type(
    page,
    tab,
    `/sh "$(dirname "$(command -v koloft)")/koloft-askpass" 'Password:' && echo got-it`
  )
  await expect(page.locator(SUDO_BOX)).toBeVisible({ timeout: 30_000 })
}

const twoFramesPass = (page: Page): Promise<void> =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  )

const sudoField = (page: Page): Locator => page.locator(SUDO_BOX).getByLabel('Your sudo password')

async function ownerTypesInSessionDefaults(page: Page, typed: string): Promise<Locator> {
  await page.locator('.ws-head', { hasText: 'ws-a' }).click({ button: 'right' })
  await page.locator('.menu .mi', { hasText: 'Session defaults…' }).click()
  const box = page
    .getByRole('dialog', { name: 'Session defaults' })
    .getByRole('textbox', { name: 'Instructions' })
  await box.fill(typed)
  return box
}

async function keysStayIn(page: Page, box: Locator, typed: string): Promise<void> {
  await twoFramesPass(page)
  await expect(box).toBeFocused()
  await page.keyboard.type(' more')
  await expect(box).toHaveValue(`${typed} more`)
}

async function sudoTakesTheKeysOnceItShows(page: Page, tab: string, typed: string): Promise<void> {
  await expect(sudoField(page)).toBeFocused()
  await page.keyboard.type('hunter2-after')
  await page.keyboard.press('Enter')
  await expect.poll(() => terminalText(page, tab)).toContain('hunter2-after\ngot-it')
  expect(await terminalText(page, tab)).not.toContain(typed)
}

test.describe('Koloft asks the owner for a password in the session’s own tab, with no Discord bound', () => {
  test('sudo’s password helper shows a box over that session’s terminal, which holds the keys, marks the row and the bell as needing the owner, and passes what is typed to sudo alone; Esc turns it down', async ({
    env
  }) => {
    ownerAtTheMac(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      const tab = await sessionTab(page, env)
      await askSudo(page, tab)
      const row = page.locator(`.ws-tab[data-tab-id="${tab}"]`)
      await expect(row).toHaveClass(/\bst-approval\b/)
      await expect
        .poll(async () => (await pendingAttention(page)).find((e) => e.tabId === tab)?.kind)
        .toBe('approval')
      await expect(page.locator(SUDO_BOX)).toContainText('sudo asks: Password:')
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
        .toBe('Your sudo password')
      const typed = 'hunter2-box "x" \\'
      await page.keyboard.type(typed)
      await page.keyboard.press('Enter')
      await expect(page.locator(SUDO_BOX)).toHaveCount(0)
      await expect.poll(() => terminalText(page, tab)).toContain(`${typed}\ngot-it`)
      await expect(row).not.toHaveClass(/\bst-approval\b/)
      expect((await pendingAttention(page)).some((e) => e.kind === 'approval')).toBe(false)

      await askSudo(page, tab)
      await page.keyboard.press('Escape')
      await expect
        .poll(async () => unwrapped(await terminalText(page, tab)))
        .toContain(unwrapped(OWNER_DECLINED))
      await expect(page.locator(SUDO_BOX)).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a sudo ask that comes while the owner types in Session defaults leaves the keys there, so nothing they type reaches the sudo field or sudo; once Session defaults closes, the sudo box takes the keys', async ({
    env
  }) => {
    ownerAtTheMac(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      const tab = await sessionTab(page, env)
      const typed = 'Answer in English.'
      const box = await ownerTypesInSessionDefaults(page, typed)
      await askSudo(page, tab)
      await keysStayIn(page, box, typed)
      await expect(sudoField(page)).toHaveValue('')
      expect(await terminalText(page, tab)).not.toMatch(/^got-it$/m)

      const dlg = page.getByRole('dialog', { name: 'Session defaults' })
      await dlg.getByLabel('Close').click()
      await expect(dlg).toHaveCount(0)
      await sudoTakesTheKeysOnceItShows(page, tab, typed)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a sudo ask from the butler while the owner types in its Instructions editor leaves the keys there; Esc closes the editor, not the ask, and the sudo box then takes the keys', async ({
    env
  }) => {
    test.setTimeout(180_000)
    ownerAtTheMac(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await butlerRow(page).click()
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const tab = (await butlerRow(page).getAttribute('data-tab-id')) ?? ''
      await page.locator('.butler-strip').getByRole('button', { name: 'Instructions' }).click()
      const editor = page.getByRole('dialog', { name: 'Instructions', exact: true })
      const box = editor.getByRole('textbox', { name: 'Instructions' })
      const typed = 'Answer in English.'
      await box.fill(typed)
      await askSudo(page, tab)
      await keysStayIn(page, box, typed)
      await expect(sudoField(page)).toHaveValue('')

      await page.keyboard.press('Escape')
      await expect(editor).toHaveCount(0)
      await expect(page.locator(SUDO_BOX)).toBeVisible()
      await sudoTakesTheKeysOnceItShows(page, tab, typed)
    } finally {
      await quitAndClose(app)
    }
  })

  test('turning Passwords and sign-in off and on in Settings ▸ Plugins while a session shows leaves the window working, and the next sudo still asks in the box', async ({
    env
  }) => {
    ownerAtTheMac(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      const windowErrors: string[] = []
      page.on('pageerror', (error) => windowErrors.push(error.message))
      const tab = await sessionTab(page, env)
      for (const on of [false, true]) {
        await openSettings(page)
        await page.locator('.set-ni', { hasText: 'Plugins' }).click()
        await page
          .getByRole('switch', { name: 'Passwords and sign-in', exact: true })
          .setChecked(on)
        await closeSettings(page)
      }
      await expect(page.locator(`.ws-tab[data-tab-id="${tab}"]`)).toBeVisible()
      await askSudo(page, tab)
      await page.keyboard.type('hunter2-after-flip')
      await page.keyboard.press('Enter')
      await expect.poll(() => terminalText(page, tab)).toContain('hunter2-after-flip\ngot-it')
      expect(windowErrors).toEqual([])
    } finally {
      await quitAndClose(app)
    }
  })

  test('koloft secret page brings the page forward in the session’s Workbench with a bar above it; the owner types into the page itself, and once it moves on the session hears the owner filled it in', async ({
    env
  }) => {
    ownerAtTheMac(env)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const login = servesALoginPage(server)
      const page = await app.firstWindow()
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft open ${login}`)
      const guest = await guestByUrl(app, '/login')
      await expect(guest.locator('#pw')).toBeVisible()
      await type(page, tab, '/koloft secret page "#pw"')
      await expect(page.locator(SECRET_BAR)).toContainText('needs your Password on this page')
      await expect(page.locator(`.ws-tab[data-tab-id="${tab}"]`)).toHaveClass(/\bst-approval\b/)
      await guest.locator('#pw').fill('typed-by-the-owner')
      await guest.locator('#go').click()
      await expect.poll(() => guest.title()).toBe('done')
      await expect
        .poll(async () => unwrapped(await terminalText(page, tab)))
        .toContain(unwrapped(OWNER_FILLED))
      await expect(page.locator(SECRET_BAR)).toHaveCount(0)
      expect(unwrapped(await terminalText(page, tab))).not.toContain('typed-by-the-owner')
    } finally {
      await quitAndClose(app)
      await server.close()
    }
  })

  test('koloft secret page while the owner types in Session defaults leaves the keys there, so nothing they type lands in the page’s password field; once Session defaults closes, the page takes the keys', async ({
    env
  }) => {
    ownerAtTheMac(env)
    seedSettings(env, { hintsOff: true })
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const login = servesALoginPage(server)
      const page = await app.firstWindow()
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft open ${login}`)
      const guest = await guestByUrl(app, '/login')
      await expect(guest.locator('#pw')).toBeVisible()
      const typed = 'Answer in English.'
      const box = await ownerTypesInSessionDefaults(page, typed)
      await type(page, tab, '/koloft secret page "#pw"')
      await expect(page.locator(SECRET_BAR)).toContainText('needs your Password on this page')
      await keysStayIn(page, box, typed)
      await expect(guest.locator('#pw')).toHaveValue('')

      const dlg = page.getByRole('dialog', { name: 'Session defaults' })
      await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
      await expect(dlg).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('WEBVIEW')
      await page.keyboard.type('typed-by-the-owner')
      await expect(guest.locator('#pw')).toHaveValue('typed-by-the-owner')
      await page.keyboard.press('Enter')
      await expect.poll(() => guest.title()).toBe('done')
      await expect
        .poll(async () => unwrapped(await terminalText(page, tab)))
        .toContain(unwrapped(OWNER_FILLED))
      const heard = await terminalText(page, tab)
      expect(heard).not.toContain('typed-by-the-owner')
      expect(heard).not.toContain(typed)
    } finally {
      await quitAndClose(app)
      await server.close()
    }
  })

  test('koloft secret page while the owner types in the sudo box of the same session leaves the keys in the sudo box, so the rest of the sudo password goes to sudo; once the sudo box is answered, the page takes the keys', async ({
    env
  }) => {
    ownerAtTheMac(env)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const login = servesALoginPage(server)
      const page = await app.firstWindow()
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft open ${login}`)
      const guest = await guestByUrl(app, '/login')
      await expect(guest.locator('#pw')).toBeVisible()
      await askSudo(page, tab)
      await expect(sudoField(page)).toBeFocused()
      await page.keyboard.type('hunter2-')
      await type(page, tab, '/koloft secret page "#pw"')
      await expect(page.locator(SECRET_BAR)).toContainText('needs your Password on this page')
      await twoFramesPass(page)
      await page.keyboard.type('rest')
      await expect(sudoField(page)).toHaveValue('hunter2-rest')
      await expect(guest.locator('#pw')).toHaveValue('')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => unwrapped(await terminalText(page, tab)))
        .toContain('hunter2-restgot-it')

      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('WEBVIEW')
      await page.keyboard.type('typed-by-the-owner')
      await expect(guest.locator('#pw')).toHaveValue('typed-by-the-owner')
      await page.keyboard.press('Enter')
      await expect.poll(() => guest.title()).toBe('done')
      await expect
        .poll(async () => unwrapped(await terminalText(page, tab)))
        .toContain(unwrapped(OWNER_FILLED))
      expect(unwrapped(await terminalText(page, tab))).not.toContain('typed-by-the-owner')
    } finally {
      await quitAndClose(app)
      await server.close()
    }
  })

  test('a page ask and then a sudo ask of the same session, both come while the owner types in Session defaults: once it closes the sudo box takes the keys, and the page takes them once the sudo box is answered', async ({
    env
  }) => {
    ownerAtTheMac(env)
    seedSettings(env, { hintsOff: true })
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const login = servesALoginPage(server)
      const page = await app.firstWindow()
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft open ${login}`)
      const guest = await guestByUrl(app, '/login')
      await expect(guest.locator('#pw')).toBeVisible()
      const typed = 'Answer in English.'
      const box = await ownerTypesInSessionDefaults(page, typed)
      await type(page, tab, '/koloft secret page "#pw"')
      await expect(page.locator(SECRET_BAR)).toContainText('needs your Password on this page')
      await twoFramesPass(page)
      await askSudo(page, tab)
      await keysStayIn(page, box, typed)

      const dlg = page.getByRole('dialog', { name: 'Session defaults' })
      await dlg.getByLabel('Close').click()
      await expect(dlg).toHaveCount(0)
      await sudoTakesTheKeysOnceItShows(page, tab, typed)
      await expect(guest.locator('#pw')).toHaveValue('')

      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('WEBVIEW')
      await page.keyboard.type('typed-by-the-owner')
      await expect(guest.locator('#pw')).toHaveValue('typed-by-the-owner')
    } finally {
      await quitAndClose(app)
      await server.close()
    }
  })

  for (const callbackHost of ['localhost', '127.0.0.1']) {
    test(`koloft secret url from a session that is not on screen marks its row, opens the sign-in in its own Workbench with a bar above it; once that sign-in, after its redirects, lands on its ${callbackHost} address the session hears it finished, without the address and its code`, async ({
      env
    }) => {
      ownerAtTheMac(env)
      seedSettings(env, { hintsOff: true })
      const server = await startEchoServer()
      const cli = await startEchoServer()
      env.extraArgs.push(`--host-resolver-rules=MAP ${SIGN_IN_HOST} 127.0.0.1`)
      const app = await launchApp(env)
      try {
        cli.route('/auth/callback', (_q, res) => {
          res.writeHead(200)
          res.end('signed in')
        })
        const callback = `http://${callbackHost}:${cli.port}/auth/callback?code=${SIGN_IN_CODE_NO_SESSION_ID_CAN_CONTAIN}`
        server.route('/authorize', (_q, res) => {
          res.writeHead(302, { location: '/sign-in' })
          res.end()
        })
        server.page(
          '/sign-in',
          `<!doctype html><title>sign in</title><a id="go" href="${callback}">Continue</a>`
        )
        const page = await app.firstWindow()
        const tab = await sessionTab(page, env)
        await startSessionIn(page, 'ws-a')
        await waitForCalls(env, 2)
        await type(page, tab, `/koloft secret url "${server.hostUrl(SIGN_IN_HOST, '/authorize')}"`)
        const row = page.locator(`.ws-tab[data-tab-id="${tab}"]`)
        await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
        await switchToRow(page, row)
        const signIn = await guestByUrl(app, '/sign-in')
        await expect(page.locator(SECRET_BAR)).toContainText('finish this sign-in here')
        await signIn.locator('#go').click()
        await expect
          .poll(() => cli.requestsFor('/auth/callback').map((r) => r.search))
          .toEqual([`?code=${SIGN_IN_CODE_NO_SESSION_ID_CAN_CONTAIN}`])
        await expect
          .poll(async () => unwrapped(await terminalText(page, tab)))
          .toContain(unwrapped('finished the sign-in in this session'))
        await expect
          .poll(async () => unwrapped(await terminalText(page, tab)))
          .toContain(unwrapped('koloft exit=0'))
        await expect(page.locator(SECRET_BAR)).toHaveCount(0)
        const heard = unwrapped(await terminalText(page, tab))
        expect(heard).not.toContain(SIGN_IN_CODE_NO_SESSION_ID_CAN_CONTAIN)
        expect(heard).not.toContain('/auth/callback')
        expect(heard).not.toMatch(new RegExp(`:${cli.port}(?!\\d)`))
      } finally {
        await quitAndClose(app)
        await server.close()
        await cli.close()
      }
    })
  }
})

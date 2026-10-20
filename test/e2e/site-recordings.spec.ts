import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import http from 'http'
import type { AddressInfo } from 'net'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installCodex,
  seedClaudeTrust,
  seedSettings,
  seededAccount,
  type E2EEnv
} from './helpers/env'
import {
  centerTerm,
  gitCommitAll,
  gitInit,
  openSessionTerminal,
  panelTerm,
  runIn,
  sendShortcut,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { frameOf, refreshSiteAppCss, writeFilm, type RawFrame } from './helpers/siteFilm'

test.skip(
  !process.env.KOLOFT_SITE_RECORD,
  'site recordings: set KOLOFT_SITE_RECORD=1, KOLOFT_SMOKE_CLAUDE to a real claude, and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT (a Keychain account label) for its login; rewrites site/demo'
)

const FORECAST_BEFORE = `import type { Request, Response } from 'express'
import { fetchForecast } from '../weather'

export async function forecast(req: Request, res: Response) {
  const city = String(req.query.city ?? '')
  if (!city) return res.status(400).json({ error: 'city is required' })
  const data = await fetchForecast(city, 1)
  res.json({ city, days: data })
}
`

const PARENT_PICKS_UP_THE_REPORTS_MS = 20_000
const ASSIST_PASSES_THE_REPORT_ON_MS = 45_000

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
}

function seedDemoWorkspaces(env: E2EEnv): { tide: string; harbor: string } {
  const tide = path.join(env.home, 'Projects', 'tidewatch')
  const harbor = path.join(env.home, 'Projects', 'harbor-site')
  writeTree(tide, {
    'README.md': '# tidewatch\n\nTide and weather API.\n',
    'package.json': '{ "name": "tidewatch", "private": true }\n',
    'src/routes/forecast.ts': FORECAST_BEFORE,
    'src/weather.ts':
      'export interface DailyForecast { date: string; high: number; low: number }\n' +
      'export async function fetchForecast(city: string, days: number): Promise<DailyForecast[]> {\n  return []\n}\n',
    'test/forecast.test.ts': "import { test } from 'node:test'\n\ntest('forecast', () => {})\n",
    '.gitignore': 'NOTES.md\nnode_modules\n.playwright-cli\n'
  })
  writeTree(harbor, {
    'README.md': '# harbor-site\n\nThe marketing site.\n',
    'index.html': '<!doctype html>\n<title>Harbor</title>\n',
    '.gitignore': 'NOTES.md\n'
  })
  gitInit(tide)
  gitCommitAll(tide)
  gitInit(harbor)
  gitCommitAll(harbor)
  const tideReal = fs.realpathSync(tide)
  const harborReal = fs.realpathSync(harbor)
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({
      version: 6,
      workspaces: [{ path: tideReal }, { path: harborReal }],
      workbench: { defaultOpen: true },
      members: [],
      panels: {}
    })
  )
  seedClaudeTrust(env, [tideReal, harborReal])
  seedSettings(env, { onboardingSeen: true, hintsOff: true })
  fs.writeFileSync(path.join(env.home, '.zshrc'), "PROMPT='%1~ %# '\n")
  return { tide: tideReal, harbor: harborReal }
}

function claudeTokenFromKeychain(): string {
  const account = process.env.KOLOFT_SMOKE_ACCOUNT
  if (!account) return ''
  const service = process.env.KOLOFT_SMOKE_KEYCHAIN_SERVICE ?? 'koloft-claude-oauth'
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).replace(/\n$/, '')
  } catch {
    return ''
  }
}

const CLAUDE_TOKEN = process.env.KOLOFT_SMOKE_OAUTH_TOKEN || claudeTokenFromKeychain()
const HAVE_REAL_CLAUDE = fs.existsSync(process.env.KOLOFT_SMOKE_CLAUDE ?? '') && !!CLAUDE_TOKEN

function useRealClaude(env: E2EEnv, trusted: string[]): void {
  const spot = path.join(env.fakeBin, 'claude')
  fs.rmSync(spot, { force: true })
  fs.symlinkSync(process.env.KOLOFT_SMOKE_CLAUDE ?? '', spot)
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'])
    delete env.launchEnv[k]
  env.launchEnv.DISABLE_AUTOUPDATER = '1'
  fs.mkdirSync(path.join(env.home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(env.home, '.claude', 'CLAUDE.md'), 'Always reply in English.\n')
  fs.writeFileSync(
    path.join(env.home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: Object.fromEntries(trusted.map((dir) => [dir, { hasTrustDialogAccepted: true }]))
    })
  )
  seedSettings(env, {
    skipPermissions: true,
    accounts: [seededAccount('Personal')]
  })
  fs.writeFileSync(
    env.keychainFile,
    JSON.stringify({ 'koloft-dev-claude-oauth': { Personal: CLAUDE_TOKEN } })
  )
}

async function realTurn(
  page: Page,
  row: Locator,
  text: string,
  record = false
): Promise<RawFrame[]> {
  const frames: RawFrame[] = []
  const shoot = async (): Promise<void> => {
    if (record) frames.push({ t: Date.now(), ...(await frameOf(page)) })
  }
  await centerTerm(page).click()
  for (let i = 0; i < text.length; i += 6) {
    await page.keyboard.type(text.slice(i, i + 6))
    await shoot()
  }
  await page.waitForTimeout(1000)
  await page.keyboard.press('Enter')
  await expect(row).toHaveClass(/\bst-working\b/, { timeout: 20_000 })
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline && /\bst-working\b/.test((await row.getAttribute('class')) ?? '')) {
    await shoot()
    await page.waitForTimeout(700)
  }
  await page.waitForTimeout(2500)
  await shoot()
  return frames
}

async function sizeWindow(app: ElectronApplication, w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h),
    [w, h]
  )
}

interface Reel {
  shot(light?: boolean): Promise<void>
  roll(ms: number, every?: number): Promise<void>
  save(name: string): void
}

function reel(page: Page): Reel {
  let frames: RawFrame[] = []
  const shot = async (light = true): Promise<void> => {
    frames.push({ t: Date.now(), ...(await frameOf(page, light && frames.length > 0)) })
  }
  return {
    shot,
    async roll(ms, every = 150) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        await shot()
        await page.waitForTimeout(every)
      }
    },
    save(name) {
      writeFilm(name, [frames])
      frames = []
    }
  }
}

async function typeFilmed(page: Page, r: Reel, text: string): Promise<void> {
  for (const ch of text) {
    await page.keyboard.type(ch)
    await r.shot()
  }
}

async function startUsageServer(byToken: Record<string, [number, number]>): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const auth = String(req.headers['authorization'] ?? req.headers['x-api-key'] ?? '')
      const [u5, u7] = byToken[auth.replace(/^Bearer /, '')] ?? [0.1, 0.2]
      res.writeHead(200, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': String(u5),
        'anthropic-ratelimit-unified-7d-utilization': String(u7),
        'anthropic-ratelimit-unified-7d_oi-utilization': String(u7 / 2),
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
        'anthropic-ratelimit-unified-5h-reset': String(nowSec + 7200),
        'anthropic-ratelimit-unified-7d-reset': String(nowSec + 200000),
        'anthropic-ratelimit-unified-7d_oi-reset': String(nowSec + 200000)
      })
      res.end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

interface Film {
  stop(name: string): Promise<void>
}

function startFilm(page: Page, everyMs = 600): Film {
  const frames: RawFrame[] = []
  let on = true
  const loop = (async () => {
    while (on) {
      try {
        frames.push({ t: Date.now(), ...(await frameOf(page)) })
      } catch {}
      await new Promise((ok) => setTimeout(ok, everyMs))
    }
  })()
  return {
    async stop(name) {
      on = false
      await loop
      writeFilm(name, [frames])
    }
  }
}

async function typeSlowly(page: Page, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 3) {
    await page.keyboard.type(text.slice(i, i + 3))
    await page.waitForTimeout(60)
  }
}

async function ask(page: Page, text: string): Promise<void> {
  await centerTerm(page).click()
  await typeSlowly(page, text)
  await page.waitForTimeout(800)
  await page.keyboard.press('Enter')
}

async function launchReal(
  env: E2EEnv,
  extra: Record<string, unknown> = {},
  withCodex = false
): Promise<{ app: ElectronApplication; page: Page }> {
  const ws = seedDemoWorkspaces(env)
  useRealClaude(env, [ws.tide, ws.harbor])
  seedSettings(env, extra)
  if (withCodex) installCodex(env)
  env.launchEnv.KOLOFT_PROBE_BASE_URL = await startUsageServer({})
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await sizeWindow(app, 1440, 860)
  await waitBooted(page)
  return { app, page }
}

test('app.css: the built app stylesheet without comments, its fonts under fonts/', () => {
  refreshSiteAppCss()
})

test('pal-jump, pal-search, pal-start: ⌘P jumps to a session, searches what was said, starts a session from one line', async ({
  env
}) => {
  test.skip(!HAVE_REAL_CLAUDE, 'needs a real claude and its login')
  test.setTimeout(900_000)
  const { app, page } = await launchReal(env, {}, true)
  const palette = page.locator('.modal.palette')
  const box = palette.getByRole('textbox', { name: 'Ask or jump' })
  try {
    await startSessionIn(page, 'tidewatch', { method: 'Claude' })
    await realTurn(
      page,
      wsRows(page, 'tidewatch').first(),
      "the login test waits on a fixed timer, why's that flaky? one line, don't run anything"
    )
    await startSessionIn(page, 'harbor-site', { method: 'Claude' })
    await realTurn(
      page,
      wsRows(page, 'harbor-site').first(),
      "pick a dark mode colour for the pricing page, one line, don't run anything"
    )
    await page.waitForTimeout(4000)
    const r = reel(page)

    await r.roll(1200)
    await sendShortcut(app, 'shortcut:command-palette')
    await expect(box).toBeFocused()
    await r.roll(700)
    await typeFilmed(page, r, 'login')
    await r.roll(1000)
    await page.keyboard.press('ArrowDown')
    await r.roll(900)
    await page.keyboard.press('Enter')
    await expect(palette).toHaveCount(0)
    await r.roll(2500, 250)
    r.save('pal-jump')

    await r.roll(1000)
    await sendShortcut(app, 'shortcut:command-palette')
    await expect(box).toBeFocused()
    await r.roll(700)
    await typeFilmed(page, r, 'timer')
    await r.roll(1000)
    await page.keyboard.press('Alt+Enter')
    await r.roll(4000, 200)
    await page.keyboard.press('Enter')
    await r.roll(2500, 250)
    r.save('pal-search')

    await r.roll(1000)
    await sendShortcut(app, 'shortcut:command-palette')
    await expect(box).toBeFocused()
    await r.roll(700)
    await typeFilmed(page, r, "tidewatch's weather calls keep failing, make them retry")
    await r.roll(1500)
    await page.keyboard.press('Enter')
    await r.roll(1500, 150)
    const until = Date.now() + 90_000
    while (Date.now() < until && (await palette.count()) > 0) await r.roll(300, 150)
    await r.roll(16_000, 400)
    r.save('pal-start')
  } finally {
    await quitAndClose(app)
  }
})

test('assist: the butler starts a real claude session that adds GET /health and reports back', async ({
  env
}) => {
  test.skip(!HAVE_REAL_CLAUDE, 'needs a real claude and its login')
  test.setTimeout(900_000)
  const { app, page } = await launchReal(env, { assist: { on: true, backend: 'claude' } })
  try {
    const film = startFilm(page, 800)
    await page.waitForTimeout(1500)
    await page.locator('.isl-butler > .ws-tab').click()
    await page.waitForTimeout(12_000)
    await ask(page, "add a health check to tidewatch and tell me when it's done")
    const child = wsRows(page, 'tidewatch').first()
    await expect(wsRows(page, 'tidewatch')).toHaveCount(1, { timeout: 240_000 })
    await expect(child).toHaveClass(/\bst-working\b/, { timeout: 120_000 })
    await expect(child).not.toHaveClass(/\bst-working\b/, { timeout: 420_000 })
    await page.waitForTimeout(ASSIST_PASSES_THE_REPORT_ON_MS)
    await film.stop('assist')
  } finally {
    await quitAndClose(app)
  }
})

test('tree: a real claude splits a job into two sibling sessions that hang under it and report back', async ({
  env
}) => {
  test.skip(!HAVE_REAL_CLAUDE, 'needs a real claude and its login')
  test.setTimeout(1_200_000)
  const { app, page } = await launchReal(env)
  try {
    await startSessionIn(page, 'tidewatch')
    const parent = wsRows(page, 'tidewatch').first()
    const parentId = await parent.getAttribute('data-tab-id')
    const children = page.locator(`.ws-tab[data-tab-id="${parentId}"] + .ws-subtabs > .ws-tab`)
    await page.waitForTimeout(4000)
    const film = startFilm(page, 700)
    await ask(
      page,
      'get two sessions on this in parallel: a /health endpoint, and a quick start in the README'
    )
    await expect(children).toHaveCount(2, { timeout: 300_000 })
    await expect(children.first()).toHaveClass(/\bst-working\b/, { timeout: 120_000 })
    await expect
      .poll(
        async () =>
          children.evaluateAll((els) => els.every((e) => !/\bst-working\b/.test(e.className))),
        {
          timeout: 600_000,
          intervals: [3000]
        }
      )
      .toBe(true)
    await page.waitForTimeout(PARENT_PICKS_UP_THE_REPORTS_MS)
    await expect(parent).not.toHaveClass(/\bst-working\b/, { timeout: 300_000 })
    await page.waitForTimeout(6000)
    await film.stop('tree')
  } finally {
    await quitAndClose(app)
  }
})

async function startDemoPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = `<!doctype html><html><head><title>Tidewatch status</title><style>
body{font:16px -apple-system,sans-serif;margin:40px;background:#f6f7f9;color:#1d2433}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px #0001;max-width:420px}
h1{font-size:22px;margin:0 0 12px}button{font:15px inherit;padding:8px 16px;border-radius:8px;border:0;background:#2f6fec;color:#fff}
#tide{font-size:40px;font-weight:700;margin:12px 0}</style></head><body><div class="card">
<h1>Tidewatch · Harbor station</h1><div>Next high tide</div><div id="tide">—</div>
<button id="refresh" onclick="document.getElementById('tide').textContent='14:32 · 2.4 m';document.title='Tidewatch · high tide 14:32'">Refresh</button>
</div></body></html>`
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((ok) => server.close(() => ok()))
  }
}

test('browser: a real claude opens a page in its own Workbench, clicks Refresh and reads it; then a terminal tab runs a command', async ({
  env
}) => {
  test.skip(!HAVE_REAL_CLAUDE, 'needs a real claude and its login')
  test.setTimeout(900_000)
  const demo = await startDemoPage()
  const { app, page } = await launchReal(env)
  try {
    await startSessionIn(page, 'tidewatch')
    const row = wsRows(page, 'tidewatch').first()
    await page.waitForTimeout(4000)
    const film = startFilm(page, 600)
    await ask(page, `open ${demo.url} in the browser and tell me when the next high tide is`)
    await expect(row).toHaveClass(/\bst-working\b/, { timeout: 30_000 })
    const webTab = page.locator('.wb-panel .wb-tab:not(.pinned)', { hasText: 'Tidewatch' })
    await expect(webTab).toBeVisible({ timeout: 300_000 })
    await webTab.click()
    await expect(row).not.toHaveClass(/\bst-working\b/, { timeout: 600_000 })
    await page.waitForTimeout(3000)
    const term = await openSessionTerminal(app, page)
    await runIn(page, term, 'ls src && git --no-pager log --oneline -3')
    await expect(panelTerm(page)).toContainText('routes', { timeout: 20_000 })
    await page.waitForTimeout(3000)
    await film.stop('browser')
  } finally {
    await quitAndClose(app)
    await demo.close()
  }
})

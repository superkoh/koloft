import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync, spawnSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from './app'
import type { E2EEnv } from './env'
import { assertFixtureDir } from './fixtureGuard'
import type { SessionWorkbenchState } from '../../../src/shared/types'

const REPO_ROOT = path.join(__dirname, '..', '..', '..')
export const SCREEN_DIR = path.join(REPO_ROOT, 'test-results', 'p1-screens')

export async function snap(page: Page, caseId: string): Promise<string> {
  fs.mkdirSync(SCREEN_DIR, { recursive: true })
  const file = path.join(SCREEN_DIR, `${caseId}.png`)
  await page.screenshot({ path: file })
  return file
}

export interface ClaudeCall {
  pid: number
  argv: string[]
  cwd: string
  effectiveCwd?: string
  sessionId: string
  firstPrompt?: string | null
  ts: number
  cdpEndpoint?: string | null
  playwrightMcpEndpoint?: string | null
  playwrightCliSession?: string | null
}

export function readCalls(env: E2EEnv): ClaudeCall[] {
  if (!fs.existsSync(env.claudeCalls)) return []
  return fs
    .readFileSync(env.claudeCalls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClaudeCall]
      } catch {
        return []
      }
    })
}

export async function waitForCalls(
  env: E2EEnv,
  count: number,
  timeout = 40_000
): Promise<ClaudeCall[]> {
  await expect.poll(() => readCalls(env).length, { timeout }).toBeGreaterThanOrEqual(count)
  return readCalls(env)
}

export function resumedId(call: ClaudeCall): string | undefined {
  const i = call.argv.indexOf('--resume')
  return i >= 0 ? call.argv[i + 1] : undefined
}

export function processAlive(pid: number): boolean {
  const res = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  if (res.status !== 0) return false
  const stat = res.stdout.trim()
  return stat.length > 0 && !stat.startsWith('Z')
}

export function killSession(pid: number, env: E2EEnv): void {
  const res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  const cmd = res.status === 0 ? res.stdout.trim() : ''
  if (!cmd) return
  // PLATFORM§3
  if (!cmd.includes(env.home)) {
    throw new Error(
      `refusing to SIGKILL pid ${pid}: it is not this test's session any more ` +
        `(recycled pid). Running instead: ${cmd.slice(0, 160)}`
    )
  }
  process.kill(pid, 'SIGKILL')
}

export function gitInit(dir: string): void {
  assertFixtureDir('gitInit', dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync(
    'git',
    [
      '-c',
      'user.email=e2e@koloft.test',
      '-c',
      'user.name=koloft-e2e',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'init'
    ],
    { cwd: dir }
  )
}

export function gitCommitAll(dir: string): void {
  assertFixtureDir('gitCommitAll', dir)
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync(
    'git',
    [
      '-c',
      'user.email=e2e@koloft.test',
      '-c',
      'user.name=koloft-e2e',
      'commit',
      '-q',
      '-m',
      'fixture'
    ],
    { cwd: dir }
  )
}

// CC§3
export function gitWorktreeAdd(repo: string, name: string): string {
  assertFixtureDir('gitWorktreeAdd', repo)
  const wt = path.join(repo, '.claude', 'worktrees', name)
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', `worktree-${name}`], { cwd: repo })
  return fs.realpathSync(wt)
}

// CC§2
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export interface SeedOptions {
  id?: string
  summary?: string
  owned?: boolean
  bare?: boolean
  cwd?: string
  worktreeState?: {
    worktreeName: string
    worktreePath: string
    originalCwd: string
    // CC§3
    worktreeBranch?: string
    originalHeadCommit?: string
  }
  timestamp?: number
  mtime?: number
  root?: string
}

function seedOwnership(env: E2EEnv, id: string): void {
  const file = path.join(env.userData, 'layout.json')
  const layout = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : { version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} }
  const sessions = (layout.sessions ?? {}) as Record<string, unknown>
  sessions[id] = { open: true, tabs: [] }
  layout.sessions = sessions
  layout.members = withMember(layout.members, id)
  fs.writeFileSync(file, JSON.stringify(layout, null, 2))
}

export function withMember(members: unknown, id: string): string[] {
  const list = Array.isArray(members) ? (members as string[]) : []
  return list.includes(id) ? list : [...list, id]
}

export function seedJsonl(env: E2EEnv, bucketDir: string, opts: SeedOptions = {}): string {
  const dir = path.join(
    opts.root ?? path.join(env.home, '.claude', 'projects'),
    encodeCwd(bucketDir)
  )
  fs.mkdirSync(dir, { recursive: true })
  const id = opts.id ?? crypto.randomUUID()
  const cwd = opts.cwd ?? bucketDir
  const ts = new Date(opts.timestamp ?? Date.now()).toISOString()
  const lines: unknown[] = []
  if (opts.worktreeState) {
    const w = opts.worktreeState
    lines.push({
      type: 'worktree-state',
      // CC§2
      worktreeSession: {
        originalCwd: w.originalCwd,
        preEnterOriginalCwd: w.originalCwd,
        worktreePath: w.worktreePath,
        worktreeName: w.worktreeName,
        worktreeBranch: w.worktreeBranch ?? `worktree-${w.worktreeName}`,
        originalBranch: 'main',
        originalHeadCommit: w.originalHeadCommit ?? '0'.repeat(40),
        sessionId: id
      }
    })
  }
  if (!opts.bare && opts.summary) {
    // CC§2
    lines.push({ type: 'ai-title', aiTitle: opts.summary })
    lines.push({ type: 'summary', summary: opts.summary })
  }
  if (opts.bare) {
    lines.push({
      type: 'assistant',
      timestamp: ts,
      cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: 'seeded turn' }] }
    })
  } else {
    lines.push({
      type: 'user',
      timestamp: ts,
      cwd,
      message: { role: 'user', content: opts.summary ?? 'seeded prompt' }
    })
  }
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (opts.mtime) fs.utimesSync(file, new Date(opts.mtime), new Date(opts.mtime))
  if (opts.owned !== false) seedOwnership(env, id)
  return id
}

export async function sendShortcut(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ch) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(ch)
  }, channel)
}

export async function clickAppMenuItem(
  app: ElectronApplication,
  page: Page,
  id: string
): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  await app.evaluate(({ Menu }, mid) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(mid)
    if (!item) throw new Error(`no application-menu item with id "${mid}"`)
    item.click()
  }, id)
}

export async function addWorkspace(
  page: Page,
  dir: string
): Promise<{ code: string; path?: string }> {
  return page.evaluate(
    (p) => window.api.workspace.add(p) as Promise<{ code: string; path?: string }>,
    dir
  )
}

export async function workspaceNames(page: Page): Promise<string[]> {
  return page.locator('.ws-head .ws-name').allTextContents()
}

export interface LayoutOnDisk {
  version?: number
  workspaces?: { path: string }[]
  workbench?: { defaultOpen: boolean }
  members?: string[]
  sessions?: Record<string, SessionWorkbenchState>
  globalTerminal?: { visible: boolean; tabs: { title: string; cwd: string }[] }
  [key: string]: unknown
}

export function layoutOnDisk(env: E2EEnv): LayoutOnDisk {
  return JSON.parse(fs.readFileSync(path.join(env.userData, 'layout.json'), 'utf8')) as LayoutOnDisk
}

export function settingsOnDisk(env: E2EEnv): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(env.userData, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

export function notesIsland(page: Page): Locator {
  return page.locator('.isl-notes')
}

export function notesPath(env: E2EEnv, wsPath: string): string {
  return path.join(env.userData, 'notes', encodeCwd(wsPath), 'notes.md')
}

export function notesOnDisk(env: E2EEnv, wsPath: string): string | null {
  const file = notesPath(env, wsPath)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

export function seedGlobalTerm(
  env: E2EEnv,
  state: { visible: boolean; tabs: { title: string; cwd: string }[] }
): void {
  const file = path.join(env.userData, 'layout.json')
  const layout = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : { version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} }
  layout.globalTerminal = state
  fs.writeFileSync(file, JSON.stringify(layout, null, 2))
}

export const FAKE_SESSION_TITLE = 'Fake session: project notes'

export function setNextSessionTitle(env: E2EEnv, title: string): void {
  fs.writeFileSync(path.join(env.home, 'fake-claude-next-title'), title)
}

export function wsGroup(page: Page, wsName: string): Locator {
  return page.locator('.ws').filter({ has: page.locator('.ws-head', { hasText: wsName }) })
}

export function wsRows(page: Page, wsName: string): Locator {
  return wsGroup(page, wsName).locator('.ws-tab')
}

export function auxIcon(page: Page, which: 'Preview' | 'Workbench' | 'Terminal'): Locator {
  return page.locator(`.aux-ico[aria-label="${which}"]`)
}

export function pickerDialog(page: Page): Locator {
  return page.locator('.modal.wspicker')
}

export function worktreeDialog(page: Page): Locator {
  return page.locator('.modal.worktreesess')
}

export function dialogPrimary(dlg: Locator): Locator {
  return dlg.locator('.modal-foot .btn-primary')
}

export async function chooseBackend(page: Page, which: 'default' | 'other'): Promise<void> {
  const dialog = page.locator('.modal.wspicker, .modal.worktreesess')
  const start = dialog.locator(
    which === 'default'
      ? '.modal-foot button[data-default="true"]'
      : '.modal-foot button[data-default="false"]'
  )
  await expect(start).toBeEnabled()
  await start.click()
  await expect(dialog).toHaveCount(0)
}

export async function newSessionInWith(
  page: Page,
  wsName: string,
  method: 'Claude' | 'Codex'
): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: `New ${method} session` }).click()
}

export async function openPicker(app: ElectronApplication, page: Page): Promise<Locator> {
  await clickAppMenuItem(app, page, 'new-session')
  const dlg = pickerDialog(page)
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

export async function openWorktreeSession(page: Page, wsName: string): Promise<Locator> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'New worktree session' }).click()
  const dlg = worktreeDialog(page)
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

export async function startSessionIn(
  page: Page,
  wsName: string,
  opts: { remote?: boolean; method?: 'Claude' | 'Codex' } = {}
): Promise<void> {
  const rows = wsRows(page, wsName)
  const before = await rows.count()
  const titledBefore = await rows.filter({ hasText: FAKE_SESSION_TITLE }).count()
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page
    .locator('.menu .mi', { hasText: opts.method ? `New ${opts.method} session` : 'New session' })
    .click()
  await expect(rows).toHaveCount(before + 1, { timeout: 30_000 })
  await expect(page.locator('.modal')).toHaveCount(0)
  await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })
  if (opts.remote) {
    await expect(rows.filter({ hasText: FAKE_SESSION_TITLE })).toHaveCount(titledBefore + 1, {
      timeout: 60_000
    })
    return
  }
  await expect(page.locator(SESSION_BOUND_ICON)).toHaveAttribute('aria-disabled', 'false', {
    timeout: 30_000
  })
}

const SESSION_BOUND_ICON = '.aux-ico[aria-label="Workbench"]'

export function focusOwner(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return 'none'
    if (el.closest('.w-empty')) return 'welcome'
    if (el.closest('.term-island')) return 'tui'
    if (el.closest('.wb-col')) return 'panel'
    return el.tagName.toLowerCase()
  })
}

export function centerTerm(page: Page): Locator {
  return page.locator('.term-island .term-wrap:visible .xterm')
}

export async function runIn(page: Page, term: Locator, cmd: string): Promise<void> {
  await term.click()
  await page.keyboard.type(cmd)
  await page.keyboard.press('Enter')
}

export async function waitBooted(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  await page.waitForFunction(
    () => (window as unknown as { __koloftRowsReady?: boolean }).__koloftRowsReady === true,
    undefined,
    { timeout: 20_000 }
  )
}

export function termIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(
      (window as unknown as { __koloftTerms?: Record<string, unknown> }).__koloftTerms ?? {}
    )
  )
}

const SHELL_READY_ONCE_QUIET_FOR_MS = 700

export async function openSessionTerminal(app: ElectronApplication, page: Page): Promise<Locator> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  const hasItem = await app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab') != null
  )
  if (!hasItem) throw new Error('no application-menu item with id "new-terminal-tab"')
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab')?.enabled
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
  const before = await page.locator('.wb-panel .wb-term').count()
  await sendShortcut(app, 'shortcut:new-terminal-tab')
  await expect(page.locator('.wb-panel .wb-term')).toHaveCount(before + 1, { timeout: 40_000 })
  await expect(panelTerm(page)).toBeVisible({ timeout: 40_000 })

  // PLATFORM§21
  const term = panelTerm(page)
  const ptyId = await page.locator('.wb-panel .wb-term:visible').getAttribute('data-pty')
  if (!ptyId) throw new Error('the visible terminal tab carries no data-pty')

  let last = ''
  let stableSince = 0
  await expect
    .poll(
      async () => {
        const now = (
          await page.evaluate((id) => {
            const t = (
              window as unknown as {
                __koloftTerms?: Record<
                  string,
                  {
                    buffer: {
                      active: {
                        length: number
                        getLine(
                          i: number
                        ): { translateToString(trim?: boolean): string } | undefined
                      }
                    }
                  }
                >
              }
            ).__koloftTerms?.[id]
            if (!t) return ''
            const b = t.buffer.active
            const out: string[] = []
            for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
            return out.join('\n')
          }, ptyId)
        ).trim()
        if (now !== last || now === '') {
          last = now
          stableSince = Date.now()
          return false
        }
        if (stableSince === 0) stableSince = Date.now()
        return Date.now() - stableSince >= SHELL_READY_ONCE_QUIET_FOR_MS
      },
      { intervals: [200], timeout: 40_000 }
    )
    .toBe(true)
  return term
}

export function panelTerm(page: Page): Locator {
  return page.locator('.wb-panel .wb-term:visible .xterm')
}

export async function panelShellPid(page: Page, marker: string): Promise<number> {
  await runIn(page, panelTerm(page), `echo ${marker}_$$`)
  let pid = 0
  await expect
    .poll(
      async () => {
        const text = await panelTerm(page).innerText()
        const m = text.match(new RegExp(`${marker}_(\\d+)`))
        pid = m ? Number(m[1]) : 0
        return pid
      },
      { timeout: 25_000 }
    )
    .toBeGreaterThan(0)
  return pid
}

export function litIsland(page: Page): Promise<'tui' | 'panel' | 'both' | 'none'> {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.borderTopColor = 'var(--accent-line)'
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const accentAsComputedBorder = getComputedStyle(probe).borderTopColor.replace(/\s+/g, '')
    probe.remove()

    // PLATFORM§24
    const lit = (sel: string): boolean => {
      const el = document.querySelector(sel) as HTMLElement | null
      return (
        !!el && getComputedStyle(el).borderTopColor.replace(/\s+/g, '') === accentAsComputedBorder
      )
    }
    const tui = lit('.island.term-island')
    const panel = lit('.island.wb-col:not(.off)')
    if (tui && panel) return 'both' as const
    if (tui) return 'tui' as const
    if (panel) return 'panel' as const
    return 'none' as const
  })
}

export function islandBorderColors(
  page: Page
): Promise<{ tui: string; panel: string; accent: string }> {
  return page.evaluate(() => {
    const flat = (c: string): string => c.replace(/\s+/g, '')
    const colorOf = (sel: string): string => {
      const el = document.querySelector(sel) as HTMLElement | null
      return el ? flat(getComputedStyle(el).borderTopColor) : ''
    }
    return {
      tui: colorOf('.island.term-island'),
      panel: colorOf('.island.wb-col:not(.off)'),
      // PLATFORM§24
      accent: (() => {
        const probe = document.createElement('div')
        probe.style.borderTopColor = 'var(--accent-line)'
        probe.style.display = 'none'
        document.body.appendChild(probe)
        const v = flat(getComputedStyle(probe).borderTopColor)
        probe.remove()
        return v
      })()
    }
  })
}

export async function openMenu(page: Page, target: Locator): Promise<Locator> {
  await target.click({ button: 'right' })
  const menu = page.locator('.menu')
  await expect(menu).toBeVisible()
  return menu
}

export async function menuItemTexts(page: Page): Promise<string[]> {
  const texts = await page.locator('.menu .mi:not(.head)').allTextContents()
  return texts.map((t) => t.replace(/\s+/g, ' ').trim())
}

export async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.menu')).toHaveCount(0)
}

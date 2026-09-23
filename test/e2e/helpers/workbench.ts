import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { expect } from './app'
import type { E2EEnv } from './env'
import { encodeCwd, layoutOnDisk } from './p1'
import { assertFixtureDir } from './fixtureGuard'
import { PNG_1X1 } from './filesFixture'
import type { LayoutV2, PersistedTab, SessionWorkbenchState } from '../../../src/shared/types'

export const WORKBENCH = {
  column: '.wb-col',
  panel: '.wb-panel',
  tabStrip: '.wb-tabs',
  dragHandle: '.wb-tabs .wb-drag',
  tab: '.wb-tab',
  tabLabel: '.lb',
  tabActive: '.wb-tab.on',
  tabFiles: '.wb-tab.pinned',
  tabUnread: '.wb-tab.agent',
  tabFrozen: '.wb-tab.frozen',
  tabClose: '.wb-tab .x',
  tabCloseIn: '.x',
  newTab: '.wb-new',
  newMenu: '.wb-newmenu',
  newMenuItem: '.wb-newmenu .mi',
  titlebarIcon: '.aux-ico[aria-label="Workbench"]',

  kindBar: '.wb-panel .wb-bar',
  artifactTitle: '.wb-panel .wb-bar .wb-title',
  viewSeg: '.wb-panel .wb-bar .seg[aria-label="View mode"]',
  viewSegOn: '.wb-panel .wb-bar .seg[aria-label="View mode"] .on',
  reload: '.wb-panel .wb-bar .icobtn[aria-label="Reload"]',
  outline: '.wb-panel .wb-bar .icobtn[aria-label="Outline"]',
  fullWidth: '.wb-panel .wb-bar .icobtn[aria-label^="Full width"]',
  restoreWidth: '.wb-panel .wb-bar .icobtn[aria-label^="Restore"]',
  artifact: '.wb-artifact',
  findBar: '.wb-panel .find-bar',
  stateButton: '.wb-state-btn',

  readingTitle: '.wb-panel .fv-artifact-hd .wb-title',
  readingBody: '.wb-panel .fv-read .wb-artifact'
} as const

export async function waitPanelAttached(page: Page, timeout = 60_000): Promise<void> {
  await expect(workbenchIcon(page)).toHaveAttribute('aria-disabled', 'false', { timeout })
}

export async function layoutState(page: Page): Promise<'T1' | 'T2' | 'T3'> {
  return page.evaluate(() => {
    const panel = document.querySelector('.wb-panel') as HTMLElement | null
    if (!panel || getComputedStyle(panel).visibility === 'hidden' || panel.offsetWidth === 0) {
      return 'T1' as const
    }
    const tui = document.querySelector('.term-island') as HTMLElement | null
    return tui && tui.offsetWidth > 0 ? ('T2' as const) : ('T3' as const)
  })
}

export function artifactBody(page: Page): Locator {
  return page.locator(`${WORKBENCH.artifact}:visible`)
}

export async function activeKind(page: Page): Promise<string | null> {
  return page.locator(WORKBENCH.panel).first().getAttribute('data-kind')
}

export async function openFileTab(page: Page, env: E2EEnv, absPath: string): Promise<void> {
  answerFileDialog(env, absPath)
  await page.locator(WORKBENCH.panel).click({ position: { x: 5, y: 5 } })
  await page.locator(WORKBENCH.newTab).click()
  await page.locator(WORKBENCH.newMenuItem, { hasText: 'Open file…' }).click()
  await expect.poll(() => pendingFileDialogAnswers(env)).toEqual([])
  await expect.poll(() => activeKind(page)).not.toBe('files')
}

export function workbenchPanel(page: Page): Locator {
  return page.locator(WORKBENCH.panel)
}

export function appRegion(page: Page, sel: string): Promise<string> {
  return page
    .locator(sel)
    .first()
    .evaluate((el) => getComputedStyle(el).getPropertyValue('app-region').trim())
}

export function workbenchIcon(page: Page): Locator {
  return page.locator(WORKBENCH.titlebarIcon)
}

export function wbTabs(page: Page): Locator {
  return page.locator(WORKBENCH.tab)
}

export function wbActiveTab(page: Page): Locator {
  return page.locator(WORKBENCH.tabActive)
}

export function wbUnreadTabs(page: Page): Locator {
  return page.locator(WORKBENCH.tabUnread)
}

export function wbFrozenTabs(page: Page): Locator {
  return page.locator(WORKBENCH.tabFrozen)
}

export function wbTabByTitle(page: Page, text: string | RegExp): Locator {
  return page.locator(WORKBENCH.tab).filter({ hasText: text })
}

export async function wbTabTitles(page: Page): Promise<string[]> {
  const texts = await page.locator(`${WORKBENCH.tab} ${WORKBENCH.tabLabel}`).allTextContents()
  return texts.map((t) => t.replace(/\s+/g, ' ').trim())
}

export function sessionWorkbenchOnDisk(
  env: E2EEnv,
  sessionId: string
): SessionWorkbenchState | null {
  return layoutOnDisk(env).sessions?.[sessionId] ?? null
}

export function persistedTabsOnDisk(env: E2EEnv, sessionId: string): PersistedTab[] {
  return sessionWorkbenchOnDisk(env, sessionId)?.tabs ?? []
}

export function workbenchDefaultOnDisk(env: E2EEnv): boolean | null {
  return layoutOnDisk(env).workbench?.defaultOpen ?? null
}

function patchLayout(env: E2EEnv, patch: (doc: Record<string, unknown>) => void): void {
  const file = path.join(env.userData, 'layout.json')
  const doc = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : { version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} }
  patch(doc)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
}

export function seedWorkbench(
  env: E2EEnv,
  sessionId: string,
  state: SessionWorkbenchState | Record<string, unknown>
): void {
  patchLayout(env, (doc) => {
    const sessions = (doc.sessions ?? {}) as Record<string, unknown>
    sessions[sessionId] = state
    doc.sessions = sessions
  })
}

export function seedWorkbenchDefault(env: E2EEnv, defaultOpen: boolean): void {
  patchLayout(env, (doc) => {
    doc.workbench = { defaultOpen }
  })
}

export function writeLegacyV2Layout(env: E2EEnv, doc: LayoutV2): void {
  fs.writeFileSync(path.join(env.userData, 'layout.json'), JSON.stringify(doc, null, 2))
}

export interface ScratchpadFixture {
  dir: string
  md: string
  png: string
  ts: string
  tasksDir: string
  tasksFile: string
  siblingTasksDir: string
  siblingTasksFile: string
  remove(): void
}

export function seedScratchpad(
  env: E2EEnv,
  bucketDir: string,
  sessionId: string
): ScratchpadFixture {
  const sessionDir = path.join(env.scratchpadBase, encodeCwd(bucketDir), sessionId)
  const dir = path.join(sessionDir, 'scratchpad')
  const siblingTasksDir = path.join(sessionDir, 'tasks')
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
  fs.mkdirSync(siblingTasksDir, { recursive: true })
  assertFixtureDir('seedScratchpad', dir)
  const put = (base: string, rel: string, body: string | Buffer): string => {
    const abs = path.join(base, rel)
    fs.writeFileSync(abs, body)
    return abs
  }
  return {
    dir,
    md: put(dir, 'notes.md', '# Scratch notes\n\nkoloft-e2e-scratch-md\n'),
    png: put(dir, 'shot.png', Buffer.from(PNG_1X1, 'base64')),
    ts: put(dir, 'helper.ts', 'export const scratchHelper = 1\n'),
    tasksDir: path.join(dir, 'tasks'),
    tasksFile: put(dir, 'tasks/plan.md', '# plan\n\nkoloft-e2e-scratch-task\n'),
    siblingTasksDir,
    siblingTasksFile: put(
      siblingTasksDir,
      'subagent.md',
      '# subagent\n\nkoloft-e2e-tasks-transcript\n'
    ),
    remove: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function answerFileDialog(env: E2EEnv, ...paths: string[]): void {
  fs.writeFileSync(env.fileDialogFile, paths.length ? paths.join('\n') + '\n' : '')
}

export function cancelFileDialog(env: E2EEnv): void {
  fs.rmSync(env.fileDialogFile, { force: true })
}

export function pendingFileDialogAnswers(env: E2EEnv): string[] {
  if (!fs.existsSync(env.fileDialogFile)) return []
  return fs.readFileSync(env.fileDialogFile, 'utf8').split('\n').filter(Boolean)
}

export {
  installGitSpawnLog,
  installStallingGit,
  gitSpawns,
  countGitSpawns,
  parseGitSpawns,
  filterGitSpawns,
  isAggregateDiff,
  WORKBENCH_GIT,
  waitGitQuiet
} from './gitSpawnLog'
export type { GitSpawn, GitSpawnFilter } from './gitSpawnLog'

export { setGuestLimit } from './env'

export async function showBrowse(page: Page): Promise<void> {
  await waitPanelAttached(page)
  const panel = page.locator(WORKBENCH.panel)
  if (!(await panel.isVisible())) {
    await workbenchIcon(page).click()
    await expect(panel).toBeVisible({ timeout: 20_000 })
  }
  const pinned = page.locator(WORKBENCH.tabFiles)
  if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()
  const browse = page
    .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
    .filter({ hasText: 'Browse' })
  await expect(browse).toBeVisible({ timeout: 20_000 })
  if ((await browse.getAttribute('aria-pressed')) !== 'true') await browse.click()
  await expect(page.locator(`${WORKBENCH.panel} .fv`)).toHaveAttribute('data-view', 'browse', {
    timeout: 20_000
  })
}

export async function openInBrowse(page: Page, absPath: string): Promise<void> {
  await showBrowse(page)
  const panel = page.locator(WORKBENCH.panel)
  const rootRow = panel.locator('.ft-node.ft-root')
  await expect(rootRow).toBeVisible({ timeout: 30_000 })
  const root = (await rootRow.getAttribute('data-path')) ?? ''
  if (absPath.startsWith(root + '/')) {
    const segs = absPath.slice(root.length + 1).split('/')
    let dir = root
    for (const seg of segs.slice(0, -1)) {
      dir += '/' + seg
      const row = panel.locator(`.ft-node.ft-dir[data-path="${dir}"]`)
      await expect(row).toBeVisible({ timeout: 30_000 })
      if (!(await row.getAttribute('class'))?.split(/\s+/).includes('open')) await row.click()
      await expect(row).toHaveClass(/\bopen\b/, { timeout: 20_000 })
    }
  }
  await panel.locator(`.ft-node.ft-file[data-path="${absPath}"]`).click({ timeout: 30_000 })
}

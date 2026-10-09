import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { expect } from './app'
import type { E2EEnv, FakeGhCheck } from './env'
import { encodeCwd, layoutOnDisk, withMember } from './p1'
import { assertFixtureDir } from './fixtureGuard'
import { PNG_1X1 } from './filesFixture'
import type { LayoutV2, PersistedTab, SessionWorkbenchState } from '../../../src/shared/types'

export const WORKBENCH = {
  column: '.wb-col',
  panel: '.wb-panel',
  tabStrip: '.wb-panel .wb-tabs',
  dragHandle: '.wb-panel .wb-tabs .wb-drag',
  tab: '.wb-panel .wb-tab',
  tabLabel: '.lb',
  tabActive: '.wb-panel .wb-tab.on',
  tabFiles: '.wb-panel .wb-tab.pinned',
  tabUnread: '.wb-panel .wb-tab.agent',
  tabFrozen: '.wb-panel .wb-tab.frozen',
  tabClose: '.wb-panel .wb-tab .x',
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
  readingBody: '.wb-panel .fv-read .wb-artifact',

  browseSection: '.wb-panel .bv-sec',
  browseRows: '.wb-panel .bv-body .ft-node',

  rowMenu: '.ft-ctx[role="menu"]',
  rowMenuItem: '.ft-ctx .ft-ctx-it',

  previewCard: '.wb-peek',
  previewDiff: '.wb-peek .wb-tab.pinned',
  previewDiffLabel: '.wb-peek .wb-tab.pinned .lb',
  previewDocs: '.wb-peek .ft-node'
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

export function browseSection(page: Page, name: string): Locator {
  return page.locator(`${WORKBENCH.browseSection}[data-section="${name}"]`)
}

export function browseRow(page: Page, absPath: string, section = 'tree'): Locator {
  return browseSection(page, section).locator(`.ft-node[data-path="${absPath}"]`)
}

export function rowMenu(page: Page): Locator {
  return page.locator(WORKBENCH.rowMenu)
}

export function rowMenuItems(page: Page): Locator {
  return page.locator(WORKBENCH.rowMenuItem)
}

export function sessionWorkbenchOnDisk(
  env: E2EEnv,
  sessionId: string
): SessionWorkbenchState | null {
  return layoutOnDisk(env).panels?.[sessionId] ?? null
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
    : { version: 6, workspaces: [], workbench: { defaultOpen: true }, members: [], panels: {} }
  patch(doc)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
}

export function seedWorkbench(
  env: E2EEnv,
  sessionId: string,
  state: SessionWorkbenchState | Record<string, unknown>
): void {
  patchLayout(env, (doc) => {
    const panels = (doc.panels ?? {}) as Record<string, unknown>
    panels[sessionId] = state
    doc.panels = panels
    doc.members = withMember(doc.members, sessionId)
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
  const rootRow = page.locator(`${WORKBENCH.browseRows}.ft-root`)
  await expect(rootRow).toBeVisible({ timeout: 30_000 })
  const root = (await rootRow.getAttribute('data-path')) ?? ''
  if (absPath.startsWith(root + '/')) {
    const segs = absPath.slice(root.length + 1).split('/')
    let dir = root
    for (const seg of segs.slice(0, -1)) {
      dir += '/' + seg
      const row = browseRow(page, dir)
      await expect(row).toBeVisible({ timeout: 30_000 })
      if (!(await row.getAttribute('class'))?.split(/\s+/).includes('open')) await row.click()
      await expect(row).toHaveClass(/\bopen\b/, { timeout: 20_000 })
    }
  }
  await page
    .locator(`${WORKBENCH.browseRows}.ft-file[data-path="${absPath}"]`)
    .click({ timeout: 30_000 })
}

const TYPED_AFTER_THE_PASTE = ' and typed after the paste'

export async function putCommentOnFirstHunkInSession(
  page: Page,
  rel: string,
  note: string
): Promise<string> {
  const block = page.locator(`${WORKBENCH.panel} .cv-blk[data-path="${rel}"]`)
  const button = block.locator('.cv-cmt').first()
  await expect(button).toBeEnabled({ timeout: 60_000 })
  const header = (await block.locator('.cv-hunk-hd').first().textContent()) ?? ''
  await button.click()
  const box = block.locator('.cv-comment textarea')
  await box.fill(note)
  await box.press('Enter')
  await expect(block.locator('.cv-comment')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('.term-island')))
    .toBe(true)
  return `${rel}\n\`\`\`diff\n${header}\n`
}

export async function commentOnFirstHunk(page: Page, rel: string, note: string): Promise<string> {
  const head = await putCommentOnFirstHunkInSession(page, rel, note)
  await page.keyboard.type(TYPED_AFTER_THE_PASTE)
  await page.keyboard.press('Enter')
  return head
}

export async function expectOnePromptFromTheComment(
  prompts: () => string[],
  head: string,
  note: string
): Promise<void> {
  const fromNote = (): string[] => prompts().filter((p) => p.includes(note))
  await expect.poll(fromNote, { timeout: 30_000 }).toHaveLength(1)
  const [prompt] = fromNote()
  expect(prompt.startsWith(head)).toBe(true)
  expect(prompt.endsWith('\n```\n\n' + note + TYPED_AFTER_THE_PASTE)).toBe(true)
}

// CC§18
export function outsideThePaste(prompt: string): string {
  return prompt.replace(/<pasted_content id="([^"]+)">[\s\S]*?<\/pasted_content id="\1">/g, '')
}

export function claudePromptsIn(jsonl: string): string[] {
  return jsonl.split('\n').flatMap((line) => {
    try {
      const record = JSON.parse(line)
      const content = record.type === 'user' ? record.message?.content : undefined
      return typeof content === 'string' ? [content] : []
    } catch {
      return []
    }
  })
}

export function claudeRepliesIn(jsonl: string): string[] {
  return jsonl.split('\n').flatMap((line) => {
    try {
      const record = JSON.parse(line)
      const content = record.type === 'assistant' ? record.message?.content : undefined
      return Array.isArray(content)
        ? content.flatMap((part: { type?: string; text?: unknown }) =>
            part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
          )
        : []
    } catch {
      return []
    }
  })
}

export function claudeToolResultsIn(jsonl: string): string[] {
  return jsonl.split('\n').flatMap((line) => {
    try {
      const record = JSON.parse(line)
      const content = record.type === 'user' ? record.message?.content : undefined
      return Array.isArray(content)
        ? content.flatMap((part: { type?: string; content?: unknown }) => {
            if (part?.type !== 'tool_result') return []
            if (typeof part.content === 'string') return [part.content]
            return Array.isArray(part.content)
              ? [
                  part.content
                    .map((c: { text?: unknown }) => (typeof c?.text === 'string' ? c.text : ''))
                    .join('')
                ]
              : []
          })
        : []
    } catch {
      return []
    }
  })
}

export const ONE_FAILING_OF_FIVE: FakeGhCheck[] = [
  {
    name: 'check',
    bucket: 'fail',
    link: 'https://github.com/acme/widgets/actions/runs/36829650571/job/110263090912',
    workflow: 'CI'
  },
  ...['lint', 'build', 'docs', 'e2e'].map((name): FakeGhCheck => ({
    name,
    bucket: 'pass',
    link: 'https://github.com/acme/widgets/actions/runs/36829650571/job/1',
    workflow: 'CI'
  }))
]

export const FAILED_LOG =
  'check\tRun npm test\t2026-10-07T13:25:40.0000000Z AssertionError: expected 1 to be 2\n' +
  'check\tRun npm test\t2026-10-07T13:25:40.1000000Z ##[error]Process completed with exit code 1.\n'

export const FAILING_CHECK_PASTE_HEAD =
  'CI check "check" (workflow CI) failed on pull request #265 of acme/widgets.\n' +
  'Full log: https://github.com/acme/widgets/actions/runs/36829650571/job/110263090912\n\n' +
  '--- log excerpt (around the first error) ---\n' +
  'AssertionError: expected 1 to be 2\n' +
  '##[error]Process completed with exit code 1.'

export const PR_3_OF_KOLOFT = {
  owner: 'superkoh',
  repo: 'koloft',
  branch: 'dependabot/npm_and_yarn/vitejs/plugin-react-6.1.1',
  pr: 3
}

export const PR_3_CHECKS_LINE = 'Checks · 1 failing of 2'

export const PR_3_FAILING_CHECK_PASTE_HEAD =
  'CI check "check" (workflow CI) failed on pull request #3 of superkoh/koloft.\n' +
  'Full log: https://github.com/superkoh/koloft/actions/runs/35815732286/job/107036731098\n\n' +
  '--- log excerpt (around the first error) ---\n' +
  '##[group]Run npm ci\n' +
  'npm ci\n'

export const PR_3_NPM_ERROR = 'npm error code ERESOLVE'
export const PR_3_FIRST_ERROR_LINE = '##[error]Process completed with exit code 1.'

export async function sendFailingChecks(page: Page): Promise<void> {
  await page.locator('.wb-gh').click({ button: 'right' })
  await page.locator('.wb-ghmenu .mi', { hasText: 'Send failing checks' }).click()
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('.term-island')))
    .toBe(true)
  await page.keyboard.type(TYPED_AFTER_THE_PASTE)
  await page.keyboard.press('Enter')
}

export async function expectOnePromptFromTheChecks(
  prompts: () => string[],
  head = FAILING_CHECK_PASTE_HEAD
): Promise<string> {
  const fromChecks = (): string[] => prompts().filter((p) => p.startsWith(head))
  await expect.poll(fromChecks, { timeout: 30_000 }).toHaveLength(1)
  const [prompt] = fromChecks()
  expect(prompt.endsWith('\n\n' + TYPED_AFTER_THE_PASTE)).toBe(true)
  return prompt
}

export function claudePrompts(transcript: string): string[] {
  return fs.existsSync(transcript) ? claudePromptsIn(fs.readFileSync(transcript, 'utf8')) : []
}

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, launchApp } from './app'
import type { E2EEnv } from './env'
import { assertFixtureDir } from './fixtureGuard'
import { setupGitFixture, type GitFixture } from './gitFixture'
import { gitInit, gitWorktreeAdd, sendShortcut, wsRows } from './p1'

const GIT_ID = ['-c', 'user.email=e2e@koloft.test', '-c', 'user.name=koloft-e2e']

function git(cwd: string, ...args: string[]): string {
  assertFixtureDir('git', cwd)
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' })
}

export type WorkspaceKind = 'git' | 'cloned' | 'plain' | 'missing'

export interface WorkspaceSpec {
  name: string
  kind: WorkspaceKind
}

export interface PinnedWorkspaces {
  names: string[]
  paths: Record<string, string>
  git: Record<string, GitFixture>
}

export function pinnedCount(env: E2EEnv): number {
  const file = path.join(env.userData, 'layout.json')
  if (!fs.existsSync(file)) return 0
  const layout = JSON.parse(fs.readFileSync(file, 'utf8')) as { workspaces?: unknown[] }
  return layout.workspaces?.length ?? 0
}

export function pinWorkspaces(env: E2EEnv, specs: WorkspaceSpec[]): PinnedWorkspaces {
  const paths: Record<string, string> = {}
  const fixtures: Record<string, GitFixture> = {}

  for (const spec of specs) {
    if (spec.kind === 'cloned') {
      const fx = setupGitFixture(env, spec.name)
      fixtures[spec.name] = fx
      paths[spec.name] = fx.clone
      continue
    }
    const dir = path.join(env.home, spec.name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${spec.name}\n`)
    const real = fs.realpathSync(dir)
    if (spec.kind === 'git') {
      gitInit(real)
      git(real, 'add', '-A')
      git(real, 'commit', '-q', '-m', 'readme')
    }
    paths[spec.name] = real
  }

  const file = path.join(env.userData, 'layout.json')
  const layout = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : { version: 4, workbench: { defaultOpen: true }, sessions: {} }
  layout.version = 4
  layout.workbench ??= { defaultOpen: true }
  layout.sessions ??= {}
  layout.workspaces = specs.map((s) => ({ path: paths[s.name] }))
  fs.writeFileSync(file, JSON.stringify(layout, null, 2))

  for (const spec of specs) {
    if (spec.kind === 'missing') {
      fs.rmSync(paths[spec.name], { recursive: true, force: true })
    }
  }

  return { names: specs.map((s) => s.name), paths, git: fixtures }
}

export function makeDirty(dir: string): void {
  fs.writeFileSync(path.join(dir, 'README.md'), `# locally edited\n`)
}

export { gitWorktreeAdd }

export const BADGE_TIMEOUT = 40_000

export async function waitSettled(page: Page, workspaceCount: number): Promise<void> {
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
  if (workspaceCount === 0) {
    await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
  } else {
    await expect(page.locator('.ws-head')).toHaveCount(workspaceCount, { timeout: 20_000 })
  }
}

export async function launchSettled(
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitSettled(page, pinnedCount(env))
  return { app, page }
}

export function behindBadge(page: Page, wsName: string): Locator {
  return page.locator('.ws-head', { hasText: wsName }).locator('.ws-behind')
}

export async function waitForBehindBadge(
  page: Page,
  wsName: string,
  behind: number,
  timeout = BADGE_TIMEOUT
): Promise<void> {
  await expect(behindBadge(page, wsName)).toHaveText(`${behind}`, { timeout })
}

function exactText(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
}

export function rowsWithSub(page: Page, wsName: string, sub: string): Locator {
  return wsRows(page, wsName).filter({
    has: page.locator('.ws-tab-sub', { hasText: exactText(sub) })
  })
}

export async function waitForSessionRow(
  page: Page,
  wsName: string,
  sub: string,
  timeout = 60_000
): Promise<Locator> {
  const row = rowsWithSub(page, wsName, sub).first()
  await expect(row).toBeVisible({ timeout })
  return row
}

export async function waitForPendingRow(
  page: Page,
  wsName: string,
  sub: string,
  timeout = 30_000
): Promise<Locator> {
  const row = rowsWithSub(page, wsName, sub).and(page.locator('.ws-tab.st-pending')).first()
  await expect(row).toBeVisible({ timeout })
  return row
}

export const NEW_SESSION_CHANNEL = 'shortcut:new-session'
export const NEW_WORKTREE_SESSION_CHANNEL = 'shortcut:new-worktree-session'

export async function pressShortcut(
  app: ElectronApplication,
  page: Page,
  channel: string
): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  await sendShortcut(app, channel)
}

export async function pressNewSession(app: ElectronApplication, page: Page): Promise<void> {
  await pressShortcut(app, page, NEW_SESSION_CHANNEL)
}

export async function pressNewWorktreeSession(app: ElectronApplication, page: Page): Promise<void> {
  await pressShortcut(app, page, NEW_WORKTREE_SESSION_CHANNEL)
}

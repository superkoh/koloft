import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, launchApp } from './app'
import type { E2EEnv } from './env'
import { assertFixtureDir } from './fixtureGuard'
import { setupGitFixture, type GitFixture } from './gitFixture'
import { gitInit, gitWorktreeAdd, sendShortcut, wsRows } from './p1'

/**
 * Shared fixtures for the black-box suite of the new-session entrances
 *. Every case starts from "these N workspaces, of these kinds, pinned in this
 * order" and then observes the product's own UI, so this module only composes what
 * already exists: env.ts's isolated $HOME, gitFixture.ts's origin/clone pair, p1.ts's
 * worktree/shortcut/sidebar seams.
 *
 * Nothing here knows about the feature under test — the three dialogs are located by
 * their user-visible text inside the specs, never by a selector invented here.
 */

/** No identity is inherited (the E2E $HOME has no gitconfig) — pinned per invocation,
 *  the same way gitFixture.ts does it. */
const GIT_ID = ['-c', 'user.email=e2e@koloft.test', '-c', 'user.name=koloft-e2e']

function git(cwd: string, ...args: string[]): string {
  assertFixtureDir('git', cwd)
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' })
}

/**
 * What a pinned workspace IS, from a case's point of view:
 *  - `git`     a plain repo with one commit and no remote (nothing to be behind of)
 *  - `cloned`  a repo cloned from a local bare origin, so the origin can be advanced
 *              and fetched (the behind-and-pullable states) — a full GitFixture
 *  - `plain`   a folder that is not a repo (the "no git" rows)
 *  - `missing` a folder that is pinned and then deleted before launch
 */
export type WorkspaceKind = 'git' | 'cloned' | 'plain' | 'missing'

export interface WorkspaceSpec {
  /** the folder name — also the name its sidebar row renders */
  name: string
  kind: WorkspaceKind
}

export interface PinnedWorkspaces {
  /** the names in pinned order (the order the sidebar and the pickers render) */
  names: string[]
  /** realpath'd folder per name; a `missing` one is the path that no longer exists */
  paths: Record<string, string>
  /** the origin/clone machinery of every `cloned` workspace, keyed by name */
  git: Record<string, GitFixture>
}

/** The pins as they currently sit in layout.json (`missing` ones included — they still
 *  render a row). */
export function pinnedCount(env: E2EEnv): number {
  const file = path.join(env.userData, 'layout.json')
  if (!fs.existsSync(file)) return 0
  const layout = JSON.parse(fs.readFileSync(file, 'utf8')) as { workspaces?: unknown[] }
  return layout.workspaces?.length ?? 0
}

/**
 * Build N workspaces of mixed kinds and pin them in the given order, replacing the two
 * default fixture pins. Must run BEFORE launchApp — main reads layout.json once, and
 * the startup scan is what turns repo state into badges. Only `workspaces` is rewritten,
 * so a seed written earlier (sessions, and the legacy island block T-WT-12 plants)
 * survives.
 */
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
    // a TRACKED file every kind carries, so makeDirty() has something to modify
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
  // stamping the version onto a document that has no `workbench` block would make
  // the v4 guard reject it, and an unrecognized document degrades to the EMPTY layout —
  // i.e. the pins this function exists to write would be wiped on the very next boot
  // (the NFR-06 trap layoutMigrate.ts documents). Fill the block rather than assume it.
  layout.workbench ??= { defaultOpen: true }
  layout.sessions ??= {}
  layout.workspaces = specs.map((s) => ({ path: paths[s.name] }))
  fs.writeFileSync(file, JSON.stringify(layout, null, 2))

  // deleted only after the pin is on disk: the app then meets the folder as gone from
  // its very first scan
  for (const spec of specs) {
    if (spec.kind === 'missing') {
      fs.rmSync(paths[spec.name], { recursive: true, force: true })
    }
  }

  return { names: specs.map((s) => s.name), paths, git: fixtures }
}

/** An uncommitted change to a TRACKED file — what `status --porcelain -uno` calls dirty,
 *  and what makes a plain fast-forward unsafe (the behind-but-not-pullable state). */
export function makeDirty(dir: string): void {
  fs.writeFileSync(path.join(dir, 'README.md'), `# locally edited\n`)
}

export { gitWorktreeAdd }

// ---- waiters ------------------------------------------------------------------------

/** Startup scan (3s) + fetch + the rows push that carries the result. */
export const BADGE_TIMEOUT = 40_000

/**
 * Cold start is over: the renderer's shortcut listeners are attached AND the sidebar has
 * taken its first rows push (with nothing pinned, that push is what renders the empty
 * state). A shortcut sent before this lands in nothing.
 */
export async function waitSettled(page: Page, workspaceCount: number): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  // …and past the cold-start guard: a ⌘N/⇧⌘N before the first rows arrival is a
  // deliberate silent no-op (§03A), which would fail any toast/dialog assertion
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

/** Launch against the pins already on disk and wait out the cold start. */
export async function launchSettled(
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitSettled(page, pinnedCount(env))
  return { app, page }
}

/** The amber behind badge on ONE workspace row (the grey info variant carries `.info`). */
export function behindBadge(page: Page, wsName: string): Locator {
  return page.locator('.ws-head', { hasText: wsName }).locator('.ws-behind')
}

/** Wait until the sidebar shows that workspace as behind by n — the app's own fetch is
 *  what produces it, so this doubles as "the freshness sweep has run". */
export async function waitForBehindBadge(
  page: Page,
  wsName: string,
  behind: number,
  timeout = BADGE_TIMEOUT
): Promise<void> {
  await expect(behindBadge(page, wsName)).toHaveText(`${behind}`, { timeout })
}

/** Match a secondary line WHOLE — `main` must not also match a worktree named `main-x`. */
function exactText(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
}

/** Session rows under one workspace whose secondary line reads exactly `sub`
 *  (`main` for the main checkout, otherwise the worktree name). */
export function rowsWithSub(page: Page, wsName: string, sub: string): Locator {
  return wsRows(page, wsName).filter({
    has: page.locator('.ws-tab-sub', { hasText: exactText(sub) })
  })
}

/** Wait for a session row to appear under `wsName` carrying that secondary line —
 *  pending or already bound, since a pending row promotes IN PLACE. */
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

/** The same row while it is still PENDING (claude launched, SessionStart not yet bound) —
 *  the earliest proof a launch really happened where it was asked to. */
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

// ---- the §0 shortcut seam ------------------------------------------------------------

export const NEW_SESSION_CHANNEL = 'shortcut:new-session'
export const NEW_WORKTREE_SESSION_CHANNEL = 'shortcut:new-worktree-session'

/** Forward a menu accelerator's IPC the way §0 requires (a native accelerator cannot be
 *  synthesized), after the renderer's listeners exist — an earlier send is dropped. */
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

/** ⌘N */
export async function pressNewSession(app: ElectronApplication, page: Page): Promise<void> {
  await pressShortcut(app, page, NEW_SESSION_CHANNEL)
}

/** ⇧⌘N — the new key; nothing listens to it until the feature exists. */
export async function pressNewWorktreeSession(app: ElectronApplication, page: Page): Promise<void> {
  await pressShortcut(app, page, NEW_WORKTREE_SESSION_CHANNEL)
}

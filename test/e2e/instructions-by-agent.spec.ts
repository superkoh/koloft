import type { Page } from '@playwright/test'
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
import {
  butlerRow,
  centerTerm,
  newSessionInWith,
  runIn,
  settingsOnDisk,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote
} from './helpers/remote'
import { isRemoteKey } from '../../src/shared/remoteKey'
import type { InstructionsVersion } from '../../src/core/ownerInstructions'
import type { BackendId } from '../../src/shared/types'

test.afterEach(({ env }) => killFakeRemote(env))

const WRITTEN = 'Answer in Chinese.'
const lineOf = (who: string): string => `${who} says: run npm test first.`
const TOAST = "changed this workspace's instructions · View"
const AGENT_LABEL: Record<BackendId, 'Claude' | 'Codex' | 'Muse' | 'Antigravity'> = {
  claude: 'Claude',
  codex: 'Codex',
  muse: 'Muse',
  agy: 'Antigravity'
}

function versionsOnDisk(env: E2EEnv): InstructionsVersion[] {
  const all = Object.values(
    (settingsOnDisk(env).sessionDefaults ?? {}) as Record<
      string,
      { instructions?: InstructionsVersion[] }
    >
  )
  return all.flatMap((d) => d.instructions ?? [])
}

async function ownerWrites(page: Page, wsName: string, text: string): Promise<void> {
  await page.locator('.ws-head', { hasText: wsName }).click({ button: 'right' })
  await page.locator('.menu .mi', { hasText: 'Session defaults…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Session defaults' })
  await dlg.getByRole('textbox', { name: 'Instructions' }).fill(text)
  await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
  await expect(dlg).toHaveCount(0)
}

const tabIds = (page: Page, wsName: string): Promise<string[]> =>
  wsRows(page, wsName).evaluateAll((rows) =>
    rows.flatMap((r) => (r.getAttribute('data-tab-id') ? [r.getAttribute('data-tab-id')!] : []))
  )

async function newTabIn(page: Page, wsName: string, known: string[]): Promise<string> {
  let tab = ''
  await expect
    .poll(
      async () => {
        tab = (await tabIds(page, wsName)).find((id) => !known.includes(id)) ?? ''
        return tab
      },
      { timeout: 60_000 }
    )
    .not.toBe('')
  return tab
}

async function startIn(page: Page, wsName: string, backend: BackendId): Promise<string> {
  const known = await tabIds(page, wsName)
  await newSessionInWith(page, wsName, AGENT_LABEL[backend])
  if (wsName === REMOTE_WS_NAME) {
    await OTHER_AGENTS_ON_THE_MACHINE.find((a) => a.label === AGENT_LABEL[backend])?.bound?.(page)
    return newTabIn(page, wsName, known)
  }
  const tab = await newTabIn(page, wsName, known)
  const row = wsRows(page, wsName).and(page.locator(`[data-tab-id="${tab}"]`))
  await expect
    .poll(
      async () => {
        if (/\bst-waiting\b/.test((await row.getAttribute('class')) ?? '')) return true
        await runIn(page, centerTerm(page), 'first words')
        return false
      },
      { timeout: 60_000, intervals: [3000] }
    )
    .toBe(true)
  return tab
}

async function agentAddsAndOwnerUndoes(
  page: Page,
  env: E2EEnv,
  tabId: string,
  backend: BackendId
): Promise<void> {
  const before = versionsOnDisk(env).at(-1)?.text ?? ''
  const line = lineOf(backend)
  const typed = `/koloft instructions add -- ${line}`
  await expect
    .poll(
      async () => {
        if (versionsOnDisk(env).at(-1)?.text.includes(line)) return true
        await runIn(page, centerTerm(page), typed)
        return false
      },
      { timeout: 60_000, intervals: [3000] }
    )
    .toBe(true)
  const changed = versionsOnDisk(env).at(-1)!
  expect(changed).toMatchObject({ text: `${before}\n${line}`, unseen: true })
  expect(changed.by).not.toBe('owner')

  const toast = page.locator('.toast', { hasText: TOAST })
  await expect(toast).toBeVisible()
  await expect(toast).toContainText(`"${changed.by}" ${TOAST}`)
  await toast.click()
  const dlg = page.getByRole('dialog', { name: 'Session defaults' })
  await expect(dlg.locator('.instr-change .idiff-add .idiff-code')).toHaveText([line])
  await expect(dlg.getByText(`changed by ${changed.by}`)).toBeVisible()
  await expect.poll(() => versionsOnDisk(env).some((v) => v.unseen)).toBe(false)
  await dlg.getByRole('button', { name: 'Undo this change' }).click()
  await expect(dlg.getByText('Change undone')).toBeVisible()
  await expect(dlg.locator('.instr-change')).toHaveCount(0)
  await expect(dlg.getByRole('textbox', { name: 'Instructions' })).toHaveValue(before)
  await expect.poll(() => versionsOnDisk(env).at(-1)).toMatchObject({ text: before, by: 'owner' })
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg).toHaveCount(0)
}

test.describe('koloft instructions: an agent adds a line to the owner’s instructions, the owner is shown the change and undoes it', () => {
  test('on this Mac, a Claude Code, Codex, Muse and Antigravity session each add a line to their own workspace’s instructions; a clickable toast opens Session defaults at the change, which the owner undoes', async ({
    env
  }) => {
    test.setTimeout(300_000)
    seedSettings(env, { hintsOff: true })
    installCodex(env)
    installMuse(env)
    installAgy(env)
    trustInMuse(env, env.workspaces.a)
    trustInAgy(env, env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ownerWrites(page, 'ws-a', WRITTEN)
      for (const backend of ['claude', 'codex', 'muse', 'agy'] as const)
        await agentAddsAndOwnerUndoes(page, env, await startIn(page, 'ws-a', backend), backend)
      expect(versionsOnDisk(env).at(-1)).toMatchObject({ text: WRITTEN, by: 'owner' })
    } finally {
      await quitAndClose(app)
    }
  })

  test("on a remote workspace, a Claude Code, Codex, Muse and Antigravity session each change that workspace's instructions, which the owner sees and undoes", async ({
    env
  }) => {
    test.setTimeout(400_000)
    seedSettings(env, { hintsOff: true })
    for (const agent of OTHER_AGENTS_ON_THE_MACHINE) agent.install(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await ownerWrites(page, REMOTE_WS_NAME, WRITTEN)
      for (const backend of ['claude', 'codex', 'muse', 'agy'] as const)
        await agentAddsAndOwnerUndoes(
          page,
          env,
          await startIn(page, REMOTE_WS_NAME, backend),
          backend
        )
      const kept = Object.keys(settingsOnDisk(env).sessionDefaults as object)
      expect(kept).toHaveLength(1)
      expect(isRemoteKey(kept[0])).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  test('the butler adds a line to its own instructions: its strip says so with View ›, which shows the change and undoes it, then says Change undone', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await butlerRow(page).click()
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const tabId = (await butlerRow(page).getAttribute('data-tab-id'))!
      const butlerVersions = (): InstructionsVersion[] =>
        (settingsOnDisk(env).butler as { instructions?: InstructionsVersion[] }).instructions ?? []
      const line = lineOf('Alfred')
      await page.evaluate(
        ([tab, t]) => window.api.terminal.write(tab, t),
        [tabId, `/koloft instructions add -- ${line}\r`]
      )
      await expect.poll(() => butlerVersions().at(-1)?.text, { timeout: 30_000 }).toBe(line)
      const strip = page.locator('.term-island .butler-strip')
      await expect(strip.locator('.changed')).toHaveText(
        `${butlerVersions().at(-1)!.by} changed the instructions`
      )
      await strip.getByRole('button', { name: 'View ›' }).click()
      const view = page.getByRole('dialog', { name: 'Instructions' })
      await expect(view.locator('.instr-change .idiff-add .idiff-code')).toHaveText([line])
      await expect(view.locator('.pal-tips')).toHaveText('1 line added · Esc')
      await expect(strip.locator('.changed')).toHaveCount(0)
      await view.getByRole('button', { name: 'Undo this change' }).click()
      await expect(view).toHaveCount(0)
      await expect(strip.locator('.wb-title')).toContainText('Change undone')
      expect(butlerVersions().at(-1)).toMatchObject({ text: '', by: 'owner' })
    } finally {
      await quitAndClose(app)
    }
  })
})

import { expect, type Page } from '@playwright/test'
import type { E2EEnv } from './env'
import { centerTerm, newSessionInWith, runIn, settingsOnDisk, wsRows } from './p1'
import { OTHER_AGENTS_ON_THE_MACHINE, REMOTE_WS_NAME } from './remote'
import type { InstructionsVersion } from '../../../src/core/ownerInstructions'
import type { BackendId } from '../../../src/shared/types'

export const AGENT_LABEL: Record<BackendId, 'Claude' | 'Codex' | 'Antigravity'> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity'
}
const AN_ASK_SHOWS_WITHIN_MS = 20_000

export function versionsOnDisk(env: E2EEnv): InstructionsVersion[] {
  const all = Object.values(
    (settingsOnDisk(env).sessionDefaults ?? {}) as Record<
      string,
      { instructions?: InstructionsVersion[] }
    >
  )
  return all.flatMap((d) => d.instructions ?? [])
}

export const butlerVersions = (env: E2EEnv): InstructionsVersion[] =>
  (settingsOnDisk(env).butler as { instructions?: InstructionsVersion[] }).instructions ?? []

export async function ownerWrites(page: Page, wsName: string, text: string): Promise<void> {
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

export async function startIn(page: Page, wsName: string, backend: BackendId): Promise<string> {
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

export const askDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Change the instructions?' })

export async function agentProposes(page: Page, line: string): Promise<void> {
  const typed = `/koloft instructions add -- ${line}`
  await runIn(page, centerTerm(page), typed)
  try {
    await expect(askDialog(page)).toBeVisible({ timeout: AN_ASK_SHOWS_WITHIN_MS })
  } catch {
    await runIn(page, centerTerm(page), typed)
    await expect(askDialog(page)).toBeVisible({ timeout: AN_ASK_SHOWS_WITHIN_MS })
  }
  await expect(askDialog(page).locator('.instr-change .idiff-add .idiff-code')).toHaveText([line])
}

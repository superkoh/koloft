import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { expect } from './app'
import { centerTerm, runIn, terminalText } from './p1'

export const COLD_BUNDLE_FIRST_RENDER_TIMEOUT_MS = 30_000

const PROMPT_AFTER_THE_FOLDER_WENT = 'next words after the folder went'

export const AGYS_OWN_EFFORT = /\blow\b/

const CLAUDES_OWN_EFFORT_LEVEL = 'max'

export function claudeSettingsNameAnotherEffort(home: string): void {
  const file = path.join(home, '.claude', 'settings.json')
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...settings, effortLevel: CLAUDES_OWN_EFFORT_LEVEL }))
}

function rendered(out: string): string {
  try {
    return fs.readFileSync(out, 'utf8')
  } catch {
    return ''
  }
}

export async function claudeStatusLineDrawnAgainAfterItsFolderIsRemoved(
  page: Page,
  out: string,
  folder: string
): Promise<void> {
  await expect
    .poll(() => rendered(out), { timeout: COLD_BUNDLE_FIRST_RENDER_TIMEOUT_MS })
    .toContain('xhigh')
  fs.rmSync(out)
  fs.rmSync(folder, { recursive: true, force: true })
  await runIn(page, centerTerm(page), PROMPT_AFTER_THE_FOLDER_WENT)
  await expect
    .poll(() => rendered(out), { timeout: COLD_BUNDLE_FIRST_RENDER_TIMEOUT_MS })
    .toContain('xhigh')
}

export async function agyStatusLineDrawnAgainAfterItsFolderIsRemoved(
  page: Page,
  tabId: string,
  folder: string
): Promise<void> {
  await expect
    .poll(() => terminalText(page, tabId), { timeout: COLD_BUNDLE_FIRST_RENDER_TIMEOUT_MS })
    .toMatch(AGYS_OWN_EFFORT)
  fs.rmSync(folder, { recursive: true, force: true })
  await runIn(page, centerTerm(page), PROMPT_AFTER_THE_FOLDER_WENT)
  const sinceThePrompt = async (): Promise<string> => {
    const text = await terminalText(page, tabId)
    const at = text.lastIndexOf(PROMPT_AFTER_THE_FOLDER_WENT)
    return at < 0 ? '' : text.slice(at + PROMPT_AFTER_THE_FOLDER_WENT.length)
  }
  await expect
    .poll(sinceThePrompt, { timeout: COLD_BUNDLE_FIRST_RENDER_TIMEOUT_MS })
    .toMatch(AGYS_OWN_EFFORT)
  expect(await sinceThePrompt()).not.toContain('Statusline Error')
}

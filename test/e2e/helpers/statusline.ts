import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { expect } from './app'
import { centerTerm, runIn, terminalText } from './p1'

const FIRST_RENDER_ON_A_COLD_REMOTE_TIMEOUT_MS = 60_000

const PROMPT_AFTER_THE_FOLDER_WENT = 'next words after the folder went'

const FAKE_CLAUDES_EFFORT = 'xhigh'

const AGYS_OWN_EFFORT = /\blow\b/

const CLAUDES_OWN_EFFORT_LEVEL = 'max'

export function claudeSettingsNameAnotherEffort(home: string): void {
  const file = path.join(home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ effortLevel: CLAUDES_OWN_EFFORT_LEVEL }))
}

export async function claudeStatusLineDrawnAgainAfterItsFolderIsRemoved(
  page: Page,
  out: string,
  folder: string
): Promise<void> {
  const drawn = (): Promise<void> =>
    expect
      .poll(
        () => {
          try {
            return fs.readFileSync(out, 'utf8')
          } catch {
            return ''
          }
        },
        { timeout: FIRST_RENDER_ON_A_COLD_REMOTE_TIMEOUT_MS }
      )
      .toContain(FAKE_CLAUDES_EFFORT)
  await drawn()
  fs.rmSync(out)
  fs.rmSync(folder, { recursive: true, force: true })
  await runIn(page, centerTerm(page), PROMPT_AFTER_THE_FOLDER_WENT)
  await drawn()
}

export async function agyStatusLineDrawnAgainAfterItsFolderIsRemoved(
  page: Page,
  tabId: string,
  folder: string
): Promise<void> {
  const claudes = new RegExp(`\\b${CLAUDES_OWN_EFFORT_LEVEL}\\b`)
  await expect
    .poll(() => terminalText(page, tabId), { timeout: FIRST_RENDER_ON_A_COLD_REMOTE_TIMEOUT_MS })
    .toMatch(AGYS_OWN_EFFORT)
  expect(await terminalText(page, tabId)).not.toMatch(claudes)
  fs.rmSync(folder, { recursive: true, force: true })
  await runIn(page, centerTerm(page), PROMPT_AFTER_THE_FOLDER_WENT)
  const sinceThePrompt = async (): Promise<string> => {
    const text = await terminalText(page, tabId)
    const at = text.indexOf(PROMPT_AFTER_THE_FOLDER_WENT)
    return at < 0 ? '' : text.slice(at)
  }
  const answer = `Answer to: ${PROMPT_AFTER_THE_FOLDER_WENT}`
  await expect
    .poll(
      async () => {
        const since = await sinceThePrompt()
        const at = since.indexOf(answer)
        return at < 0 ? '' : since.slice(at + answer.length)
      },
      { timeout: FIRST_RENDER_ON_A_COLD_REMOTE_TIMEOUT_MS }
    )
    .toMatch(AGYS_OWN_EFFORT)
  const since = await sinceThePrompt()
  expect(since).not.toContain('Statusline Error')
  expect(since).not.toMatch(claudes)
}

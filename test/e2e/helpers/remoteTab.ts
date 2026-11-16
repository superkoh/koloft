import type { Page } from '@playwright/test'
import { BACKEND_LABEL } from '../../../src/shared/sessionBackend'
import type { BackendId } from '../../../src/shared/types'
import { expect } from './app'
import { seedSettings, type E2EEnv } from './env'
import { newSessionInWith, startSessionIn, terminalText, wsRows } from './p1'
import { OTHER_AGENTS_ON_THE_MACHINE, REMOTE_WS_NAME, addRemoteWorkspace } from './remote'

const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000

function onTheMachine(backend: Exclude<BackendId, 'claude'>) {
  return OTHER_AGENTS_ON_THE_MACHINE.find((a) => a.label === BACKEND_LABEL[backend])!
}

export function installOnTheMachine(env: E2EEnv, backend: BackendId): void {
  if (backend !== 'claude') onTheMachine(backend).install(env)
  seedSettings(env, { hintsOff: true })
}

export async function startRemoteTab(page: Page, env: E2EEnv, backend: BackendId): Promise<string> {
  await addRemoteWorkspace(page, env)
  const row = wsRows(page, REMOTE_WS_NAME).first()
  if (backend === 'claude') await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
  else {
    const agent = onTheMachine(backend)
    await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
    await agent.bound?.(page)
  }
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
  return (await row.getAttribute('data-tab-id'))!
}

async function koloftExits(page: Page, tabId: string): Promise<string[]> {
  return [
    ...(await terminalText(page, tabId)).matchAll(
      /\[fake-(?:claude|codex|muse|agy)\] koloft exit=(\d+)/g
    )
  ].map((m) => m[1])
}

export async function koloftInSession(page: Page, tabId: string, args: string): Promise<string> {
  const before = (await koloftExits(page, tabId)).length
  await page.evaluate(
    ([tab, line]) => window.api.terminal.write(tab, line + '\r'),
    [tabId, `/koloft ${args}`]
  )
  await expect
    .poll(async () => (await koloftExits(page, tabId)).length, {
      timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS
    })
    .toBe(before + 1)
  return (await koloftExits(page, tabId))[before]
}

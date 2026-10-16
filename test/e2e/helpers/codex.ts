import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { expect } from './app'
import type { E2EEnv } from './env'
import { newSessionInWith, startSessionIn, wsRows } from './p1'

export interface CodexCall {
  pid: number
  argv: string[]
  cwd: string
  sessionId: string
  method: string
  codexHome: string | null
}

export function codexCalls(env: E2EEnv): CodexCall[] {
  const file = path.join(env.home, 'fake-codex-calls.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CodexCall]
      } catch {
        return []
      }
    })
}

export function codexRows(page: Page, ws = 'ws-a'): Locator {
  return wsRows(page, ws).filter({
    hasNot: page.getByRole('img', { name: 'Claude', exact: true })
  })
}

export async function startCodex(page: Page, env: E2EEnv, ws = 'ws-a'): Promise<CodexCall> {
  const before = codexCalls(env).length
  await newSessionInWith(page, ws, 'Codex')
  await expect.poll(() => codexCalls(env).length).toBe(before + 1)
  await expect(codexRows(page, ws).filter({ hasText: 'Starting…' })).toHaveCount(0)
  await expect(codexRows(page, ws).and(page.locator('.active'))).toHaveClass(/st-waiting/)
  return codexCalls(env)[before]
}

export async function startLocalSession(
  page: Page,
  env: E2EEnv,
  backend: 'claude' | 'codex'
): Promise<void> {
  if (backend === 'claude') await startSessionIn(page, 'ws-a')
  else await startCodex(page, env)
}

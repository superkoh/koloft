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
  effectiveCwd: string
  sessionId: string
  method: string
  codexHome: string | null
}

export function fakeCodexLog<T>(env: E2EEnv, name: string): T[] {
  const file = path.join(env.home, name)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}

export interface CodexWireLine {
  direction: 'client' | 'server'
  frame: {
    method?: string
    params?: { item?: { type?: string; text?: string } } & Record<string, unknown>
  }
}

export function codexAnswers(wire: CodexWireLine[]): string[] {
  return wire.flatMap(({ frame }) =>
    frame.method === 'item/completed' && frame.params?.item?.type === 'agentMessage'
      ? [frame.params.item.text ?? '']
      : []
  )
}

export function codexCalls(env: E2EEnv): CodexCall[] {
  return fakeCodexLog<CodexCall>(env, 'fake-codex-calls.jsonl')
}

export function codexRows(page: Page): Locator {
  return wsRows(page, 'ws-a').filter({
    hasNot: page.getByRole('img', { name: 'Claude', exact: true })
  })
}

export function claudeRows(page: Page): Locator {
  return wsRows(page, 'ws-a').filter({
    has: page.getByRole('img', { name: 'Claude', exact: true })
  })
}

export async function startCodex(page: Page, env: E2EEnv): Promise<CodexCall> {
  const before = codexCalls(env).length
  await newSessionInWith(page, 'ws-a', 'Codex')
  await expect.poll(() => codexCalls(env).length).toBe(before + 1)
  await expect(codexRows(page).filter({ hasText: 'Starting…' })).toHaveCount(0)
  await expect(codexRows(page).and(page.locator('.active'))).toHaveClass(/st-waiting/)
  return codexCalls(env)[before]
}

export async function startLocalSession(
  page: Page,
  env: E2EEnv,
  backend: 'claude' | 'codex'
): Promise<void> {
  if (backend === 'codex') return void (await startCodex(page, env))
  await startSessionIn(page, 'ws-a')
  await expect(wsRows(page, 'ws-a')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
}

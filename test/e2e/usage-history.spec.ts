import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Locator, Page } from '@playwright/test'
import { expect, launchApp, test, quitAndClose } from './helpers/app'
import { installAgy, installMuse, seedSettings, type E2EEnv } from './helpers/env'
import { openSettings } from './helpers/extensions'
import { centerTerm, newSessionInWith, runIn, seedJsonl, waitBooted, wsRows } from './helpers/p1'
import {
  addRemoteWorkspace,
  agyReady,
  installCodexOnFakeRemote,
  installMuseOnMachine,
  installRemoteAgy,
  killFakeRemote,
  launchWithRemote,
  machineHome,
  remoteDir,
  remoteKey,
  REMOTE_WS_NAME
} from './helpers/remote'

const CLAUDE_TITLE = 'Seeded usage session'

function appendLines(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function dateDir(now: Date): string[] {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return [String(now.getFullYear()), p2(now.getMonth() + 1), p2(now.getDate())]
}

function seedClaude(env: E2EEnv, now: Date): void {
  const id = seedJsonl(env, env.workspaces.a, { summary: CLAUDE_TITLE })
  const file = path.join(
    env.home,
    '.claude',
    'projects',
    fs.readdirSync(path.join(env.home, '.claude', 'projects'))[0],
    `${id}.jsonl`
  )
  appendLines(file, [
    {
      type: 'assistant',
      sessionId: id,
      requestId: 'req-1',
      timestamp: now.toISOString(),
      message: {
        id: 'msg-1',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 }
      }
    }
  ])
}

function seedCodex(codexHome: string, cwd: string, now: Date): void {
  const thread = crypto.randomUUID()
  const file = path.join(
    codexHome,
    'sessions',
    ...dateDir(now),
    `rollout-2026-10-22T00-00-00-${thread}.jsonl`
  )
  const ts = now.toISOString()
  appendLines(file, [
    { timestamp: ts, type: 'session_meta', payload: { id: thread, cwd } },
    { timestamp: ts, type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5' } },
    {
      timestamp: ts,
      type: 'token_usage_record',
      payload: {
        turn_id: 't1',
        response_id: 'r1',
        usage: { input_tokens: 400_000, cached_input_tokens: 0, output_tokens: 0 }
      }
    }
  ])
}

function seedMuse(env: E2EEnv, now: Date): void {
  const file = path.join(
    env.home,
    '.local',
    'share',
    'muse',
    'sessions',
    ...dateDir(now),
    crypto.randomUUID(),
    'session.jsonl'
  )
  appendLines(file, [
    {
      recorded_at: now.getTime() * 1000,
      payload_type: 'runtime.session',
      payload: {
        kind: 'run',
        run_id: 'run-1',
        event: {
          kind: 'model_completed',
          model: 'muse-model',
          usage: { input_tokens: 2000, cached_tokens: 0, output_tokens: 500 }
        }
      }
    }
  ])
}

function protobufString(field: number, inner: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(inner.length), inner])
}

function varint(n: number): Buffer {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}

function seedAntigravity(env: E2EEnv, now: Date): void {
  const id = crypto.randomUUID()
  const app = path.join(env.home, '.gemini', 'antigravity-cli')
  appendLines(path.join(app, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), [
    { type: 'USER_INPUT', created_at: now.toISOString(), content: 'hi' },
    {
      type: 'PLANNER_RESPONSE',
      created_at: now.toISOString(),
      content: 'hello',
      input_tokens: 500_000,
      output_tokens: 0,
      cache_read_tokens: 0
    }
  ])
  fs.mkdirSync(path.join(app, 'conversations'), { recursive: true })
  const db = new DatabaseSync(path.join(app, 'conversations', `${id}.db`))
  db.exec('create table gen_metadata (idx integer primary key, data blob)')
  db.exec('create table executor_metadata (idx integer primary key, data blob)')
  const model = protobufString(1, protobufString(19, Buffer.from('gemini-3.1-pro')))
  db.prepare('insert into gen_metadata (idx, data) values (?, ?)').run(0, model)
  db.close()
}

test('Settings ▸ Usage counts Claude Code, Codex, Muse and Antigravity sessions from their own files, priced per model', async ({
  env
}) => {
  test.setTimeout(120_000)
  const now = new Date()
  seedClaude(env, now)
  seedCodex(path.join(env.home, '.codex'), env.workspaces.a, now)
  seedMuse(env, now)
  seedAntigravity(env, now)

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    await openSettings(page)
    await page.locator('.set-ni', { hasText: 'Usage' }).click()

    const total = page.locator('.costs-sum .n').first()
    await expect(total).toHaveText('$9.00', { timeout: 30_000 })
    await expect(page.locator('.costs-sum .n').nth(1)).toHaveText('4')
    await expect(page.locator('.costs-col.today')).toHaveAttribute('aria-label', /\$9\.00$/)

    await page.locator('.costs-head button', { hasText: 'Model' }).click()
    const rows = page.locator('.costs-row')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText('claude-opus-5-5')
    await expect(rows.nth(0).locator('.c')).toHaveText('$6.00')
    await expect(rows.nth(1)).toContainText('gpt-5.5')
    await expect(rows.nth(1).locator('.acct-badge')).toHaveText('CODEX')
    await expect(rows.nth(1).locator('.c')).toHaveText('$2.00')
    await expect(rows.nth(2)).toContainText('gemini-3.1-pro')
    await expect(rows.nth(2).locator('.acct-badge')).toHaveText('ANTIGRAVITY')
    await expect(rows.nth(2).locator('.c')).toHaveText('$1.00')
    await expect(rows.nth(3)).toContainText('muse-model')
    await expect(rows.nth(3).locator('.acct-badge')).toHaveText('MUSE')
    await expect(rows.nth(3).locator('.c')).toHaveText('no price')

    await page.locator('.costs-head button', { hasText: 'Session' }).click()
    const claude = page.locator('.costs-row', { hasText: CLAUDE_TITLE })
    await expect(claude).toContainText('ws-a · claude-opus-5-5 · 1 day')
    await expect(claude.locator('.tk')).toHaveText('1.10M')
  } finally {
    await quitAndClose(app)
  }
})

test.describe('remote usage', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

  test("Settings ▸ Usage counts a remote Codex session from the machine's own rollout, under the ssh workspace with an SSH badge", async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      seedCodex(
        path.join(machineHome(env), '.koloft', 'codex-home'),
        fs.realpathSync(remoteDir(env)),
        new Date()
      )
      await addRemoteWorkspace(page, env)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
      await expect(
        wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'Codex fixture session' })
      ).toHaveClass(/st-waiting/, { timeout: 60_000 })

      const row = await remoteUsageRow(page, env, 'Workspace')
      await expect(row.locator('.acct-badge')).toHaveText('SSH')
      await expect(row.locator('.c')).toHaveText('$2.00')
    } finally {
      await quitAndClose(app)
    }
  })

  test("Settings ▸ Usage counts a remote Muse session from the machine's own session log, its row under the ssh workspace with MUSE and SSH badges", async ({
    env
  }) => {
    test.setTimeout(180_000)
    installMuse(env)
    installMuseOnMachine(env)
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Muse')
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await runIn(page, centerTerm(page), 'remote words')
      await expect(wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'remote words' })).toHaveClass(
        /st-waiting/,
        { timeout: 60_000 }
      )

      const row = await remoteUsageRow(page, env, 'Session')
      await expect(row).toContainText('fake-model')
      await expect(row.locator('.acct-badge')).toHaveText(['MUSE', 'SSH'])
      await expect(row.locator('.c')).toHaveText('no price')
    } finally {
      await quitAndClose(app)
    }
  })

  test("Settings ▸ Usage counts a remote Antigravity session from the machine's transcript, priced by the model in its conversation db, its row under the ssh workspace with ANTIGRAVITY and SSH badges", async ({
    env
  }) => {
    test.setTimeout(180_000)
    installAgy(env)
    installRemoteAgy(env)
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchWithRemote(env)
    try {
      fs.writeFileSync(path.join(machineHome(env), 'fake-agy-input-tokens'), '400000')
      await addRemoteWorkspace(page, env)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'remote words')
      await expect(wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'remote words' })).toHaveClass(
        /st-waiting/,
        { timeout: 60_000 }
      )

      const row = await remoteUsageRow(page, env, 'Session')
      await expect(row).toContainText('gemini-3.1-pro')
      await expect(row.locator('.acct-badge')).toHaveText(['ANTIGRAVITY', 'SSH'])
      await expect(row.locator('.c')).toHaveText('$0.80')
    } finally {
      await quitAndClose(app)
    }
  })
})

async function remoteUsageRow(
  page: Page,
  env: E2EEnv,
  by: 'Workspace' | 'Session'
): Promise<Locator> {
  await openSettings(page)
  await page.locator('.set-ni', { hasText: 'Usage' }).click()
  await page.locator('.costs-head button', { hasText: by }).click()
  const row = page.locator('.costs-row', { hasText: remoteKey(env) })
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.api.usage.read())
        return row.count()
      },
      { timeout: 60_000 }
    )
    .toBe(1)
  return row
}

import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import type { Locator, Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { installAgyWithNoAccount, type E2EEnv } from './helpers/env'
import { seedJsonl, waitBooted } from './helpers/p1'
import { expectScreen } from './helpers/screenCompare'
import {
  agyGoogle,
  agyKey,
  codexChatGpt,
  codexSignIn,
  DAY_S,
  FIXED_NOW,
  FIXED_S,
  HOUR_S,
  installCodexAtFixedTime,
  launchAtFixedTime,
  SCREENS_TAKE_LONGER_THAN_THE_DEFAULT_MS,
  seedAccounts,
  startClaudeProbe
} from './helpers/screenSeeds'

test.describe.configure({ timeout: SCREENS_TAKE_LONGER_THAN_THE_DEFAULT_MS })

function usageCapsule(page: Page): Locator {
  return page.locator('button.tbu')
}

function usagePopover(page: Page): Locator {
  return page.locator('.tbu-pop')
}

async function openUsagePopover(page: Page): Promise<void> {
  await usageCapsule(page).click()
  await expect(usagePopover(page)).toBeVisible()
  await expect(usagePopover(page).locator('.tbu-act').first()).toHaveText(/Probe now/, {
    timeout: 20_000
  })
  await usagePopover(page).locator('.tbu-pop-head').first().hover()
}

test.describe('top-bar usage: the capsule and its panel for every agent', () => {
  test('many accounts: Claude Code’s 5-hour, 7-day and fable bars with a total row, Codex’s windows with a total row and a reset to use, Antigravity’s quota buckets and an API key', async ({
    env
  }) => {
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
    seedAccounts(env, [
      { name: 'studio', kind: 'oauth', fable: 'yes' },
      { name: 'garden', kind: 'oauth', fable: 'no' },
      { name: 'walled', kind: 'oauth', fable: 'yes' },
      { name: 'metered', kind: 'apikey' },
      { name: 'plus', kind: 'codex-home' },
      { name: 'capped', kind: 'codex-home' },
      { name: 'signed-out', kind: 'codex-home' },
      { name: 'google', kind: 'agy-home' },
      { name: 'gemini-key', kind: 'agy-home' }
    ])
    codexSignIn(
      env,
      'plus',
      codexChatGpt(
        [
          { mins: 300, usedPercent: 25, resetsInMins: 270 },
          { mins: 10080, usedPercent: 61, resetsInMins: 4 * 1440 + 60 }
        ],
        { balance: 1250 }
      )
    )
    codexSignIn(
      env,
      'capped',
      codexChatGpt(
        [
          { mins: 300, usedPercent: 100, resetsInMins: 40 },
          { mins: 10080, usedPercent: 92, resetsInMins: 2 * 1440 }
        ],
        { resets: 2 }
      )
    )
    codexSignIn(env, 'signed-out', null)
    agyGoogle(env, 'google', [
      {
        name: 'Weekly Limit Remaining',
        window: 'weekly',
        remaining: 0.58,
        resetsAt: FIXED_S + 5 * DAY_S
      },
      {
        name: 'Five Hour Limit Remaining',
        window: '5h',
        remaining: 0.9,
        resetsAt: FIXED_S + 3 * HOUR_S
      }
    ])
    agyKey(env, 'gemini-key')
    const probe = await startClaudeProbe({
      studio: { u5: 0.42, u7: 0.63, uoi: 0.18 },
      garden: { u5: 0.07, u7: 0.31 },
      walled: { u5: 1, s5: 'rejected', r5: FIXED_S + 40 * 60, u7: 0.7, uoi: 0.97, soi: 'rejected' },
      metered: {}
    })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    const { app, page } = await launchAtFixedTime(env)
    try {
      await waitBooted(page)
      await expect(usageCapsule(page).locator('.tbu-group')).toHaveCount(2, { timeout: 20_000 })
      await expect(usageCapsule(page)).toHaveAttribute('aria-label', /Antigravity/, {
        timeout: 20_000
      })
      await expect(usageCapsule(page)).toHaveAttribute('aria-label', /walled/i, { timeout: 20_000 })
      await expectScreen(page, { name: 'topbar-usage-capsule-many', parts: [usageCapsule(page)] })
      await openUsagePopover(page)
      await expectScreen(page, {
        name: 'topbar-usage-panel-many',
        parts: [usagePopover(page)],
        mouseStays: true
      })
      await usagePopover(page)
        .locator('.tbu-rows')
        .evaluate((rows) => rows.scrollTo({ top: rows.scrollHeight, behavior: 'instant' }))
      await expect(
        usagePopover(page).locator('.tbu-row', { hasText: 'gemini-key' })
      ).toBeInViewport()
      await expectScreen(page, {
        name: 'topbar-usage-panel-many-scrolled-down',
        parts: [usagePopover(page)],
        mouseStays: true
      })
      await usagePopover(page).getByRole('button', { name: 'Use a reset' }).click()
      const confirm = usagePopover(page).locator('.acct-confirm')
      await expect(confirm).toBeVisible()
      await expectScreen(page, {
        name: 'topbar-usage-codex-reset-asked',
        parts: [usagePopover(page).locator('.tbu-row', { has: page.locator('.acct-confirm') })],
        mouseStays: true
      })
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  test('one Claude Code subscription walled with an API key standing by: no total row, and the metered fallback bar', async ({
    env
  }) => {
    seedAccounts(env, [
      { name: 'walled', kind: 'oauth', fable: 'no' },
      { name: 'metered', kind: 'apikey' }
    ])
    const probe = await startClaudeProbe({
      walled: {
        u5: 1,
        s5: 'rejected',
        r5: FIXED_S + 3 * HOUR_S,
        u7: 0.97,
        r7: FIXED_S + 2 * DAY_S
      },
      metered: {}
    })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    const { app, page } = await launchAtFixedTime(env)
    try {
      await waitBooted(page)
      await expect(usageCapsule(page).locator('.tbu-fill.acc')).toBeVisible({ timeout: 20_000 })
      await expectScreen(page, {
        name: 'topbar-usage-capsule-fallback',
        parts: [usageCapsule(page)]
      })
      await openUsagePopover(page)
      await expectScreen(page, {
        name: 'topbar-usage-panel-fallback',
        parts: [usagePopover(page)],
        mouseStays: true
      })
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })
})

function appendJsonLines(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function claudeUsage(
  env: E2EEnv,
  folder: string,
  title: string,
  atMs: number,
  input: number
): void {
  const id = seedJsonl(env, folder, { summary: title, mtime: atMs, timestamp: atMs, owned: false })
  const projects = path.join(env.home, '.claude', 'projects')
  const file = fs
    .readdirSync(projects)
    .map((d) => path.join(projects, d, `${id}.jsonl`))
    .find((f) => fs.existsSync(f))!
  appendJsonLines(file, [
    {
      type: 'assistant',
      sessionId: id,
      requestId: `req-${id}`,
      timestamp: new Date(atMs).toISOString(),
      message: {
        id: `msg-${id}`,
        model: 'claude-opus-5-5',
        usage: { input_tokens: input, output_tokens: input / 10 }
      }
    }
  ])
  fs.utimesSync(file, new Date(atMs), new Date(atMs))
}

function codexUsage(env: E2EEnv, folder: string, atMs: number, input: number): void {
  const at = new Date(atMs)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const thread = `0199a1b2-c3d4-7e5f-8a6b-${String(atMs).slice(-12)}`
  const file = path.join(
    env.home,
    '.codex',
    'sessions',
    String(at.getUTCFullYear()),
    p2(at.getUTCMonth() + 1),
    p2(at.getUTCDate()),
    `rollout-${at.toISOString().slice(0, 19).replace(/:/g, '-')}-${thread}.jsonl`
  )
  const ts = at.toISOString()
  appendJsonLines(file, [
    { timestamp: ts, type: 'session_meta', payload: { id: thread, cwd: folder } },
    { timestamp: ts, type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5' } },
    {
      timestamp: ts,
      type: 'token_usage_record',
      payload: {
        turn_id: 't1',
        response_id: 'r1',
        usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 }
      }
    }
  ])
}

function agyUsage(env: E2EEnv, atMs: number, input: number): void {
  const id = `7d1f0c2a-0b3e-4c5d-9e6f-${String(atMs).slice(-12)}`
  const app = path.join(env.home, '.gemini', 'antigravity-cli')
  const at = new Date(atMs).toISOString()
  appendJsonLines(path.join(app, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), [
    { type: 'USER_INPUT', created_at: at, content: 'hi' },
    {
      type: 'PLANNER_RESPONSE',
      created_at: at,
      content: 'hello',
      input_tokens: input,
      output_tokens: 0,
      cache_read_tokens: 0
    }
  ])
  fs.mkdirSync(path.join(app, 'conversations'), { recursive: true })
  const db = new DatabaseSync(path.join(app, 'conversations', `${id}.db`))
  db.exec('create table gen_metadata (idx integer primary key, data blob)')
  db.exec('create table executor_metadata (idx integer primary key, data blob)')
  db.prepare('insert into gen_metadata (idx, data) values (?, ?)').run(
    0,
    protobufString(1, protobufString(19, Buffer.from('gemini-3.1-pro')))
  )
  db.close()
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

test.describe('Settings ▸ Usage: the chart and every grouping, with sessions of all three agents', () => {
  test('usage page by day, session, workspace and model', async ({ env }) => {
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
    seedAccounts(env, [])
    const day = DAY_S * 1000
    claudeUsage(
      env,
      env.workspaces.a,
      'Tidy the release notes',
      FIXED_NOW - HOUR_S * 1000,
      1_000_000
    )
    claudeUsage(env, env.workspaces.b, 'Draft the onboarding copy', FIXED_NOW - 3 * day, 400_000)
    codexUsage(env, env.workspaces.a, FIXED_NOW - day, 400_000)
    agyUsage(env, FIXED_NOW - 2 * HOUR_S * 1000, 500_000)
    const { app, page } = await launchAtFixedTime(env)
    try {
      await waitBooted(page)
      await page.locator('.tb-ico[title="Settings"]').click()
      await page.getByRole('tab', { name: 'Usage', exact: true }).click()
      await expect(page.locator('.costs-sum .n').nth(1)).toHaveText('4', { timeout: 30_000 })
      await expectScreen(page, {
        name: 'usage-page-chart',
        parts: [
          page.locator('.set-ph'),
          page.locator('.costs-head'),
          page.locator('.costs-sum'),
          page.locator('.costs-chart'),
          page.locator('.costs-x')
        ]
      })
      for (const [label, id] of [
        ['Day', 'day'],
        ['Session', 'session'],
        ['Workspace', 'workspace'],
        ['Model', 'model']
      ] as const) {
        await page.locator('.costs-head button', { hasText: new RegExp(`^${label}$`) }).click()
        const list = page.locator('.costs-list')
        await expect(
          page.locator('.costs-head button.on', { hasText: new RegExp(`^${label}$`) })
        ).toBeVisible()
        await expectScreen(page, {
          name: `usage-page-by-${id}`,
          parts: [list.locator('xpath=preceding-sibling::div[contains(@class,"set-grp")][1]'), list]
        })
      }
    } finally {
      await quitAndClose(app)
    }
  })
})

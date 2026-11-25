import fs from 'fs'
import http from 'http'
import path from 'path'
import type { AddressInfo } from 'net'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp } from './app'
import {
  addKeychainEntry,
  installAgyWithNoAccount,
  installCodexWithNoAccount,
  seedSettings,
  signInAgyWithGoogle,
  UNPACKAGED_BUILD_AGY_SVC,
  type E2EEnv
} from './env'

export const FIXED_NOW = Date.UTC(2031, 2, 4, 9, 30, 0)
export const FIXED_S = FIXED_NOW / 1000
export const HOUR_S = 3600
export const DAY_S = 24 * HOUR_S
export const SCREENS_TAKE_LONGER_THAN_THE_DEFAULT_MS = 120_000
export const HIDDEN_TERMINAL_STAND_IN =
  'Sign-in timed out\n(stand-in: the hidden terminal’s own lines name this machine’s user and a throwaway folder)'

const SHIFTED_CLOCK = path.join(__dirname, '..', 'fixtures', 'shifted-clock.cjs')
const WINDOW = { width: 1440, height: 920 }
const EVERY_ANIMATION_AT_ITS_END =
  '*, *::before, *::after { animation-duration: 0s !important; animation-iteration-count: 1 !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }'
const PINNED_RENDERING = ['--lang=en-US', '--disable-gpu', '--force-device-scale-factor=1']

const UNPACKAGED_BUILD_CLAUDE_SERVICE = {
  oauth: 'koloft-dev-claude-oauth',
  apikey: 'koloft-dev-anthropic-api',
  custom: 'koloft-dev-custom-endpoint'
} as const

type Kind = 'oauth' | 'apikey' | 'custom' | 'codex-home' | 'agy-home'

export interface Seeded {
  name: string
  kind: Kind
  enabled?: boolean
  fable?: 'yes' | 'no' | 'unknown'
  status?: 'ok' | 'expired' | 'unverified'
  baseUrl?: string
  model?: string
}

export interface ClaudeAnswer {
  status?: number
  u5?: number
  s5?: string
  u7?: number
  uoi?: number
  soi?: string
  r5?: number
  r7?: number
}

interface CodexWindow {
  mins: number
  usedPercent: number
  resetsInMins: number
}

interface AgyBucket {
  name: string
  window: string
  remaining: number
  resetsAt: number
}

function claudeSecret(name: string): string {
  return `sk-ant-fixture-${name}`
}

export function seedAccounts(
  env: E2EEnv,
  accounts: Seeded[],
  extra: Record<string, unknown> = {}
): void {
  fs.writeFileSync(env.keychainFile, '{}')
  for (const a of accounts) {
    if (a.kind === 'oauth' || a.kind === 'apikey' || a.kind === 'custom')
      addKeychainEntry(env, UNPACKAGED_BUILD_CLAUDE_SERVICE[a.kind], a.name, claudeSecret(a.name))
  }
  seedSettings(env, {
    hintsOff: true,
    accounts: accounts.map((a) => ({
      name: a.name,
      kind: a.kind,
      enabled: a.enabled ?? true,
      fable: a.fable ?? 'unknown',
      status: a.status ?? 'ok',
      addedAt: FIXED_NOW - DAY_S * 1000,
      fableCheckedAt: FIXED_NOW - HOUR_S * 1000,
      ...(a.baseUrl ? { baseUrl: a.baseUrl, model: a.model } : {})
    })),
    ...extra
  })
}

export function installCodexAtFixedTime(env: E2EEnv): void {
  installCodexWithNoAccount(env)
  fs.writeFileSync(path.join(env.home, 'fake-codex-now'), String(FIXED_S))
}

export function codexSignIn(env: E2EEnv, name: string, auth: Record<string, unknown> | null): void {
  const home = path.join(env.userData, 'codex-homes', name)
  fs.mkdirSync(home, { recursive: true })
  if (auth) fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
}

export function codexChatGpt(
  windows: CodexWindow[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { windows, ...extra }
}

function agyAppDir(env: E2EEnv, name: string): string {
  return path.join(env.userData, 'agy-homes', name, 'antigravity-cli')
}

export function agyGoogle(env: E2EEnv, name: string, buckets: AgyBucket[] | null): void {
  signInAgyWithGoogle(env, name)
  if (buckets)
    fs.writeFileSync(
      path.join(agyAppDir(env, name), 'fake-agy-usage.json'),
      JSON.stringify({
        groups: [
          {
            name: 'Gemini Models',
            buckets: buckets.map((b, i) => ({
              id: `bucket-${i}`,
              name: b.name,
              window: b.window,
              remaining_fraction: b.remaining,
              reset_time: new Date(b.resetsAt * 1000).toISOString()
            }))
          }
        ]
      })
    )
}

export function agyKey(env: E2EEnv, name: string): void {
  const cache = path.join(agyAppDir(env, name), 'cache')
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(
    path.join(cache, 'onboarding.json'),
    JSON.stringify({ onboardingComplete: true })
  )
  addKeychainEntry(env, UNPACKAGED_BUILD_AGY_SVC, name, `gemini-fixture-${name}`)
}

export function agySignedOut(env: E2EEnv, name: string): void {
  fs.mkdirSync(agyAppDir(env, name), { recursive: true })
}

// CC§7
export async function startClaudeProbe(
  answers: Record<string, ClaudeAnswer>
): Promise<{ base: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const auth = String(req.headers['authorization'] ?? req.headers['x-api-key'] ?? '')
      const name = auth.replace(/^Bearer /, '').replace(/^sk-ant-fixture-/, '')
      const a = answers[name] ?? {}
      if (a.status && a.status !== 200) {
        res.writeHead(a.status, { 'content-type': 'application/json' }).end('{}')
        return
      }
      res
        .writeHead(200, {
          'content-type': 'application/json',
          ...(a.u5 === undefined
            ? {}
            : {
                'anthropic-ratelimit-unified-5h-utilization': String(a.u5),
                'anthropic-ratelimit-unified-5h-status': a.s5 ?? 'allowed',
                'anthropic-ratelimit-unified-5h-reset': String(a.r5 ?? FIXED_S + 2 * HOUR_S)
              }),
          'anthropic-ratelimit-unified-7d-utilization': String(a.u7 ?? 0.2),
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-reset': String(a.r7 ?? FIXED_S + 3 * DAY_S),
          ...(a.uoi === undefined
            ? {}
            : {
                'anthropic-ratelimit-unified-7d_oi-utilization': String(a.uoi),
                'anthropic-ratelimit-unified-7d_oi-status': a.soi ?? 'allowed',
                'anthropic-ratelimit-unified-7d_oi-reset': String(FIXED_S + 3 * DAY_S)
              })
        })
        .end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok()))
  }
}

export async function launchAtFixedTime(
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  env.launchEnv.TZ = 'UTC'
  env.launchEnv.KOLOFT_E2E_CLOCK_SHIFT_MS = String(FIXED_NOW - Date.now())
  env.extraArgs.push(...PINNED_RENDERING)
  const app = await launchApp(env, { preloadInMain: SHIFTED_CLOCK })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
  }, WINDOW)
  await page.clock.setFixedTime(FIXED_NOW)
  await page.context().addInitScript((css) => {
    const put = (): void => {
      const style = document.createElement('style')
      style.textContent = css
      document.documentElement.appendChild(style)
    }
    if (document.documentElement) put()
    else
      new MutationObserver((_, watch) => {
        if (!document.documentElement) return
        watch.disconnect()
        put()
      }).observe(document, { childList: true })
  }, EVERY_ANIMATION_AT_ITS_END)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => Number(a.effect?.getComputedTiming().duration ?? 0) > 0)
        .map((a) => (a as CSSAnimation).animationName ?? a.constructor.name)
    ),
    'animations still running after the page loaded with every animation at its end'
  ).toEqual([])
  return { app, page }
}

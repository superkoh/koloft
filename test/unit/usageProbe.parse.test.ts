import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import {
  parseRatelimitHeaders,
  probeAccount,
  scoreSnapshot,
  shouldSkipFable,
  CC_SYSTEM_PROMPT,
  PROBE_MODEL,
  FALLBACK_PROBE_MODEL,
  FABLE_RETRY_MS
} from '../../src/main/usageProbe'
import type { AccountMeta } from '../../src/shared/types'

const NOW_MS = 1_000_000_000_000

function fullHeaders(): Record<string, string> {
  return {
    'anthropic-ratelimit-unified-5h-utilization': '0.12',
    'anthropic-ratelimit-unified-7d-utilization': '0.41',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.74',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d_oi-status': 'allowed_warning',
    'anthropic-ratelimit-unified-5h-reset': '1754500000',
    'anthropic-ratelimit-unified-7d-reset': '1754800000',
    'anthropic-ratelimit-unified-7d_oi-reset': '1754800000',
    'anthropic-ratelimit-unified-overage-status': 'enabled'
  }
}

describe('U1 · parseRatelimitHeaders', () => {
  it('parses all three buckets + overage verbatim', () => {
    const p = parseRatelimitHeaders(fullHeaders(), NOW_MS)
    expect(p).not.toBeNull()
    expect(p!.usage).toMatchObject({
      u5: 0.12,
      u7: 0.41,
      uoi: 0.74,
      s5: 'allowed',
      s7: 'allowed',
      soi: 'allowed_warning',
      r5: 1754500000,
      r7: 1754800000,
      roi: 1754800000,
      overage: 'enabled',
      at: NOW_MS
    })
    expect(p!.usage.hasOi).toBe(true)
  })

  it('missing 7d_oi bucket (non-fable probe) → zeros, not a failure', () => {
    const h = fullHeaders()
    delete h['anthropic-ratelimit-unified-7d_oi-utilization']
    delete h['anthropic-ratelimit-unified-7d_oi-status']
    delete h['anthropic-ratelimit-unified-7d_oi-reset']
    const p = parseRatelimitHeaders(h, NOW_MS)
    expect(p).not.toBeNull()
    expect(p!.usage.uoi).toBe(0)
    expect(p!.usage.soi).toBe('?')
    expect(p!.usage.roi).toBe(0)
    expect(p!.usage.hasOi).toBe(false)
  })

  it('missing u5 → probe failure (null)', () => {
    const h = fullHeaders()
    delete h['anthropic-ratelimit-unified-5h-utilization']
    expect(parseRatelimitHeaders(h, NOW_MS)).toBeNull()
  })

  // CC§7
  it('top-level unified-status trap: rejected top-level with healthy buckets is IGNORED and scores no rejected penalty', () => {
    const h = fullHeaders()
    h['anthropic-ratelimit-unified-status'] = 'rejected'
    const p = parseRatelimitHeaders(h, NOW_MS)
    expect(p).not.toBeNull()
    expect(p!.usage.s5).toBe('allowed')
    const score = scoreSnapshot(p!.usage, Math.floor(NOW_MS / 1000), 'fable')
    expect(score.hardLimited).toBe(false)
  })

  it('mixed-case header names and CR-terminated values parse fine', () => {
    const h: Record<string, string> = {
      'Anthropic-Ratelimit-Unified-5h-Utilization': '0.5\r',
      'ANTHROPIC-RATELIMIT-UNIFIED-5H-STATUS': 'allowed\r'
    }
    const p = parseRatelimitHeaders(h, NOW_MS)
    expect(p).not.toBeNull()
    expect(p!.usage.u5).toBe(0.5)
    expect(p!.usage.s5).toBe('allowed')
  })
})

interface Seen {
  path: string
  headers: http.IncomingHttpHeaders
  body: { model?: string; system?: string; max_tokens?: number; messages?: unknown[] }
}

let server: http.Server
let base: string
let seen: Seen[]
let respond: (s: Seen) => { status: number; headers?: Record<string, string>; body?: string }

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const s: Seen = { path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') }
      seen.push(s)
      const r = respond(s)
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) })
      res.end(r.body ?? '{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((ok) => server.close(ok))
})

beforeEach(() => {
  seen = []
  process.env.KOLOFT_PROBE_BASE_URL = base
  process.env.KOLOFT_TEST_BACKGROUND = '1'
})

describe('U1 · probeAccount request shape', () => {
  it('oauth: Bearer + oauth beta + version headers + the Claude Code system prompt', async () => {
    respond = () => ({ status: 200, headers: fullHeaders() })
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.usage?.u5).toBe(0.12)
      expect(r.fable).toBe('yes')
    }
    expect(seen).toHaveLength(1)
    expect(seen[0].path).toBe('/v1/messages')
    expect(seen[0].headers['authorization']).toBe('Bearer sk-test-token')
    expect(seen[0].headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(seen[0].body.model).toBe(PROBE_MODEL)
    expect(seen[0].body.max_tokens).toBe(1)
    expect(seen[0].body.system).toBe(CC_SYSTEM_PROMPT)
  })

  it('apikey: x-api-key + version, no Bearer, no oauth beta; success carries no usage', async () => {
    respond = () => ({ status: 200 })
    const r = await probeAccount('apikey', 'sk-ant-api-test', { timeoutMs: 2000 })
    expect(r).toEqual({ ok: true })
    expect(seen[0].headers['x-api-key']).toBe('sk-ant-api-test')
    expect(seen[0].headers['authorization']).toBeUndefined()
    expect(seen[0].headers['anthropic-beta']).toBeUndefined()
  })

  it('401 → closed enum "expired" (no raw error text anywhere in the result)', async () => {
    respond = () => ({ status: 401, body: '{"error":{"message":"secret-leaky-detail"}}' })
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r).toEqual({ ok: false, error: 'expired' })
  })

  it('fable model unavailable → fable "no" + usage re-probe with the fallback model', async () => {
    respond = (s) =>
      s.body.model === PROBE_MODEL
        ? { status: 404, body: '{"error":{"type":"not_found_error","message":"model"}}' }
        : { status: 200, headers: fullHeaders() }
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fable).toBe('no')
    expect(seen.map((s) => s.body.model)).toEqual([PROBE_MODEL, FALLBACK_PROBE_MODEL])
  })

  // CC§7
  it('200 WITHOUT a 7d_oi bucket → fable "no", never undefined, so a plan that lost its fable allowance downgrades the badge', async () => {
    respond = () => {
      const h = fullHeaders()
      delete h['anthropic-ratelimit-unified-7d_oi-utilization']
      delete h['anthropic-ratelimit-unified-7d_oi-status']
      delete h['anthropic-ratelimit-unified-7d_oi-reset']
      return { status: 200, headers: h }
    }
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fable).toBe('no')
      expect(r.usage?.hasOi).toBe(false)
    }
  })

  it('test mode with no KOLOFT_PROBE_BASE_URL → refuses the network entirely', async () => {
    delete process.env.KOLOFT_PROBE_BASE_URL
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r).toEqual({ ok: false, error: 'network' })
    expect(seen).toHaveLength(0)
  })
})

// CC§7
describe('U1 · probeAccount error paths', () => {
  it('403 without headers (org restriction) → fallback re-probe: ok + fable "no", account stays in the pool', async () => {
    respond = (s) =>
      s.body.model === PROBE_MODEL
        ? { status: 403, body: '{"error":{"type":"permission_error","message":"org restricted"}}' }
        : { status: 200, headers: fullHeaders() }
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fable).toBe('no')
      expect(r.usage?.u5).toBe(0.12)
    }
    expect(seen.map((s) => s.body.model)).toEqual([PROBE_MODEL, FALLBACK_PROBE_MODEL])
  })

  it('ZDR-shaped 400 (no "model" in the body) → same fallback re-probe', async () => {
    respond = (s) =>
      s.body.model === PROBE_MODEL
        ? {
            status: 400,
            body: '{"error":{"type":"invalid_request_error","message":"organization does not allow this"}}'
          }
        : { status: 200, headers: fullHeaders() }
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fable).toBe('no')
    expect(seen.map((s) => s.body.model)).toEqual([PROBE_MODEL, FALLBACK_PROBE_MODEL])
  })

  it('fallback ALSO fails without headers → "unknown" with NO fable verdict (capability never poisoned by account-level errors)', async () => {
    respond = () => ({ status: 403, body: '{"error":{"type":"permission_error"}}' })
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r).toEqual({ ok: false, error: 'unknown' })
    expect(seen).toHaveLength(2)
  })

  it('5xx on the fable probe → "network", no pointless fallback, no fable verdict', async () => {
    respond = () => ({ status: 503, body: '{"error":{"type":"overloaded_error"}}' })
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r).toEqual({ ok: false, error: 'network' })
    expect(seen).toHaveLength(1)
  })

  it('non-2xx WITH unified headers (rate-limited shape) → usage read from the FIRST response, no re-probe', async () => {
    respond = () => ({
      status: 429,
      headers: fullHeaders(),
      body: '{"error":{"type":"rate_limit_error"}}'
    })
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.usage?.u5).toBe(0.12)
      expect(r.fable).toBe('yes')
    }
    expect(seen).toHaveLength(1)
  })

  // CC§7
  it('headerless 408 (transient blip) → usage re-probe but NO fable verdict (only deterministic 400/403/404 earn "no")', async () => {
    respond = (s) =>
      s.body.model === PROBE_MODEL
        ? { status: 408, body: '{"error":{"type":"timeout_error"}}' }
        : { status: 200, headers: fullHeaders() }
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.usage?.u5).toBe(0.12)
      expect(r.fable).toBeUndefined()
    }
    expect(seen.map((s) => s.body.model)).toEqual([PROBE_MODEL, FALLBACK_PROBE_MODEL])
  })

  // CC§7
  it('non-2xx with headers but WITHOUT the oi trio → no fable verdict (yes-only on error readings: the trio on error responses is unmeasured)', async () => {
    respond = () => {
      const h = fullHeaders()
      delete h['anthropic-ratelimit-unified-7d_oi-utilization']
      delete h['anthropic-ratelimit-unified-7d_oi-status']
      delete h['anthropic-ratelimit-unified-7d_oi-reset']
      return { status: 429, headers: h, body: '{"error":{"type":"rate_limit_error"}}' }
    }
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fable).toBeUndefined()
    expect(seen).toHaveLength(1)
  })
})

describe('U1 · probeAccount apikey/custom verify strictness', () => {
  it('unmatched 4xx (credit balance too low) → NOT ok — a rejected request is not a verified credential', async () => {
    respond = () => ({
      status: 400,
      body: '{"error":{"type":"invalid_request_error","message":"credit balance is too low"}}'
    })
    const r = await probeAccount('apikey', 'sk-ant-api-test', { timeoutMs: 2000 })
    expect(r).toEqual({ ok: false, error: 'unknown' })
  })
})

describe('U1 · probeAccount skipFable (§08 probe downgrade)', () => {
  it('probes the fallback model ONLY and leaves fable undefined — a sonnet probe cannot see the oi bucket, so it must not overwrite the recorded capability', async () => {
    respond = () => {
      const h = fullHeaders()
      delete h['anthropic-ratelimit-unified-7d_oi-utilization']
      delete h['anthropic-ratelimit-unified-7d_oi-status']
      delete h['anthropic-ratelimit-unified-7d_oi-reset']
      return { status: 200, headers: h }
    }
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000, skipFable: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.usage?.u5).toBe(0.12)
      expect(r.fable).toBeUndefined()
    }
    expect(seen.map((s) => s.body.model)).toEqual([FALLBACK_PROBE_MODEL])
  })

  it('skipFable 401 still maps to "expired"', async () => {
    respond = () => ({ status: 401 })
    const r = await probeAccount('oauth', 'sk-test-token', { timeoutMs: 2000, skipFable: true })
    expect(r).toEqual({ ok: false, error: 'expired' })
  })
})

describe('U1 · shouldSkipFable (§08 weekly retry gate)', () => {
  const T = 1_700_000_000_000
  const acc = (p: Partial<AccountMeta> = {}): AccountMeta => ({
    name: 'a',
    kind: 'oauth',
    enabled: true,
    fable: 'no',
    status: 'ok',
    addedAt: 0,
    fableCheckedAt: T,
    ...p
  })

  it('no-fable oauth account inside the week → skip the fable model', () => {
    expect(shouldSkipFable(acc(), T + FABLE_RETRY_MS - 1)).toBe(true)
  })

  it('week elapsed → fable retry is due (no skip)', () => {
    expect(shouldSkipFable(acc(), T + FABLE_RETRY_MS)).toBe(false)
  })

  it('fable yes/unknown, non-oauth, or a legacy row without the stamp → never skip (the stampless row bootstraps with one fable probe)', () => {
    expect(shouldSkipFable(acc({ fable: 'yes' }), T + 1)).toBe(false)
    expect(shouldSkipFable(acc({ fable: 'unknown' }), T + 1)).toBe(false)
    expect(shouldSkipFable(acc({ kind: 'apikey' }), T + 1)).toBe(false)
    expect(shouldSkipFable(acc({ fableCheckedAt: undefined }), T + 1)).toBe(false)
  })

  it('a stamp in the FUTURE (clock rollback / corrupt settings) reads as invalid → retry due, else the weekly fable retry never fires again', () => {
    expect(shouldSkipFable(acc({ fableCheckedAt: T + 60_000 }), T)).toBe(false)
  })
})

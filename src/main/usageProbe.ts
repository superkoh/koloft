import type { AccountKind, AccountMeta, ProbeErrorKind, UsageSnapshot } from '@shared/types'
import { GRACE, hardLimited } from '@shared/accountUsage'

export const D5 = 10_800
export const DW = 21_600
export { GRACE }
export const RAMP_LO = 0.7
export const RAMP_HI = 0.95
export const OI_WEIGHT = 1.25
export const EPS = 0.05

// CC§7
export const PROBE_MODEL = 'claude-fable-5'
export const FALLBACK_PROBE_MODEL = 'claude-sonnet-5'
export const CC_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."

export function disc(r: number, d: number, now: number): number {
  if (r <= 0) return 1.0
  const t = r - now
  if (t <= 0) return 0.0
  if (t >= d) return 1.0
  return t / d
}

export interface Score {
  s1: number
  s2: number
  s3: number
  tiebreak: number
  pen: number
  hardLimited: boolean
}

export type ScoreRoute = 'fable' | 'opus'

export function scoreSnapshot(u: UsageSnapshot, now: number, route: ScoreRoute): Score {
  const p5 = u.u5 * disc(u.r5, D5, now)
  const rampRaw = (u.u7 * disc(u.r7, DW, now) - RAMP_LO) / (RAMP_HI - RAMP_LO)
  const ramp = rampRaw < 0 ? 0 : rampRaw
  const oi = route === 'fable' ? u.uoi * disc(u.roi, DW, now) * OI_WEIGHT : 0

  const penFor = (status: string, r: number): number => {
    if (status !== 'rejected') return 0
    const t = r > now ? r - now : 0
    return Math.min(1, t / GRACE)
  }
  const pen = Math.max(penFor(u.s5, u.r5), penFor(u.s7, u.r7))

  const parts = [p5, ramp, oi].sort((a, b) => b - a)
  const weekReset = route === 'fable' ? u.roi : u.r7
  return {
    s1: parts[0] + pen,
    s2: parts[1],
    s3: parts[2],
    tiebreak: weekReset > now ? weekReset : 0,
    pen,
    hardLimited: hardLimited(u, now)
  }
}

export interface Candidate {
  name: string
  score: Score
}

export const RESET_TIE_S = DW

const tbOf = (c: Candidate): number => (c.score.tiebreak > 0 ? c.score.tiebreak : Infinity)

export function leximaxFinalists(cands: Candidate[]): Candidate[] {
  let survivors = cands
  for (const key of ['s1', 's2', 's3'] as const) {
    if (survivors.length <= 1) break
    const min = Math.min(...survivors.map((c) => c.score[key]))
    survivors = survivors.filter((c) => c.score[key] <= min + EPS)
  }
  if (survivors.length <= 1) return survivors
  const earliest = Math.min(...survivors.map(tbOf))
  return survivors.filter((c) => tbOf(c) <= earliest + RESET_TIE_S)
}

export interface ParsedHeaders {
  usage: UsageSnapshot
}

// CC§7
export function parseRatelimitHeaders(
  headers: Record<string, string>,
  at: number
): ParsedHeaders | null {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v.replace(/\r$/, '')
  const pre = 'anthropic-ratelimit-unified-'
  const num = (key: string): number => {
    const v = h[pre + key]
    const n = v === undefined ? NaN : Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const str = (key: string): string => h[pre + key] ?? '?'
  if (h[pre + '5h-utilization'] === undefined) return null
  return {
    usage: {
      u5: num('5h-utilization'),
      u7: num('7d-utilization'),
      uoi: num('7d_oi-utilization'),
      s5: str('5h-status'),
      s7: str('7d-status'),
      soi: str('7d_oi-status'),
      r5: num('5h-reset'),
      r7: num('7d-reset'),
      roi: num('7d_oi-reset'),
      overage: str('overage-status'),
      hasOi: h[pre + '7d_oi-utilization'] !== undefined,
      at
    }
  }
}

export type ProbeResult =
  { ok: true; usage?: UsageSnapshot; fable?: 'yes' | 'no' } | { ok: false; error: ProbeErrorKind }

export function probeBaseUrl(accountBase?: string): string | null {
  const override = process.env.KOLOFT_PROBE_BASE_URL
  if (override && override.length) return override.replace(/\/$/, '')
  if (process.env.KOLOFT_TEST_BACKGROUND === '1') return null
  if (accountBase && accountBase.length) return accountBase.replace(/\/$/, '')
  return 'https://api.anthropic.com'
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    out[k] = v
  })
  return out
}

interface RawProbe {
  status: number
  headers: Record<string, string>
  bodyText: string
}

async function postMessages(
  base: string,
  kind: AccountKind,
  secret: string,
  model: string,
  timeoutMs: number
): Promise<RawProbe> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01'
  }
  if (kind === 'oauth') {
    headers['Authorization'] = `Bearer ${secret}`
    headers['anthropic-beta'] = 'oauth-2025-04-20'
  } else if (kind === 'custom') {
    // CC§7
    headers['Authorization'] = `Bearer ${secret}`
  } else {
    headers['x-api-key'] = secret
  }
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      max_tokens: 1,
      // CC§7
      system: CC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'hi' }]
    })
  })
  let bodyText = ''
  try {
    bodyText = await res.text()
  } catch {}
  return { status: res.status, headers: headersToRecord(res.headers), bodyText }
}

function looksModelUnavailable(raw: RawProbe): boolean {
  if (raw.status === 404) return true
  if (raw.status !== 400) return false
  return /model/i.test(raw.bodyText)
}

export const FABLE_RETRY_MS = 7 * 24 * 3_600_000

export function shouldSkipFable(a: AccountMeta, now: number): boolean {
  const at = a.fableCheckedAt ?? 0
  return a.kind === 'oauth' && a.fable === 'no' && at <= now && now - at < FABLE_RETRY_MS
}

export async function probeAccount(
  kind: AccountKind,
  secret: string,
  opts: {
    timeoutMs: number
    now?: () => number
    baseUrl?: string
    model?: string
    skipFable?: boolean
  }
): Promise<ProbeResult> {
  const base = opts.baseUrl && kind === 'custom' ? probeBaseUrl(opts.baseUrl) : probeBaseUrl()
  if (!base) return { ok: false, error: 'network' }
  const now = opts.now ?? Date.now
  try {
    if (kind === 'apikey' || kind === 'custom') {
      const model = kind === 'custom' ? (opts.model ?? FALLBACK_PROBE_MODEL) : FALLBACK_PROBE_MODEL
      const raw = await postMessages(base, kind, secret, model, opts.timeoutMs)
      if (raw.status === 401 || raw.status === 403) return { ok: false, error: 'expired' }
      if (looksModelUnavailable(raw)) return { ok: false, error: 'model-unavailable' }
      if (raw.status >= 500) return { ok: false, error: 'network' }
      if (raw.status >= 400) return { ok: false, error: 'unknown' }
      return { ok: true }
    }
    let raw = await postMessages(
      base,
      kind,
      secret,
      opts.skipFable ? FALLBACK_PROBE_MODEL : PROBE_MODEL,
      opts.timeoutMs
    )
    if (raw.status === 401) return { ok: false, error: 'expired' }
    let fable: 'yes' | 'no' | undefined
    // CC§7
    let parsed = parseRatelimitHeaders(raw.headers, now())
    let fallbackReading = opts.skipFable === true
    if (!parsed && !opts.skipFable && raw.status >= 400 && raw.status < 500) {
      // CC§7
      if (raw.status === 400 || raw.status === 403 || raw.status === 404) fable = 'no'
      fallbackReading = true
      raw = await postMessages(base, kind, secret, FALLBACK_PROBE_MODEL, opts.timeoutMs)
      if (raw.status === 401) return { ok: false, error: 'expired' }
      parsed = parseRatelimitHeaders(raw.headers, now())
    }
    if (!parsed) return { ok: false, error: raw.status >= 500 ? 'network' : 'unknown' }
    if (!fallbackReading) {
      if (raw.status < 300) fable ??= parsed.usage.hasOi ? 'yes' : 'no'
      else if (parsed.usage.hasOi) fable ??= 'yes'
    }
    return { ok: true, usage: parsed.usage, fable }
  } catch {
    // PLATFORM§27
    return { ok: false, error: 'network' }
  }
}

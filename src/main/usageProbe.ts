import type { AccountKind, AccountMeta, ProbeErrorKind, UsageSnapshot } from '@shared/types'
import { GRACE, hardLimited } from '@shared/accountUsage'

/**
 * Probe + scoring for the account balancer. Scoring/selection are PURE functions — `now` is always a parameter,
 * never Date.now() — so the unit suite pins every formula with hand-computed values.
 *
 * Probe contract (§2.3): a max_tokens=1 POST to /v1/messages whose response headers
 * carry the server's exact utilization. The Claude Code system prompt is REQUIRED for
 * an OAuth token to be accepted at all; only per-bucket status is trusted (the
 * top-level unified-status follows the 7d_oi bucket under a fable probe and would
 * misreport a fable-full account as fully unavailable).
 */

// ---- constants (identical to the prototype) --------------------------------------
export const D5 = 10_800 // 5h-bucket reset-discount window (s)
export const DW = 21_600 // weekly buckets' discount window (s)
export { GRACE } // rejected-penalty ramp; also the hard-limit threshold (shared with the capsule)
export const RAMP_LO = 0.7
export const RAMP_HI = 0.95
export const OI_WEIGHT = 1.25
export const EPS = 0.05

export const PROBE_MODEL = 'claude-fable-5' // only fable probes return the 7d_oi bucket
export const FALLBACK_PROBE_MODEL = 'claude-sonnet-5' // usage re-probe for no-fable accounts
export const CC_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."

// ---- scoring (pure) --------------------------------------------------------------

/** Reset-time discount ∈ [0,1]. r missing/0 → 1.0 (conservative, no discount);
 *  reset already past → 0.0 (the window's data is void); linear inside `d`. */
export function disc(r: number, d: number, now: number): number {
  if (r <= 0) return 1.0
  const t = r - now
  if (t <= 0) return 0.0
  if (t >= d) return 1.0
  return t / d
}

export interface Score {
  /** components sorted descending, with the rejected penalty added to s1 AFTER sorting */
  s1: number
  s2: number
  s3: number
  /** final tie-break, ≤0 (missing) reading as +∞: the fable route breaks on the fable
   *  week's reset, the opus route on the 7d pool's. The opus route must never fall back
   *  to `roi` — that would readmit, through the tie-break, the dimension it just
   *  discarded. An ELAPSED reset is 0 here too: like disc(), it says the reading is
   *  void, and a void reading must not pin a stale pool to one account. */
  tiebreak: number
  /** the rejected penalty BEFORE sorting — the fable-host health gate reads it */
  pen: number
  /** rejected on 5h or 7d with reset ≥ GRACE away (≡ pen == 1.0). The paid-fallback
   *  trigger: a wall that clears in minutes is never worth switching to metered. */
  hardLimited: boolean
}

/** Which quota a launch will actually spend: 'fable' ranks by the included fable
 *  allowance too, 'opus' ignores it entirely (no host has any left to compare). */
export type ScoreRoute = 'fable' | 'opus'

export function scoreSnapshot(u: UsageSnapshot, now: number, route: ScoreRoute): Score {
  const p5 = u.u5 * disc(u.r5, D5, now)
  const rampRaw = (u.u7 * disc(u.r7, DW, now) - RAMP_LO) / (RAMP_HI - RAMP_LO)
  const ramp = rampRaw < 0 ? 0 : rampRaw // lower clamp ONLY — u7·f7=1.0 ⇒ ramp=1.2
  // the third slot stays occupied (by 0) on the opus route: dropping it would leave
  // parts[2] undefined and poison every downstream comparison with NaN
  const oi = route === 'fable' ? u.uoi * disc(u.roi, DW, now) * OI_WEIGHT : 0 // no upper clamp

  // rejected penalty: bucket status s5/s7 only (a full fable bucket is not a dead
  // account); pen scales with time-to-reset so an about-to-unblock account survives
  const penFor = (status: string, r: number): number => {
    if (status !== 'rejected') return 0
    const t = r > now ? r - now : 0
    return Math.min(1, t / GRACE)
  }
  const pen = Math.max(penFor(u.s5, u.r5), penFor(u.s7, u.r7))

  const parts = [p5, ramp, oi].sort((a, b) => b - a)
  const weekReset = route === 'fable' ? u.roi : u.r7
  return {
    s1: parts[0] + pen, // sort FIRST, then add pen — order is load-bearing
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

/** two weekly resets closer than this are "the same reset" for tie-breaking — the
 *  same window inside which disc() already treats a bucket as about to void */
export const RESET_TIE_S = DW

const tbOf = (c: Candidate): number => (c.score.tiebreak > 0 ? c.score.tiebreak : Infinity)

/**
 * eps-cascaded leximax (order-independent): per layer keep the survivor set within
 * [min, min+EPS] of the layer's global minimum; then keep only those whose weekly
 * reset (the route's own bucket, missing → +∞) is within RESET_TIE_S of the earliest.
 * One finalist = a clear pick (an idler, or the account whose quota voids soonest).
 * Several = indistinguishable on every layer AND resetting together — the picker
 * spreads launches over them so back-to-back sessions rotate instead of all landing
 * on whichever happens to sort first.
 */
export function leximaxFinalists(cands: Candidate[]): Candidate[] {
  let survivors = cands
  for (const key of ['s1', 's2', 's3'] as const) {
    if (survivors.length <= 1) break
    const min = Math.min(...survivors.map((c) => c.score[key]))
    survivors = survivors.filter((c) => c.score[key] <= min + EPS)
  }
  if (survivors.length <= 1) return survivors
  // earliest = +∞ (no live reset anywhere) keeps everyone: ∞ <= ∞ + d
  const earliest = Math.min(...survivors.map(tbOf))
  return survivors.filter((c) => tbOf(c) <= earliest + RESET_TIE_S)
}

// ---- response-header parsing ------------------------------------------------------

export interface ParsedHeaders {
  usage: UsageSnapshot
}

/** Parse the `anthropic-ratelimit-unified-*` headers. `u5` missing ⇒ probe failure
 *  (null). Deliberately NEVER reads the top-level `anthropic-ratelimit-unified-status`. */
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
      overage: str('overage-status'), // display only — never scored
      hasOi: h[pre + '7d_oi-utilization'] !== undefined,
      at
    }
  }
}

// ---- the probe request ------------------------------------------------------------

export type ProbeResult =
  { ok: true; usage?: UsageSnapshot; fable?: 'yes' | 'no' } | { ok: false; error: ProbeErrorKind }

/** Resolve the probe base URL. Under KOLOFT_TEST_BACKGROUND=1 a missing
 *  KOLOFT_PROBE_BASE_URL means REFUSE to touch the network — a test run that forgot its
 *  mock exercises the degradation path instead of burning real quota. */
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
    // matches what the CLI does with ANTHROPIC_AUTH_TOKEN — the shape these
    // compatible endpoints expect (no anthropic-beta: it is Anthropic-specific)
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
      // REQUIRED for OAuth tokens to be accepted on /v1/messages at all
      system: CC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'hi' }]
    })
  })
  let bodyText = ''
  try {
    bodyText = await res.text()
  } catch {
    /* headers are what we came for */
  }
  return { status: res.status, headers: headersToRecord(res.headers), bodyText }
}

function looksModelUnavailable(raw: RawProbe): boolean {
  if (raw.status === 404) return true
  if (raw.status !== 400) return false
  return /model/i.test(raw.bodyText)
}

export const FABLE_RETRY_MS = 7 * 24 * 3_600_000

/** §08 probe downgrade gate: a known no-fable oauth account's ROUTINE probe skips the
 *  fable model until the weekly retry is due. Explicit capability re-checks (add /
 *  re-auth) never come through here. */
export function shouldSkipFable(a: AccountMeta, now: number): boolean {
  // a missing stamp (pre- row) reads as "retry due" — one fable probe bootstraps
  // it. A stamp in the FUTURE (clock rollback / corrupt settings) is invalid data and
  // also reads as due, else the weekly retry could stall until the clock catches up.
  const at = a.fableCheckedAt ?? 0
  return a.kind === 'oauth' && a.fable === 'no' && at <= now && now - at < FABLE_RETRY_MS
}

/**
 * Probe one account. OAuth: fable model first (capability detection for free); on a
 * fable-specific failure, re-probe with the fallback model for plain usage.
 * API key: a verify-only call — API keys have no unified buckets, success means the
 * request was accepted (usage stays undefined, by design).
 * Failures map onto the closed ProbeErrorKind enum — raw error text never escapes.
 */
export async function probeAccount(
  kind: AccountKind,
  secret: string,
  opts: {
    timeoutMs: number
    now?: () => number
    baseUrl?: string
    model?: string
    /** oauth only: probe the fallback model directly and state NO fable capability —
     *  the §08 downgrade for accounts already known to have no fable allowance */
    skipFable?: boolean
  }
): Promise<ProbeResult> {
  // a custom endpoint brings its OWN host — the KOLOFT_PROBE_BASE_URL seam still wins in
  // tests so a spec never reaches a third-party server either
  const base = opts.baseUrl && kind === 'custom' ? probeBaseUrl(opts.baseUrl) : probeBaseUrl()
  if (!base) return { ok: false, error: 'network' }
  const now = opts.now ?? Date.now
  try {
    if (kind === 'apikey' || kind === 'custom') {
      // verify-only: neither kind exposes anthropic-ratelimit-unified-* buckets, so
      // "ok" means the endpoint accepted the credential — there is no usage to read
      const model = kind === 'custom' ? (opts.model ?? FALLBACK_PROBE_MODEL) : FALLBACK_PROBE_MODEL
      const raw = await postMessages(base, kind, secret, model, opts.timeoutMs)
      if (raw.status === 401 || raw.status === 403) return { ok: false, error: 'expired' }
      if (looksModelUnavailable(raw)) return { ok: false, error: 'model-unavailable' }
      if (raw.status >= 500) return { ok: false, error: 'network' }
      // any other rejection (credit exhaustion, endpoint-specific 4xx) is NOT a
      // verified credential — "ok" must mean the endpoint accepted the request
      if (raw.status >= 400) return { ok: false, error: 'unknown' }
      return { ok: true }
    }
    // oauth. skipFable (§08 downgrade for a known no-fable account) starts on the
    // fallback model directly and never re-probes or states capability.
    let raw = await postMessages(
      base,
      kind,
      secret,
      opts.skipFable ? FALLBACK_PROBE_MODEL : PROBE_MODEL,
      opts.timeoutMs
    )
    if (raw.status === 401) return { ok: false, error: 'expired' }
    let fable: 'yes' | 'no' | undefined
    // Headers FIRST, status second (② measured): non-2xx responses
    // carry NO anthropic-ratelimit-unified-* headers (404 bad-model + three real 400
    // shapes all bare), so usage after a fable-specific failure — 403 org restriction,
    // ZDR 400, model 404 — can only come from a fallback-model re-probe, and such a
    // failure must never evict the account from the opus pool. A non-2xx that DOES
    // carry headers (rate-limited shape) is a valid reading, not a fable failure.
    let parsed = parseRatelimitHeaders(raw.headers, now())
    // once the reading comes from the fallback model it cannot see the oi bucket, so
    // it must never be turned into a capability verdict
    let fallbackReading = opts.skipFable === true
    if (!parsed && !opts.skipFable && raw.status >= 400 && raw.status < 500) {
      // only DETERMINISTIC fable-specific shapes earn the week-long 'no' verdict; a
      // transient headerless 408/429 still gets the usage re-probe but no verdict
      if (raw.status === 400 || raw.status === 403 || raw.status === 404) fable = 'no'
      fallbackReading = true
      raw = await postMessages(base, kind, secret, FALLBACK_PROBE_MODEL, opts.timeoutMs)
      if (raw.status === 401) return { ok: false, error: 'expired' }
      parsed = parseRatelimitHeaders(raw.headers, now())
    }
    // 5xx (either probe) is transient server trouble, not a capability verdict; a 4xx
    // on BOTH probes is an account-level fault reported without touching `fable`
    if (!parsed) return { ok: false, error: raw.status >= 500 ? 'network' : 'unknown' }
    if (!fallbackReading) {
      // fail-closed on a CLEAN reading: a 2xx fable-model response always states the
      // capability — leaving it undefined makes the fold in index.ts a no-op, so a
      // plan that lost its included allowance would keep its 'yes' badge forever.
      // Whether non-2xx responses carry the oi trio is unmeasured, so an error
      // reading may only ever say 'yes' (oi seen), never 'no' (oi merely unseen).
      if (raw.status < 300) fable ??= parsed.usage.hasOi ? 'yes' : 'no'
      else if (parsed.usage.hasOi) fable ??= 'yes'
    }
    return { ok: true, usage: parsed.usage, fable }
  } catch {
    // timeouts, DNS, refused connections, malformed responses — all just 'network';
    // the error object may embed the Authorization header and must not leak
    return { ok: false, error: 'network' }
  }
}

import { describe, it, expect } from 'vitest'
import { UsageMeter } from '../../src/main/usageMeter'
import type { TranscriptRecord } from '../../src/main/transcriptRecord'

function asst(o: {
  id?: string
  req?: string
  model: string
  in: number
  out: number
  cw?: number
  cr?: number
  ts?: string
}): TranscriptRecord {
  return {
    type: 'assistant',
    requestId: o.req,
    timestamp: o.ts ?? new Date().toISOString(),
    message: {
      id: o.id,
      model: o.model,
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: o.in,
        output_tokens: o.out,
        cache_creation_input_tokens: o.cw ?? 0,
        cache_read_input_tokens: o.cr ?? 0
      }
    }
  }
}

function meterOf(records: TranscriptRecord[]): UsageMeter {
  const m = new UsageMeter()
  for (const r of records) m.add(r)
  return m
}

describe('UsageMeter — the spend and context one Claude Code session shows', () => {
  // CC§2
  it('dedups a usage record repeated by streaming (same id+requestId) — counts it once', () => {
    const rec = asst({
      id: 'msg_a',
      req: 'req_a',
      model: 'claude-opus-4-8',
      in: 100,
      out: 200,
      cw: 1000,
      cr: 5000
    })
    const u = meterOf([rec, rec, rec]).usage()!
    expect(u.inTok).toBe(100)
    expect(u.outTok).toBe(200)
    expect(u.cacheWriteTok).toBe(1000)
    expect(u.cacheReadTok).toBe(5000)
    expect(u.costUsd).toBeCloseTo((100 * 5 + 200 * 25 + 1000 * 6.25 + 5000 * 0.5) / 1_000_000, 10)
  })

  // CC§2
  it('books the largest count of a streamed call whose repeated lines grow, as a sub-agent transcript writes them', () => {
    const line = (out: number): TranscriptRecord =>
      asst({
        id: 'msg_g',
        req: 'req_g',
        model: 'claude-opus-4-8',
        in: 100,
        out,
        cw: 1000,
        cr: 5000
      })
    const u = meterOf([line(3), line(600), line(1231), line(1231)]).usage()!
    expect(u.inTok).toBe(100)
    expect(u.outTok).toBe(1231)
    expect(u.costUsd).toBeCloseTo((100 * 5 + 1231 * 25 + 1000 * 6.25 + 5000 * 0.5) / 1_000_000, 10)
  })

  it('counts id-less records every time — no false dedupe collapse', () => {
    const rec = asst({ model: 'claude-opus-4-8', in: 100, out: 0 })
    expect(meterOf([rec, rec]).usage()!.inTok).toBe(200)
  })

  it('unknown model → tokens present but NO cost (design D6: never a wrong $)', () => {
    const u = meterOf([
      asst({ id: 'm1', req: 'r1', model: 'totally-made-up-model', in: 10, out: 20 })
    ]).usage()!
    expect(u.inTok).toBe(10)
    expect(u.outTok).toBe(20)
    expect(u.costUsd).toBeUndefined()
    expect(u.todayCostUsd).toBeUndefined()
    expect(u.ctxPct).toBeUndefined()
  })

  it('skips <synthetic> records but still counts the real one', () => {
    const u = meterOf([
      asst({ id: 'syn', req: 'rs', model: '<synthetic>', in: 999, out: 999, cw: 999, cr: 999 }),
      asst({ id: 'm1', req: 'r1', model: 'claude-opus-4-8', in: 7, out: 8 })
    ]).usage()!
    expect(u.inTok).toBe(7)
    expect(u.outTok).toBe(8)
    expect(u.model).toBe('claude-opus-4-8')
  })

  it('context uses the LATEST record, not the first or the sum', () => {
    const u = meterOf([
      asst({ id: 'm1', req: 'r1', model: 'claude-opus-4-8', in: 10, out: 5, cr: 90_000 }),
      asst({ id: 'm2', req: 'r2', model: 'claude-opus-4-8', in: 10, out: 5, cr: 150_000 })
    ]).usage()!
    expect(u.ctxTokens).toBe(150_010)
    expect(u.ctxPct).toBeCloseTo(150_010 / 1_000_000, 6)
  })

  it("today's cost tracks only records on the current local calendar day", () => {
    const u = meterOf([
      asst({
        id: 'old',
        req: 'ro',
        model: 'claude-opus-4-8',
        in: 100,
        out: 100,
        ts: '2020-01-01T00:00:00.000Z'
      }),
      asst({ id: 'now', req: 'rn', model: 'claude-opus-4-8', in: 100, out: 100 })
    ]).usage()!
    const oneRec = (100 * 5 + 100 * 25) / 1_000_000
    expect(u.costUsd).toBeCloseTo(oneRec * 2, 10)
    expect(u.todayCostUsd).toBeCloseTo(oneRec, 10)
  })

  it('an out-of-order OLDER-dated record does not wipe today (#4)', () => {
    const u = meterOf([
      asst({ id: 'now', req: 'rn', model: 'claude-opus-4-8', in: 100, out: 100 }),
      asst({
        id: 'old',
        req: 'ro',
        model: 'claude-opus-4-8',
        in: 100,
        out: 100,
        ts: '2020-01-01T00:00:00.000Z'
      })
    ]).usage()!
    const oneRec = (100 * 5 + 100 * 25) / 1_000_000
    expect(u.todayCostUsd).toBeCloseTo(oneRec, 10)
    expect(u.costUsd).toBeCloseTo(oneRec * 2, 10)
    expect(u.todayDayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

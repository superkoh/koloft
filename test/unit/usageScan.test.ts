process.env.TZ = 'America/Los_Angeles'

import { describe, expect, it } from 'vitest'
import {
  protobufString,
  scanAgyLines,
  scanClaudeLines,
  scanCodexLines,
  scanMuseLines
} from '../../src/main/usageScan'

const S = 'sess-1'
const NOON = '2026-10-15T19:00:00.000Z'

function claudeLine(o: {
  out?: number
  inTok?: number
  id?: string
  req?: string
  model?: string
  ts?: string
  session?: string
  sidechain?: boolean
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: o.session ?? S,
    timestamp: o.ts ?? NOON,
    ...(o.req ? { requestId: o.req } : {}),
    ...(o.sidechain ? { isSidechain: true, agentId: 'agent-1' } : {}),
    message: {
      ...(o.id ? { id: o.id } : {}),
      model: o.model ?? 'claude-opus-5-5',
      usage: {
        input_tokens: o.inTok ?? 10,
        output_tokens: o.out ?? 5,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000
      }
    }
  })
}

const lines = (...l: string[]) => l.join('\n') + '\n'

describe('scanClaudeLines', () => {
  it('books one call whose lines grow at its largest count of each field', () => {
    const recs = scanClaudeLines(
      lines(
        claudeLine({ id: 'msg_1', req: 'req_1', out: 3, inTok: 12 }),
        claudeLine({ id: 'msg_1', req: 'req_1', out: 600, inTok: 10 }),
        claudeLine({ id: 'msg_1', req: 'req_1', out: 1231, inTok: 10 })
      )
    )
    expect(recs).toEqual([
      {
        sessionId: S,
        day: '2026-10-15',
        model: 'claude-opus-5-5',
        inTok: 12,
        outTok: 1231,
        cacheWriteTok: 100,
        cacheReadTok: 1000,
        surchargeUsd: 0
      }
    ])
  })

  it('counts a line with neither message id nor request id every time it appears', () => {
    const recs = scanClaudeLines(lines(claudeLine({ out: 5 }), claudeLine({ out: 5 })))
    expect(recs.map((r) => r.outTok)).toEqual([10])
  })

  it('skips a <synthetic> model line', () => {
    expect(scanClaudeLines(lines(claudeLine({ id: 'm', model: '<synthetic>' })))).toEqual([])
  })

  it('counts a sub-agent line, sidechain or in its own file, under the parent session it names', () => {
    const main = scanClaudeLines(
      lines(claudeLine({ id: 'main', out: 5 }), claudeLine({ id: 'side', out: 7, sidechain: true }))
    )
    const subAgentFile = scanClaudeLines(lines(claudeLine({ id: 'sub', out: 11, sidechain: true })))
    expect(main).toMatchObject([{ sessionId: S, outTok: 12 }])
    expect(subAgentFile).toMatchObject([{ sessionId: S, outTok: 11 }])
  })

  it('splits one session into a record per local day and per model', () => {
    const recs = scanClaudeLines(
      lines(
        claudeLine({ id: 'a', ts: '2026-10-16T03:00:00.000Z' }),
        claudeLine({ id: 'b', ts: '2026-10-16T19:00:00.000Z' }),
        claudeLine({ id: 'c', ts: '2026-10-16T20:00:00.000Z', model: 'claude-haiku-4-5' })
      )
    )
    expect(recs.map((r) => [r.day, r.model])).toEqual([
      ['2026-10-15', 'claude-opus-5-5'],
      ['2026-10-16', 'claude-opus-5-5'],
      ['2026-10-16', 'claude-haiku-4-5']
    ])
  })

  it('keeps the other calls of a file whose last line is cut off mid-write', () => {
    const text = lines(claudeLine({ id: 'a', out: 5 })) + claudeLine({ id: 'b' }).slice(0, 40)
    expect(scanClaudeLines(text).map((r) => r.outTok)).toEqual([5])
  })
})

const THREAD = 'thread-1'
const PARENT = 'thread-0'

function meta(id: string, source: unknown = 'vscode'): string {
  return JSON.stringify({
    timestamp: NOON,
    type: 'session_meta',
    payload: { id, cwd: '/repo', source }
  })
}

function turnContext(turn: string, model: string): string {
  return JSON.stringify({
    timestamp: NOON,
    type: 'turn_context',
    payload: { turn_id: turn, model }
  })
}

const usage = (n: number) => ({
  input_tokens: 1000 * n,
  cached_input_tokens: 800 * n,
  cache_write_input_tokens: 50 * n,
  output_tokens: 30 * n,
  reasoning_output_tokens: 20 * n,
  total_tokens: 1030 * n
})

function record(turn: string, response: string, n = 1): string {
  return JSON.stringify({
    timestamp: NOON,
    type: 'token_usage_record',
    payload: {
      thread_id: THREAD,
      turn_id: turn,
      response_id: response,
      usage: usage(n),
      turn_token_usage: usage(n * 10),
      thread_token_usage: usage(n * 100)
    }
  })
}

describe('scanCodexLines', () => {
  it('maps the four token fields the way the live usage frame is booked', () => {
    const scan = scanCodexLines(
      lines(meta(THREAD), turnContext('t1', 'gpt-6.1-sol'), record('t1', 'r1'))
    )
    expect(scan).toEqual({
      sessionId: THREAD,
      cwd: '/repo',
      records: [
        {
          sessionId: THREAD,
          day: '2026-10-15',
          model: 'gpt-6.1-sol',
          inTok: 200,
          cacheReadTok: 800,
          cacheWriteTok: 50,
          outTok: 30,
          surchargeUsd: 0
        }
      ]
    })
  })

  it('books the long-context surcharge per request, so two small requests summed into one record pay none', () => {
    const long = scanCodexLines(
      lines(meta(THREAD), turnContext('t1', 'gpt-6.1-sol'), record('t1', 'r1', 300))
    )
    const small = scanCodexLines(
      lines(
        meta(THREAD),
        turnContext('t1', 'gpt-6.1-sol'),
        record('t1', 'r1', 150),
        record('t1', 'r2', 150)
      )
    )
    expect(long?.records[0].surchargeUsd).toBeCloseTo(0.189, 6)
    expect(small?.records[0]).toMatchObject({ inTok: 60000, surchargeUsd: 0 })
  })

  it('books each request once by its response id and never the turn or thread running sums', () => {
    const scan = scanCodexLines(
      lines(
        meta(THREAD),
        turnContext('t1', 'gpt-6.1-sol'),
        record('t1', 'r1', 1),
        record('t1', 'r2', 2),
        record('t1', 'r2', 2)
      )
    )
    expect(scan?.records.map((r) => r.outTok)).toEqual([90])
  })

  it('prices each turn by its own turn_context model when the thread switches mid-way', () => {
    const scan = scanCodexLines(
      lines(
        meta(THREAD),
        turnContext('t1', 'gpt-6.1-sol'),
        record('t1', 'r1'),
        turnContext('t2', 'gpt-6-astra'),
        record('t2', 'r2', 2)
      )
    )
    expect(scan?.records.map((r) => [r.model, r.outTok])).toEqual([
      ['gpt-6.1-sol', 30],
      ['gpt-6-astra', 60]
    ])
  })

  it("folds a child agent's rollout into its parent thread, ignoring the parent's copied session_meta", () => {
    const child = { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } }
    const scan = scanCodexLines(
      lines(meta(THREAD, child), meta(PARENT), turnContext('t1', 'gpt-6.1-sol'), record('t1', 'r1'))
    )
    expect(scan?.sessionId).toBe(PARENT)
    expect(scan?.records.map((r) => r.sessionId)).toEqual([PARENT])
  })
})

function museLine(kind: string, usage: Record<string, number>, model = 'muse-model'): string {
  return JSON.stringify({
    recorded_at: Date.parse(NOON) * 1000,
    payload_type: 'runtime.session',
    payload: { kind: 'run', run_id: 'run-1', event: { kind, model, usage } }
  })
}

describe('scanMuseLines', () => {
  const u = {
    input_tokens: 1100,
    cached_tokens: 100,
    cache_read_tokens: 100,
    cache_write_tokens: 7,
    output_tokens: 11
  }

  it('books one model_completed record as one call and never its goal_usage_attribution copy', () => {
    const records = scanMuseLines(
      lines(museLine('model_completed', u), museLine('goal_usage_attribution', u)),
      'm1'
    )
    expect(records).toEqual([
      {
        sessionId: 'm1',
        day: '2026-10-15',
        model: 'muse-model',
        inTok: 1000,
        cacheReadTok: 100,
        cacheWriteTok: 7,
        outTok: 11,
        surchargeUsd: 0
      }
    ])
  })
})

function agyLine(type: string, tokens: { in: number; out: number; cache: number }): string {
  return JSON.stringify({
    type,
    created_at: '2026-10-15T19:00:00Z',
    input_tokens: tokens.in,
    output_tokens: tokens.out,
    cache_read_tokens: tokens.cache
  })
}

describe('scanAgyLines', () => {
  const call = { in: 100, out: 20, cache: 300 }

  it("prices the n-th call with the n-th gen_metadata model, and a call with no row at the conversation's configured model", () => {
    const records = scanAgyLines(
      lines(
        agyLine('USER_INPUT', { in: 0, out: 0, cache: 0 }),
        agyLine('PLANNER_RESPONSE', call),
        agyLine('GENERIC', call),
        agyLine('PLANNER_RESPONSE', call),
        agyLine('PLANNER_RESPONSE', call)
      ),
      'c1',
      ['gemini-3.1-pro', 'gemini-3.6-flash'],
      'gemini-3.1-pro'
    )
    expect(records.map((r) => [r.model, r.inTok, r.outTok, r.cacheReadTok])).toEqual([
      ['gemini-3.1-pro', 200, 40, 600],
      ['gemini-3.6-flash', 100, 20, 300]
    ])
  })
})

describe('protobufString', () => {
  it('finds a string down a field path, stepping over varint fields', () => {
    const model = [...Buffer.from('gemini-3.1-pro')]
    const inner = [0x9a, 0x01, model.length, ...model]
    const outer = Uint8Array.from([0x10, 0xac, 0x02, 0x0a, inner.length, ...inner])
    expect(protobufString(outer, [1, 19])).toBe('gemini-3.1-pro')
    expect(protobufString(outer, [1, 18])).toBeUndefined()
  })
})

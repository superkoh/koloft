import fs from 'fs'
import type { TokenCounts } from '@shared/pricing'
import type { UsageRecord } from '@shared/types'
import { localDayKey } from '@shared/usageFormat'
import { num, RecordsByDayAndModel } from '@agents/kit/main/usageLines'
import { stepOf } from './agyStore'

export const AGY_USAGE_WORDS = ['PLANNER_RESPONSE']

// AGY§8
export function scanAgyLines(
  text: string,
  sessionId: string,
  modelOfCall: string[],
  configuredModel: string
): UsageRecord[] {
  const out = new RecordsByDayAndModel()
  let call = 0
  for (const line of text.split('\n')) {
    const step = stepOf(line)
    if (step?.type !== 'PLANNER_RESPONSE') continue
    const model = modelOfCall[call++] || configuredModel
    const tokens: TokenCounts = {
      inTok: num(step.inputTokens),
      outTok: num(step.outputTokens),
      cacheReadTok: num(step.cacheReadTokens),
      cacheWriteTok: 0,
      cacheWrite1hTok: 0
    }
    if (!tokens.inTok && !tokens.outTok && !tokens.cacheReadTok) continue
    if (step.at) out.add(sessionId, localDayKey(step.at), model, tokens)
  }
  return out.list()
}

function varint(b: Uint8Array, at: number): [number, number] {
  let value = 0
  let scale = 1
  let i = at
  for (;;) {
    if (i >= b.length) return [NaN, i]
    const c = b[i++]
    value += (c & 0x7f) * scale
    if (c < 0x80) return [value, i]
    scale *= 128
  }
}

// AGY§8
export function protobufString(b: Uint8Array, fieldPath: number[]): string | undefined {
  let i = 0
  while (i < b.length) {
    const [key, afterKey] = varint(b, i)
    if (isNaN(key)) return undefined
    const field = Math.floor(key / 8)
    const wire = key % 8
    i = afterKey
    if (wire === 0) i = varint(b, i)[1]
    else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else if (wire === 2) {
      const [len, start] = varint(b, i)
      if (isNaN(len)) return undefined
      i = start + len
      if (field !== fieldPath[0]) continue
      const chunk = b.subarray(start, i)
      if (fieldPath.length === 1) return Buffer.from(chunk).toString('utf8')
      const inner = protobufString(chunk, fieldPath.slice(1))
      if (inner !== undefined) return inner
    } else return undefined
  }
  return undefined
}

const AGY_CALL_MODEL = [1, 19]
const AGY_CONFIGURED_MODEL = [10, 1, 28]

// AGY§8
export async function agyModels(db = ''): Promise<{ calls: string[]; configured: string }> {
  if (!fs.existsSync(db)) return { calls: [], configured: '' }
  const { DatabaseSync } = await import('node:sqlite')
  const sqlite = new DatabaseSync(db, { readOnly: true })
  try {
    const blobs = (table: string): Uint8Array[] =>
      (sqlite.prepare(`select data from ${table} order by idx`).all() as { data: unknown }[])
        .map((r) => r.data)
        .filter((d): d is Uint8Array => d instanceof Uint8Array)
    const configured = blobs('executor_metadata')
      .map((b) => protobufString(b, AGY_CONFIGURED_MODEL))
      .find(Boolean)
    return {
      calls: blobs('gen_metadata').map((b) => protobufString(b, AGY_CALL_MODEL) ?? ''),
      configured: configured ?? ''
    }
  } finally {
    sqlite.close()
  }
}

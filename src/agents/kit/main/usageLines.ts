import fs from 'fs'
import readline from 'readline'
import {
  longContextSurchargeUsd,
  TOKEN_FIELDS,
  type PriceList,
  type TokenCounts
} from '@shared/pricing'
import type { UsageRecord } from '@shared/types'

export function num(x: unknown): number {
  return typeof x === 'number' && isFinite(x) && x > 0 ? x : 0
}

export function topLevelTimestampOf(line: string): string | undefined {
  try {
    const at = JSON.parse(line).timestamp
    return typeof at === 'string' ? at : undefined
  } catch {
    return undefined
  }
}

export function parsedLines(text: string): any[] {
  const out: any[] = []
  for (const line of text.split('\n')) {
    try {
      out.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return out
}

export class RecordsByDayAndModel {
  private byKey = new Map<string, UsageRecord>()

  constructor(private readonly priceOf: PriceList) {}

  add(sessionId: string, day: string, model: string, call: TokenCounts): void {
    const pricing = this.priceOf(model)
    const surchargeUsd = pricing ? longContextSurchargeUsd(pricing, call) : 0
    const key = sessionId + '\n' + day + '\n' + model
    const rec = this.byKey.get(key)
    if (!rec) {
      this.byKey.set(key, { sessionId, day, model, ...call, surchargeUsd })
      return
    }
    for (const f of TOKEN_FIELDS) rec[f] += call[f]
    rec.surchargeUsd += surchargeUsd
  }

  list(): UsageRecord[] {
    return [...this.byKey.values()]
  }
}

export async function linesWithAny(
  file: string,
  words: string[],
  wantsStart = false
): Promise<{ text: string; bornAt?: string }> {
  const kept: string[] = []
  let bornAt: string | undefined
  let looking = wantsStart
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (looking && line.includes('"timestamp"')) {
      bornAt = topLevelTimestampOf(line)
      looking = bornAt === undefined
    }
    if (words.some((w) => line.includes(w))) kept.push(line)
  }
  return { text: kept.join('\n'), bornAt }
}

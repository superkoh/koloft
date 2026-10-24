import fs from 'fs'
import readline from 'readline'
import { parentPort, workerData } from 'worker_threads'
import {
  AGY_USAGE_WORDS,
  CLAUDE_USAGE_WORDS,
  CODEX_USAGE_WORDS,
  MUSE_USAGE_WORDS,
  protobufString,
  scanAgyLines,
  scanClaudeLines,
  scanCodexLines,
  scanMuseLines
} from './usageScan'
import type { ScannedFile, UsageFile } from './usageCache'

const AGY_CALL_MODEL = [1, 19]
const AGY_CONFIGURED_MODEL = [10, 1, 28]

async function linesWithAny(file: string, words: string[]): Promise<string> {
  const kept: string[] = []
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) if (words.some((w) => line.includes(w))) kept.push(line)
  return kept.join('\n')
}

async function claudeLines(file: string): Promise<{ text: string; bornAt?: string }> {
  const kept: string[] = []
  let bornAt: string | undefined
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (bornAt === undefined && line.includes('"timestamp"')) bornAt = timestampOf(line)
    if (CLAUDE_USAGE_WORDS.some((w) => line.includes(w))) kept.push(line)
  }
  return { text: kept.join('\n'), bornAt }
}

function timestampOf(line: string): string | undefined {
  try {
    const at = JSON.parse(line).timestamp
    return typeof at === 'string' ? at : undefined
  } catch {
    return undefined
  }
}

// AGY§8
async function agyModels(db = ''): Promise<{ calls: string[]; configured: string }> {
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

async function scan(f: UsageFile): Promise<Omit<ScannedFile, 'file'>> {
  const sessionId = f.sessionId ?? ''
  switch (f.backend) {
    case 'claude': {
      const { text, bornAt } = await claudeLines(f.file)
      return { records: scanClaudeLines(text, bornAt) }
    }
    case 'muse':
      return { records: scanMuseLines(await linesWithAny(f.file, MUSE_USAGE_WORDS), sessionId) }
    case 'agy': {
      const { calls, configured } = await agyModels(f.db)
      const text = await linesWithAny(f.file, AGY_USAGE_WORDS)
      return { records: scanAgyLines(text, sessionId, calls, configured) }
    }
    case 'codex': {
      const codex = scanCodexLines(await linesWithAny(f.file, CODEX_USAGE_WORDS))
      return { records: codex?.records ?? [], cwd: codex?.cwd }
    }
  }
}

async function scanAll(files: UsageFile[]): Promise<void> {
  for (const f of files) {
    let scanned: Omit<ScannedFile, 'file'>
    try {
      scanned = await scan(f)
    } catch (error) {
      console.error('[koloft] usage read failed, retried next read:', f.file, error)
      continue
    }
    parentPort?.postMessage({ file: f.file, ...scanned })
  }
}

void scanAll((workerData as { files: UsageFile[] }).files)

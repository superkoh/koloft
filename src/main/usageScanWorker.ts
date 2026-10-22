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

// AGY§8
async function agyModels(db: string): Promise<{ calls: string[]; configured: string }> {
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

async function scan(f: UsageFile): Promise<ScannedFile> {
  if (f.backend === 'claude')
    return {
      file: f.file,
      records: scanClaudeLines(await linesWithAny(f.file, CLAUDE_USAGE_WORDS))
    }
  if (f.backend === 'muse')
    return {
      file: f.file,
      records: scanMuseLines(await linesWithAny(f.file, MUSE_USAGE_WORDS), f.sessionId ?? '')
    }
  if (f.backend === 'agy') {
    const models = f.db ? await agyModels(f.db) : { calls: [], configured: '' }
    const text = await linesWithAny(f.file, AGY_USAGE_WORDS)
    return {
      file: f.file,
      records: scanAgyLines(text, f.sessionId ?? '', models.calls, models.configured)
    }
  }
  const codex = scanCodexLines(await linesWithAny(f.file, CODEX_USAGE_WORDS))
  return { file: f.file, records: codex?.records ?? [], cwd: codex?.cwd }
}

async function scanAll(files: UsageFile[]): Promise<void> {
  for (const f of files) {
    try {
      parentPort?.postMessage(await scan(f))
    } catch {
      continue
    }
  }
}

void scanAll((workerData as { files: UsageFile[] }).files)

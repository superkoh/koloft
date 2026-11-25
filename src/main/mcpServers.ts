import fs from 'fs'
import path from 'path'
import type { BackendId, McpServer } from '@shared/types'

export interface ConfigText {
  text: string | null
  onlyIn?: string
}

// CC§22
export function foldersUpToRoot(folder: string): string[] {
  const parent = path.dirname(folder)
  return parent === folder ? [folder] : [folder, ...foldersUpToRoot(parent)]
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function parsed(text: string | null): Record<string, unknown> {
  try {
    return asRecord(text === null ? null : JSON.parse(text))
  } catch {
    return {}
  }
}

export const turnedOn = (raw: unknown): [string, Record<string, unknown>][] =>
  Object.entries(asRecord(raw))
    .map(([name, entry]): [string, Record<string, unknown>] => [name, asRecord(entry)])
    .filter(([, entry]) => entry.disabled !== true)

export function listed(backend: BackendId, raw: unknown, onlyIn?: string): McpServer[] {
  return turnedOn(raw).map(([name]) => ({ name, backend, ...(onlyIn && { onlyIn }) }))
}

export function jsonServers(backend: BackendId, files: ConfigText[]): McpServer[] {
  return files.flatMap((f) => listed(backend, parsed(f.text).mcpServers, f.onlyIn))
}

export const textOrNull = (file: string): Promise<string | null> =>
  fs.promises.readFile(file, 'utf8').catch(() => null)

export interface FoldersOfOne {
  onlyIn: string
  folders: string[]
}

export const textsIn = (walks: FoldersOfOne[], file: string): Promise<ConfigText[]> =>
  Promise.all(
    walks.flatMap((w) =>
      w.folders.map(async (folder) => ({
        onlyIn: w.onlyIn,
        text: await textOrNull(path.join(folder, file))
      }))
    )
  )

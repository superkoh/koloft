import fs from 'fs'
import os from 'os'
import path from 'path'
import { writePrivateAtomically } from '@core/privateFile'
import { realpathSafe } from '../../../main/projectInfo'
import { record } from '@core/unknownValue'
import type { KoloftHook } from './codexLaunchConfig'
import {
  appendTable,
  folderTrustLevel,
  hookTrusted,
  projectHeader,
  tableEnd,
  withTrustedHash
} from './codexConfigTables.mjs'

export function codexConfigFile(env: NodeJS.ProcessEnv | undefined): string {
  return path.join(env?.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')
}

function readConfig(configFile: string): string {
  try {
    return fs.readFileSync(configFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return ''
  }
}

// CODEX§15 PLATFORM§43
function writeConfig(configFile: string, text: string): void {
  const target = realpathSafe(configFile)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  writePrivateAtomically(target, text)
}

// CODEX§11 ADR-0026
export function acceptCodexTrust(configFile: string, dir: string): void {
  joinProjectTables(configFile, `${projectHeader(fs.realpathSync(dir))}\ntrust_level = "trusted"\n`)
}

// CODEX§15 CODEX§27
export function joinProjectTables(configFile: string, from: string): void {
  const before = readConfig(configFile)
  let text = before
  const have = new Set(text.split(/\r?\n/).map((line) => line.trim()))
  const lines = from.split(/\r?\n/)
  for (let start = 0; start < lines.length; start++) {
    const header = lines[start].trim()
    if (!header.startsWith('[projects.') || have.has(header)) continue
    have.add(header)
    const end = tableEnd(lines, start)
    text = appendTable(text, `${lines.slice(start, end).join('\n').trimEnd()}\n`)
  }
  if (text !== before) writeConfig(configFile, text)
}

// CODEX§27
export function codexHookTrusted(configFile: string, key: string, hash: string): boolean {
  return hookTrusted(readConfig(configFile), key, hash)
}

export function acceptCodexHookTrust(configFile: string, key: string, hash: string): void {
  writeConfig(configFile, withTrustedHash(readConfig(configFile), key, hash))
}

// CODEX§11
export function codexTrustsFolder(configFile: string, dir: string): boolean {
  try {
    return configTrusts(fs.readFileSync(configFile, 'utf8'), fs.realpathSync(dir))
  } catch {
    return false
  }
}

// CODEX§11
export function configTrusts(text: string, realDir: string): boolean {
  return folderTrustLevel(text, realDir) === 'trusted'
}

export interface ListedHook {
  key: string
  command: string
  currentHash: string
  trustStatus: string
}

// CODEX§27
export function koloftHooksIn(reply: unknown, wanted: KoloftHook[]): ListedHook[] {
  const found: ListedHook[] = []
  const lists = record(reply).data
  for (const list of Array.isArray(lists) ? lists : []) {
    const hooks = record(list).hooks
    for (const raw of Array.isArray(hooks) ? hooks : []) {
      const hook = record(raw)
      if (
        hook.source === 'sessionFlags' &&
        wanted.some(
          (w) =>
            w.command === hook.command &&
            w.event.toLowerCase() === String(hook.eventName).toLowerCase()
        ) &&
        typeof hook.key === 'string' &&
        typeof hook.currentHash === 'string'
      )
        found.push({
          key: hook.key,
          command: String(hook.command),
          currentHash: hook.currentHash,
          trustStatus: String(hook.trustStatus)
        })
    }
  }
  return found
}

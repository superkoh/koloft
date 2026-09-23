import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { sanitizeLoadedSettings } from '@shared/settingsOps'
import { normalizeSessionMethods } from '@shared/sessionBackend'

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function writeAtomically(file: string, text: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export function loadSettings(): Settings {
  try {
    return sanitizeLoadedSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const merged: Settings = { ...loadSettings(), ...patch }
  merged.sessionMethods = normalizeSessionMethods(merged.sessionMethods)
  try {
    writeAtomically(settingsFile(), JSON.stringify(merged, null, 2))
  } catch {}
  return merged
}

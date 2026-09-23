import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { sanitizeLoadedSettings } from '@shared/settingsOps'
import { normalizeSessionMethods } from '@shared/sessionBackend'

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): Settings {
  try {
    // everything the file says is repaired in one shared place, so the same rules hold
    // wherever settings are read from disk
    return sanitizeLoadedSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const merged: Settings = { ...loadSettings(), ...patch }
  merged.sessionMethods = normalizeSessionMethods(merged.sessionMethods)
  // tmp + rename: settings.json is now the account registry — a crash mid-write must
  // not empty the pool while the Keychain entries linger orphaned
  try {
    const file = settingsFile()
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2))
    fs.renameSync(tmp, file)
  } catch {
    /* best effort */
  }
  return merged
}

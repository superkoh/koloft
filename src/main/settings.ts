import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { sanitizeLoadedSettings } from '@shared/settingsOps'
import { assistOnMethodsThatAreOn, sanitizeAssist } from '@shared/assistPicks'
import { normalizeSessionMethods } from '@shared/sessionBackend'
import { BackgroundFile } from './backgroundFile'

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

// PLATFORM§69
const settingsOnDisk = new BackgroundFile(settingsFile)

export function flushSettings(): void {
  settingsOnDisk.flushSync()
}

let cached: Settings | undefined

function readSettingsFile(): Settings {
  try {
    return sanitizeLoadedSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function loadSettings(): Settings {
  cached ??= readSettingsFile()
  return structuredClone(cached)
}

export function rereadSettingsOnNextLoad(): void {
  cached = undefined
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const merged: Settings = { ...loadSettings(), ...patch }
  merged.sessionMethods = normalizeSessionMethods(merged.sessionMethods)
  merged.assist = assistOnMethodsThatAreOn(sanitizeAssist(merged.assist), merged.sessionMethods)
  const text = JSON.stringify(merged, null, 2)
  settingsOnDisk.write(text)
  cached = sanitizeLoadedSettings(JSON.parse(text))
  return merged
}

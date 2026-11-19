import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS, sanitizeLoadedSettings } from '@shared/settingsOps'
import { assistOnMethodsThatAreOn, sanitizeAssist } from '@shared/assistPicks'
import { normalizeSessionMethods } from '@shared/sessionBackend'
import { knowSwitchesIn } from '@shared/pluginSwitches'
import { BackgroundFile } from './backgroundFile'

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

// PLATFORM§69
const settingsOnDisk = new BackgroundFile(settingsFile, undefined, () => rereadSettingsOnNextLoad())

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

let switchesChanged = (): void => {}

export function onSwitchesChanged(then: () => void): void {
  switchesChanged = then
}

function keep(settings: Settings): Settings {
  cached = settings
  if (knowSwitchesIn(settings)) switchesChanged()
  return settings
}

export function loadSettings(): Settings {
  return structuredClone(cached ?? keep(readSettingsFile()))
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
  keep(sanitizeLoadedSettings(JSON.parse(text)))
  return merged
}

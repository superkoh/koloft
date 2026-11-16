import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { PluginManifest } from '@core/plugin'
import { PLUGINS } from '@plugins/list'

const PLUGIN_FOLDERS = path.join(__dirname, '..', '..', 'src', 'plugins')

const byId = new Map(PLUGINS.map((p) => [p.id, p]))

function everythingNeededBy(id: string): Set<string> {
  const found = new Set<string>()
  const walk = (from: string): void => {
    for (const need of byId.get(from)?.needs ?? [])
      if (!found.has(need)) {
        found.add(need)
        walk(need)
      }
  }
  walk(id)
  return found
}

describe('the list of plugins', () => {
  it('holds the manifest of every plugin folder once, and each manifest carries its folder name as its id', async () => {
    const folders = fs
      .readdirSync(PLUGIN_FOLDERS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    expect(PLUGINS).toHaveLength(folders.length)
    for (const folder of folders) {
      const { plugin } = (await import(path.join(PLUGIN_FOLDERS, folder, 'plugin.ts'))) as {
        plugin: PluginManifest
      }
      expect(plugin.id).toBe(folder)
      expect(PLUGINS).toContain(plugin)
    }
  })

  it('a plugin needs only plugins on the list', () => {
    for (const p of PLUGINS)
      for (const need of p.needs) expect(byId.has(need), `${p.id} needs ${need}`).toBe(true)
  })

  it('a mandatory plugin needs only mandatory plugins, so turning one off never takes it down', () => {
    for (const p of PLUGINS.filter((q) => q.mandatory))
      for (const need of p.needs)
        expect(byId.get(need)?.mandatory, `${p.id} needs ${need}`).toBe(true)
  })

  it('no plugin needs itself, directly or through other plugins', () => {
    for (const p of PLUGINS) expect(everythingNeededBy(p.id).has(p.id), p.id).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { PluginManifest } from '@core/plugin'
import { PLUGINS } from '@plugins/list'

const PLUGIN_FOLDERS = path.join(__dirname, '..', '..', 'src', 'plugins')

const byId = new Map(PLUGINS.map((p) => [p.id, p]))
const place = new Map(PLUGINS.map((p, i) => [p.id, i]))

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

  it('lists every plugin after all the plugins it needs, so none needs itself and going down the list never meets a missing one', () => {
    for (const p of PLUGINS)
      for (const need of p.needs)
        expect(place.get(need) ?? Infinity, `${p.id} needs ${need}`).toBeLessThan(place.get(p.id)!)
  })

  it('a mandatory plugin needs only mandatory plugins, so turning one off never takes it down', () => {
    for (const p of PLUGINS.filter((q) => q.mandatory))
      for (const need of p.needs)
        expect(byId.get(need)?.mandatory, `${p.id} needs ${need}`).toBe(true)
  })

  it('no two Assist jobs share an id, and none takes the butler row’s, since the owner’s pick is saved under it', () => {
    const ids = [...PLUGINS.flatMap((p) => p.assistJobs ?? []).map((j) => j.id), 'butler']
    expect(new Set(ids).size).toBe(ids.length)
  })
})

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { PLUGINS } from '@plugins/list'

const PLUGIN_FOLDERS = path.join(__dirname, '..', '..', 'src', 'plugins')

const byId = new Map(PLUGINS.map((p) => [p.id, p]))

describe('the list of plugins', () => {
  it('names every plugin folder once, each under its own id', () => {
    const folders = fs
      .readdirSync(PLUGIN_FOLDERS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect(PLUGINS.map((p) => p.id).sort()).toEqual(folders)
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
    const reaches = (from: string, seen: Set<string>): boolean =>
      (byId.get(from)?.needs ?? []).some((n) => seen.has(n) || reaches(n, new Set([...seen, n])))
    for (const p of PLUGINS) expect(reaches(p.id, new Set([p.id])), p.id).toBe(false)
  })
})

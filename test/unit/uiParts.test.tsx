// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import type { PluginManifest, UiEntry } from '@core/plugin'
import { PLUGIN_FORMAT_VERSION } from '@core/plugin'
import { placeUi, type UiParts } from '@core/ui'
import { PLUGINS } from '@plugins/list'
import { partsByPlugin } from '../../src/renderer/src/pluginUi'

const manifest = (id: string, ui: UiEntry[]): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id,
  mandatory: true,
  needs: [],
  ui
})

const Part = (): null => null
const Other = (): null => null

describe('UI parts a plugin registers', () => {
  it('a plugin registers only the parts its manifest lists, each one, and no id twice', () => {
    const a = manifest('a', [{ place: 'dialog', id: 'one' }])
    expect(() => placeUi([a], () => ({ one: Part, two: Part }))).toThrow()
    expect(() => placeUi([a], () => ({}))).toThrow()
    const b = manifest('b', [{ place: 'sidebar-row', id: 'one' }])
    expect(() => placeUi([a, b], () => ({ one: Part }))).toThrow()
  })

  it('places each part at its place, in the order of the list of plugins', () => {
    const parts: Record<string, UiParts> = { a: { one: Part }, b: { two: Other, three: Part } }
    const placed = placeUi(
      [
        manifest('a', [{ place: 'dialog', id: 'one' }]),
        manifest('b', [
          { place: 'centre-page', id: 'two' },
          { place: 'dialog', id: 'three' }
        ])
      ],
      (id) => parts[id]
    )
    expect(placed.dialog).toEqual([
      { id: 'one', Part },
      { id: 'three', Part }
    ])
    expect(placed['centre-page']).toEqual([{ id: 'two', Part: Other }])
  })

  it('finds the renderer/ui.tsx of every plugin on the list that lists UI, and none of a folder off the list', () => {
    const ids = PLUGINS.map((p) => p.id)
    for (const found of partsByPlugin.keys()) expect(ids).toContain(found)
    for (const p of PLUGINS.filter((q) => q.ui?.length))
      expect(Object.keys(partsByPlugin.get(p.id) ?? {}).sort(), p.id).toEqual(
        p.ui!.map((e) => e.id).sort()
      )
  })
})

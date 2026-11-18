// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { PluginManifest, UiEntry } from '@core/plugin'
import { PLUGIN_FORMAT_VERSION } from '@core/plugin'
import { placeUi, type UiParts } from '@core/ui'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_UIS } from '@plugins/uis'
import '../../src/renderer/src/pluginUi'

const manifest = (id: string, ui: UiEntry[]): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id,
  mandatory: true,
  needs: [],
  ui
})

const PLUGIN_FOLDERS = path.join(__dirname, '..', '..', 'src', 'plugins')

const Part = (): null => null
const Other = (): null => null

describe('UI parts a plugin registers', () => {
  it('a plugin registers only the parts its manifest lists, each one, no id twice, and only for a plugin on the list', () => {
    const a = manifest('a', [{ place: 'dialog', id: 'one' }])
    expect(() => placeUi([a], { a: { one: Part, two: Part } })).toThrow(
      'plugin a registers "two", which its manifest does not list'
    )
    expect(() => placeUi([a], { a: {} })).toThrow('plugin a lists "one" but registers no part')
    const b = manifest('b', [{ place: 'sidebar-row', id: 'one' }])
    expect(() => placeUi([a, b], { a: { one: Part }, b: { one: Part } })).toThrow(
      '"one" is listed twice'
    )
    expect(() => placeUi([a], { a: { one: Part }, c: {} })).toThrow(
      '"c", which is not on the list of plugins'
    )
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
      parts
    )
    expect(placed.dialog).toEqual([
      { id: 'one', Part },
      { id: 'three', Part }
    ])
    expect(placed['centre-page']).toEqual([{ id: 'two', Part: Other }])
  })

  it('the list of UIs holds the renderer/ui.tsx of every plugin folder that has one, keyed by its id, and each holds the parts its manifest lists', () => {
    const withUi = fs
      .readdirSync(PLUGIN_FOLDERS)
      .filter((id) => fs.existsSync(path.join(PLUGIN_FOLDERS, id, 'renderer', 'ui.tsx')))
    expect(Object.keys(PLUGIN_UIS).sort()).toEqual(withUi.sort())
    for (const p of PLUGINS.filter((q) => q.ui?.length))
      expect(Object.keys(PLUGIN_UIS[p.id] ?? {}).sort(), p.id).toEqual(
        p.ui!.map((e) => e.id).sort()
      )
  })
})

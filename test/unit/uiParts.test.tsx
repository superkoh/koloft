// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { PluginManifest, UiEntry } from '@core/plugin'
import { PLUGIN_FORMAT_VERSION } from '@core/plugin'
import { fill, placeUi, slot, type PluginUi } from '@core/ui'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_UIS } from '@plugins/uis'
import { PLUGIN_PALETTE_ACTIONS } from '@shared/paletteFeatures'
import { PLUGIN_ROUTE_KINDS } from '@shared/sessionRoute'
import {
  PALETTE_HAND_OFF,
  PALETTE_ROUTE,
  PALETTE_RUN,
  ROW_EXTRAS,
  ROW_SET_UP,
  SETTINGS_PAGE_ICON,
  type PaletteRun,
  type RowExtrasFill,
  type RowSetUpFill,
  type SettingsPageIcon
} from '../../src/renderer/src/slots'

const listedAt = (place: UiEntry['place']): string[] =>
  PLUGINS.flatMap((p) => (p.ui ?? []).filter((e) => e.place === place).map((e) => e.id))

const manifest = (id: string, ui: UiEntry[] = []): PluginManifest => ({
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
    expect(() => placeUi([a], { a: { parts: { one: Part, two: Part } } })).toThrow(
      'plugin a registers "two", which its manifest does not list'
    )
    expect(() => placeUi([a], { a: {} })).toThrow('plugin a lists "one" but registers no part')
    const b = manifest('b', [{ place: 'sidebar-row', id: 'one' }])
    expect(() =>
      placeUi([a, b], { a: { parts: { one: Part } }, b: { parts: { one: Part } } })
    ).toThrow('"one" is listed twice')
    expect(() => placeUi([a], { a: { parts: { one: Part } }, c: {} })).toThrow(
      '"c", which is not on the list of plugins'
    )
  })

  it('places each part at its place, in the order of the list of plugins', () => {
    const uis: Record<string, PluginUi> = {
      a: { parts: { one: Part } },
      b: { parts: { two: Other, three: Part } }
    }
    const placed = placeUi(
      [
        manifest('a', [{ place: 'dialog', id: 'one' }]),
        manifest('b', [
          { place: 'centre-page', id: 'two' },
          { place: 'dialog', id: 'three' }
        ])
      ],
      uis
    )
    expect(placed.parts.dialog).toEqual([
      { id: 'one', Part },
      { id: 'three', Part }
    ])
    expect(placed.parts['centre-page']).toEqual([{ id: 'two', Part: Other }])
  })

  it('gives a slot what each plugin fills it with, in the order of the list of plugins, and nothing another slot got', () => {
    const words = slot<string>('words')
    const counts = slot<number>('counts')
    const placed = placeUi([manifest('a'), manifest('b')], {
      b: { fills: [fill(words, 'from b'), fill(counts, 2)] },
      a: { fills: [fill(words, 'from a')] }
    })
    expect(placed.fillsOf(words)).toEqual(['from a', 'from b'])
    expect(placed.fillsOf(counts)).toEqual([2])
  })

  it('every row a plugin adds menu entries and a line to is a sidebar row some plugin lists', () => {
    const rows = listedAt('sidebar-row')
    const filled = Object.values(PLUGIN_UIS).flatMap((ui) =>
      (ui.fills ?? [])
        .filter((f) => f.slot === ROW_EXTRAS)
        .map((f) => (f.value as RowExtrasFill).row)
    )
    expect(filled.length).toBeGreaterThan(0)
    for (const row of filled) expect(rows).toContain(row)
    const setUp = Object.values(PLUGIN_UIS).flatMap((ui) =>
      (ui.fills ?? [])
        .filter((f) => f.slot === ROW_SET_UP)
        .map((f) => (f.value as RowSetUpFill).row)
    )
    for (const row of setUp) expect(rows).toContain(row)
  })

  it('every settings page a plugin lists has exactly one icon, and every icon is for a settings page some plugin lists', () => {
    const pages = listedAt('settings-page')
    const iconed = Object.values(PLUGIN_UIS).flatMap((ui) =>
      (ui.fills ?? [])
        .filter((f) => f.slot === SETTINGS_PAGE_ICON)
        .map((f) => (f.value as SettingsPageIcon).page)
    )
    expect(pages.length).toBeGreaterThan(0)
    expect([...iconed].sort()).toEqual([...pages].sort())
  })

  it('the list of UIs holds the renderer/ui.tsx of every plugin folder that has one, keyed by its id, and each holds the parts its manifest lists', () => {
    const withUi = fs
      .readdirSync(PLUGIN_FOLDERS)
      .filter((id) => fs.existsSync(path.join(PLUGIN_FOLDERS, id, 'renderer', 'ui.tsx')))
    expect(Object.keys(PLUGIN_UIS).sort()).toEqual(withUi.sort())
    expect(() => placeUi(PLUGINS, PLUGIN_UIS)).not.toThrow()
    for (const p of PLUGINS.filter((q) => q.ui?.length))
      expect(Object.keys(PLUGIN_UIS[p.id]?.parts ?? {}).sort(), p.id).toEqual(
        p
          .ui!.filter((e) => e.place !== 'palette-item')
          .map((e) => e.id)
          .sort()
      )
  })

  it('every ⌘P item a plugin runs is listed by its manifest, is one the palette leaves to plugins, and has exactly one runner', () => {
    const run = Object.values(PLUGIN_UIS).flatMap((ui) =>
      (ui.fills ?? []).filter((f) => f.slot === PALETTE_RUN).map((f) => (f.value as PaletteRun).key)
    )
    expect(run.sort()).toEqual([...PLUGIN_PALETTE_ACTIONS].sort())
    expect(listedAt('palette-item').sort()).toEqual([...PLUGIN_PALETTE_ACTIONS].sort())
  })

  it('exactly one plugin takes the ⌘P words core cannot route itself, and each route kind core leaves to plugins has exactly one taker', () => {
    const placed = placeUi(PLUGINS, PLUGIN_UIS)
    expect(placed.fillsOf(PALETTE_HAND_OFF)).toHaveLength(1)
    expect(
      placed
        .fillsOf(PALETTE_ROUTE)
        .map((r) => r.kind)
        .sort()
    ).toEqual([...PLUGIN_ROUTE_KINDS].sort())
  })
})

// ADR-0051
import type { ComponentType } from 'react'
import type { PluginManifest, UiPlace } from './plugin'

export type UiParts = Readonly<Record<string, ComponentType>>

const ACTION_PLACE: UiPlace = 'palette-item'

export interface Slot<T> {
  name: string
  filledWith?: T
}

export const slot = <T>(name: string): Slot<T> => ({ name })

export interface SlotFill {
  slot: Slot<unknown>
  value: unknown
}

export const fill = <T>(into: Slot<T>, value: T): SlotFill => ({ slot: into, value })

export interface PluginUi {
  parts?: UiParts
  fills?: readonly SlotFill[]
}

export interface PlacedPart {
  id: string
  plugin: string
  Part: ComponentType
}

export type PluginOn = (plugin: string) => boolean

const EVERY_PLUGIN: PluginOn = () => true

export interface PlacedUi {
  parts: Readonly<Partial<Record<UiPlace, readonly PlacedPart[]>>>
  fillsOf: <T>(into: Slot<T>, on?: PluginOn) => readonly T[]
}

export function placeUi(
  plugins: readonly PluginManifest[],
  uis: Readonly<Record<string, PluginUi>>
): PlacedUi {
  for (const id of Object.keys(uis))
    if (!plugins.some((p) => p.id === id))
      throw new Error(`UI parts are given for "${id}", which is not on the list of plugins`)
  const placed: Partial<Record<UiPlace, PlacedPart[]>> = {}
  const fills: (SlotFill & { plugin: string })[] = []
  const taken = new Set<string>()
  for (const plugin of plugins) {
    const parts = uis[plugin.id]?.parts ?? {}
    const declared = plugin.ui ?? []
    for (const id of Object.keys(parts))
      if (!declared.some((entry) => entry.id === id))
        throw new Error(`plugin ${plugin.id} registers "${id}", which its manifest does not list`)
    for (const { place, id } of declared) {
      if (taken.has(id)) throw new Error(`"${id}" is listed twice`)
      taken.add(id)
      if (place === ACTION_PLACE) continue
      const Part = parts[id]
      if (!Part) throw new Error(`plugin ${plugin.id} lists "${id}" but registers no part for it`)
      ;(placed[place] ??= []).push({ id, plugin: plugin.id, Part })
    }
    fills.push(...(uis[plugin.id]?.fills ?? []).map((f) => ({ ...f, plugin: plugin.id })))
  }
  const bySlot = new Map<Slot<unknown>, { plugin: string; value: unknown }[]>()
  for (const { slot: into, plugin, value } of fills)
    bySlot.set(into, [...(bySlot.get(into) ?? []), { plugin, value }])
  return {
    parts: placed,
    fillsOf: <T>(into: Slot<T>, on: PluginOn = EVERY_PLUGIN) =>
      (bySlot.get(into) ?? []).filter((f) => on(f.plugin)).map((f) => f.value as T)
  }
}

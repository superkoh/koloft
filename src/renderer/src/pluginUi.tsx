// ADR-0051
import type { JSX } from 'react'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_UIS } from '@plugins/uis'
import type { UiPlace } from '@core/plugin'
import { placeUi, type PlacedPart, type PlacedUi, type Slot } from '@core/ui'
import { keepWorkspacesOutOfTheList, landAfterClosingAWatchedSession, useStore } from './store'
import {
  GLOBAL_NOTE,
  LANDING_AFTER_CLOSE,
  WORKSPACE_CLAIM,
  WORKSPACE_GIT_PART,
  type WorkspaceGitPart
} from './slots'
import type { Settings, WorkspaceRows } from '@shared/types'
import type { PluginState } from '@core/switches'
import { pluginStatesIn } from '@shared/pluginSwitches'

let placedOnce: PlacedUi | undefined

function placed(): PlacedUi {
  if (placedOnce) return placedOnce
  placedOnce = placeUi(PLUGINS, PLUGIN_UIS)
  const [landing] = placedOnce.fillsOf(LANDING_AFTER_CLOSE)
  if (landing) landAfterClosingAWatchedSession(landing)
  const claims = placedOnce.fillsOf(WORKSPACE_CLAIM)
  keepWorkspacesOutOfTheList((w) => claims.some((claim) => claim(w)))
  return placedOnce
}

export function placePluginUi(): void {
  placed()
}

interface ActingStates {
  settings: Settings
  states: Record<string, PluginState>
  onKey: string
}

let statesFor: ActingStates | undefined

function actingStatesOf(settings: Settings): ActingStates {
  if (statesFor?.settings === settings) return statesFor
  const states = pluginStatesIn(settings)
  const onKey = Object.keys(states)
    .filter((id) => states[id].on)
    .join(' ')
  return (statesFor = { settings, states, onKey })
}

const onIn =
  (settings: Settings) =>
  (plugin: string): boolean =>
    actingStatesOf(settings).states[plugin]?.on ?? true

const onNow = (plugin: string): boolean => onIn(useStore.getState().settings)(plugin)

export const fillsOf = <T,>(into: Slot<T>, settings?: Settings): readonly T[] =>
  placed().fillsOf(into, settings ? onIn(settings) : onNow)

export const fillsOfOnOrOff = <T,>(into: Slot<T>): readonly T[] => placed().fillsOf(into)

const KEPT_WHILE_OFF: ReadonlySet<UiPlace> = new Set(['settings-page'])

export const partsAt = (place: UiPlace): readonly PlacedPart[] =>
  (placed().parts[place] ?? []).filter((p) => KEPT_WHILE_OFF.has(place) || onNow(p.plugin))

const usePluginsOnKey = (): string => useStore((s) => actingStatesOf(s.settings).onKey)

export function useFillsOf<T, R>(
  into: Slot<T>,
  use: (fill: T, on: boolean) => R
): (R | undefined)[] {
  usePluginsOnKey()
  const on = new Set(fillsOf(into))
  return fillsOfOnOrOff(into).map((fill) => {
    const result = use(fill, on.has(fill))
    return on.has(fill) ? result : undefined
  })
}

export const gitPartsOf = (ws: WorkspaceRows['workspace']): readonly WorkspaceGitPart[] =>
  fillsOf(WORKSPACE_GIT_PART).filter((part) => part.shows(ws))

export function useShowsGlobalNote(tabId: string | null, rowId: string | null): boolean {
  return fillsOf(GLOBAL_NOTE)
    .map((shows) => shows(tabId, rowId))
    .some(Boolean)
}

export function PartsAt({ place }: { place: UiPlace }): JSX.Element {
  usePluginsOnKey()
  return (
    <>
      {partsAt(place).map(({ id, Part }) => (
        <Part key={id} />
      ))}
    </>
  )
}

export function OpenCentrePage(): JSX.Element | null {
  usePluginsOnKey()
  const open = useStore((s) => s.centrePage)
  const page = partsAt('centre-page').find((p) => p.id === open)
  return page ? <page.Part /> : null
}

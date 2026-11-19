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
import { actingStatesIn } from '@shared/pluginSwitches'

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

let statesFor: { settings: Settings; states: Record<string, PluginState> } | undefined

function actingStatesOf(settings: Settings): Record<string, PluginState> {
  if (statesFor?.settings !== settings) statesFor = { settings, states: actingStatesIn(settings) }
  return statesFor.states
}

const onIn =
  (settings: Settings) =>
  (plugin: string): boolean =>
    actingStatesOf(settings)[plugin]?.on ?? true

const onNow = (plugin: string): boolean => onIn(useStore.getState().settings)(plugin)

export const fillsOf = <T,>(into: Slot<T>, settings?: Settings): readonly T[] =>
  placed().fillsOf(into, settings ? onIn(settings) : onNow)

export const fillsOfOnOrOff = <T,>(into: Slot<T>): readonly T[] => placed().fillsOf(into)

const KEPT_WHILE_OFF: ReadonlySet<UiPlace> = new Set(['settings-page'])

export const partsAt = (place: UiPlace): readonly PlacedPart[] =>
  (placed().parts[place] ?? []).filter((p) => KEPT_WHILE_OFF.has(place) || onNow(p.plugin))

const usePluginsOnKey = (): string =>
  useStore((s) =>
    Object.entries(actingStatesOf(s.settings))
      .filter(([, state]) => state.on)
      .map(([id]) => id)
      .join(' ')
  )

export const gitPartsOf = (ws: WorkspaceRows['workspace']): readonly WorkspaceGitPart[] =>
  fillsOf(WORKSPACE_GIT_PART).filter((part) => part.shows(ws))

export function useShowsGlobalNote(tabId: string | null, rowId: string | null): boolean {
  return fillsOf(GLOBAL_NOTE)
    .map((shows) => shows(tabId, rowId))
    .some(Boolean)
}

export function PartsAt({ place }: { place: UiPlace }): JSX.Element {
  const onKey = usePluginsOnKey()
  return (
    <>
      {partsAt(place).map(({ id, Part }) => (
        <Part key={`${id} ${onKey}`} />
      ))}
    </>
  )
}

export function OpenCentrePage(): JSX.Element | null {
  const open = useStore((s) => s.centrePage)
  const page = partsAt('centre-page').find((p) => p.id === open)
  return page ? <page.Part /> : null
}

// ADR-0051
import type { JSX } from 'react'
import { PLUGINS } from '@plugins/list'
import type { UiPlace } from '@core/plugin'
import { placeUi, type UiParts } from '@core/ui'
import { useStore } from './store'

const PLUGIN_OF_UI_FILE = /\/plugins\/([^/]+)\/renderer\/ui\.tsx$/

const uiFiles = import.meta.glob<UiParts>('../../plugins/*/renderer/ui.tsx', {
  eager: true,
  import: 'ui'
})

export const partsByPlugin = new Map(
  Object.entries(uiFiles).map(([file, parts]) => [PLUGIN_OF_UI_FILE.exec(file)![1], parts])
)

const PLACED = placeUi(PLUGINS, (id) => partsByPlugin.get(id))

export function PartsAt({ place }: { place: UiPlace }): JSX.Element {
  return (
    <>
      {(PLACED[place] ?? []).map(({ id, Part }) => (
        <Part key={id} />
      ))}
    </>
  )
}

export function OpenCentrePage(): JSX.Element | null {
  const open = useStore((s) => s.centrePage)
  const page = PLACED['centre-page']?.find((p) => p.id === open)
  return page ? <page.Part /> : null
}

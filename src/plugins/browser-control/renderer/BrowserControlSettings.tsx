import type { JSX } from 'react'
import { Switch } from '@renderer/components/settings/Switch'
import { useSettingsUpdate } from '@renderer/components/settings/useSettingsUpdate'
import { useStore } from '@renderer/store'
import { SESSION_BACKENDS, shortProductList, whenAny } from '@shared/sessionBackend'
import { reachesTheWorkbenchBrowserOverSsh } from '../skill/text'

const OVER_SSH = whenAny(
  shortProductList(SESSION_BACKENDS.filter(reachesTheWorkbenchBrowserOverSsh), 'and'),
  (products) =>
    `${products} sessions on another machine (over SSH) can drive it too, but never open this Mac's files or its local web servers. `
)

export function BrowserControlSettings(): JSX.Element {
  const browserControl = useStore((s) => s.settings.browserControl)
  const update = useSettingsUpdate()
  return (
    // PLATFORM§17
    <div className="set-row">
      <div className="set-lab">
        <b>Let agents drive this Browser</b>
        <small>{`A session's agent can open and drive pages here instead of launching a browser of its own. Connected tools drive this Browser right away; nothing is asked. They get the pages you can see, signed in as you. ${OVER_SSH}Turning this off disconnects anything connected right now.`}</small>
      </div>
      <Switch checked={browserControl} onChange={(on) => update({ browserControl: on })} />
    </div>
  )
}

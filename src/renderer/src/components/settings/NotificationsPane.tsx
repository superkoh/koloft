import type { JSX } from 'react'
import { useStore } from '../../store'
import { Switch } from './Switch'
import { useSettingsUpdate } from './useSettingsUpdate'

/** Notifications (D3) — three categories, an indented approval-sound child,
 *  and the Dock badge. Defaults: all categories on, muted. "Only send an OS
 *  notification when the window is in the background" is fixed logic, not a setting
 *  (design M3). FR-10: the sound child is DISABLED while its parent is off — the
 *  dimming says it, no extra label. */
export function NotificationsPane(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const update = useSettingsUpdate()

  return (
    <>
      <div className="set-ph">
        <h3>Notifications</h3>
        <p>Sent only while Koloft is in the background — on screen, the session dot says it.</p>
      </div>

      <div className="set-row">
        <div className="set-lab">
          <b>Turn complete (turn-done)</b>
          <small>A session finished its turn.</small>
        </div>
        <Switch
          checked={settings.notifyTurnDone}
          onChange={(on) => update({ notifyTurnDone: on })}
        />
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Needs approval</b>
          <small>A session is blocked on a permission prompt.</small>
        </div>
        <Switch
          checked={settings.notifyApproval}
          onChange={(on) => update({ notifyApproval: on })}
        />
      </div>
      <div className={'set-row child' + (settings.notifyApproval ? '' : ' off')}>
        <div className="set-lab">
          <b>Approval sound</b>
          <small>The only category worth a beep — off by default.</small>
        </div>
        <Switch
          checked={settings.notifyApprovalSound}
          disabled={!settings.notifyApproval}
          onChange={(on) => update({ notifyApprovalSound: on })}
        />
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Session exited unexpectedly</b>
          <small>A session died without a graceful goodbye.</small>
        </div>
        <Switch checked={settings.notifyExited} onChange={(on) => update({ notifyExited: on })} />
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Dock badge</b>
          <small>Pending session count on the macOS Dock icon.</small>
        </div>
        <Switch checked={settings.dockBadge} onChange={(on) => update({ dockBadge: on })} />
      </div>
    </>
  )
}

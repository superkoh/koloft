import { useCallback, useEffect, useState, type JSX } from 'react'
import { LuArrowUpRight } from 'react-icons/lu'
import { buildResetPatch } from '@shared/settingsOps'
import { useStore } from '../../store'
import { useEscConsumer } from './escScope'
import { useSettingsUpdate } from './useSettingsUpdate'

/** About: version, updates, and the one dangerous button (FR-11/FR-12). The update
 *  check reuses the store's existing openUpdateCheck → UpdateModal path wholesale. */
export function AboutPane(): JSX.Element {
  const openUpdateCheck = useStore((s) => s.openUpdateCheck)
  const update = useSettingsUpdate()
  const [version, setVersion] = useState('')
  /** FR-12: reset asks an inline confirm first; the trigger dims while it is open */
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.update.version().then((v) => {
      if (alive) setVersion(v)
    })
    return () => {
      alive = false
    }
  }, [])

  useEscConsumer(
    confirming,
    useCallback(() => setConfirming(false), [])
  )

  const reset = (): void => {
    setConfirming(false)
    // the account domain (accounts / multiAccount / skipPermissions) is excluded —
    // see buildResetPatch; main strips `accounts` again as defense in depth (FR-13)
    update(buildResetPatch())
  }

  return (
    <>
      <div className="set-ph">
        <h3>About</h3>
        <p>Version, updates and reset.</p>
      </div>

      <div className="set-about">
        <div className="set-mark">K</div>
        <div>
          <b>Koloft</b>
          <small>{version ? `Version ${version}` : '…'}</small>
        </div>
      </div>

      <div className="set-row">
        <div className="set-lab">
          <b>Updates</b>
          <small>Checks GitHub Releases; download and relaunch stay one click away.</small>
        </div>
        <button className="mini" onClick={openUpdateCheck}>
          Check for updates
        </button>
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Release notes</b>
          <small>What changed, version by version.</small>
        </div>
        <button className="mini" onClick={() => window.api.update.openRelease()}>
          Open releases page <LuArrowUpRight size={13} />
        </button>
      </div>

      <div className={'set-danger' + (confirming ? ' confirming' : '')}>
        <div className="set-dh">Danger zone</div>
        <div className="set-row">
          <div className="set-lab">
            <b>Reset to defaults</b>
            <small>
              Fonts, notifications, session display and pane sizes go back to factory values.{' '}
              <b className="set-keep">Accounts and multi-account mode are kept.</b>
            </small>
          </div>
          <button className="mini danger" disabled={confirming} onClick={() => setConfirming(true)}>
            Reset…
          </button>
        </div>
        {confirming && (
          <div className="set-confirm">
            <span>Reset settings to factory values? Accounts and multi-account mode are kept.</span>
            <button className="mini danger" onClick={reset}>
              Reset
            </button>
            <button className="mini" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </>
  )
}

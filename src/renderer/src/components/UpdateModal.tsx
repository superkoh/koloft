import { useEffect, useMemo, type JSX } from 'react'
import { LuX } from 'react-icons/lu'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { useStore } from '../store'

// `html: false` renders raw tags in a release body as text; `linkify: false` because the
// only thing auto-linking could produce here is an anchor the sanitizer strips again.
const md = new MarkdownIt({ html: false, linkify: false, breaks: false })

/** Release-notes markdown → sanitized HTML.
 *  Anchors are dropped but their text kept (`KEEP_CONTENT`): the app installs no
 *  will-navigate / window-open guard, so one click on a link in here would navigate the
 *  whole renderer to GitHub and take every tab's live terminal with it. "View release ↗"
 *  is the sanctioned door — it goes through main, which shows the page in the app's own
 *  browser overlay (R3, it used to leave for the system browser).
 *  `img` is out for the same class of reason: a release body shouldn't be able to make the
 *  privileged renderer fetch a remote asset, or blow up the modal's layout. */
function renderNotes(markdown: string): string {
  return DOMPurify.sanitize(md.render(markdown), {
    FORBID_TAGS: ['a', 'img', 'iframe', 'script', 'style'],
    KEEP_CONTENT: true
  })
}

// Every generated body opens with this heading (see scripts/release-notes.sh). When the
// modal groups several releases it prints the version as the group's own heading, so the
// per-release repeat is pure noise — drop it there, keep it when a lone release is shown.
const WHATS_CHANGED = /^#{1,6}[ \t]*What[’']s Changed[ \t]*\r?\n+/i

/**
 * The manual "Check for Updates…" modal. The app is unsigned, so a confirmed update is a
 * direct in-app download→swap→relaunch (see main/updater.ts), not an App Store / Squirrel
 * flow. Phases come straight from the store's `update` slice.
 */
export function UpdateModal(): JSX.Element | null {
  const update = useStore((s) => s.update)
  const setUpdate = useStore((s) => s.setUpdate)
  const startUpdateDownload = useStore((s) => s.startUpdateDownload)
  const openUpdateCheck = useStore((s) => s.openUpdateCheck)

  // stable {__html} identities — React 19 re-sets innerHTML on a fresh wrapper object
  // (see PreviewViewer); inline objects would rebuild the notes DOM (dropping its
  // scroll) on every download-progress tick.
  const notesHtml = useMemo(() => {
    const rs = update.releases ?? []
    return rs.map((r) => ({
      __html: renderNotes(rs.length > 1 ? r.notes.replace(WHATS_CHANGED, '') : r.notes)
    }))
  }, [update.releases])

  // Esc closes this modal first when it stacks over Settings (topmost-modal
  // semantics — the settings shell ignores Esc while update.open); a running
  // download still refuses to be dismissed, same as backdrop and ×.
  useEffect(() => {
    if (!update.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const st = useStore.getState().update
      if (st.phase !== 'downloading') useStore.getState().setUpdate({ open: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [update.open])

  if (!update.open) return null

  const downloading = update.phase === 'downloading'
  const restarting = !!update.restarting
  // Main already dropped every release with no changelog, so an empty list means there is
  // genuinely nothing to show — render no notes box at all rather than an empty frame.
  const releases = update.releases ?? []
  const close = (): void => setUpdate({ open: false })
  const percent = update.percent ?? -1
  // don't let a backdrop click / × strand a running install. percent hits 100 on the last
  // downloaded byte — the mount/stage/spawn that follows can still fail, and that failure
  // has to land somewhere the user can see it.
  const dismiss = downloading ? undefined : close
  const whatsNew = update.phase === 'whats-new'
  const notes = releases.length > 0 && (
    <div className="update-notes">
      {releases.map((r, i) => (
        <div key={r.version}>
          {releases.length > 1 && <div className="update-notes-ver">v{r.version}</div>}
          <div dangerouslySetInnerHTML={notesHtml[i]} />
        </div>
      ))}
      {!!update.omittedReleases && (
        <div className="update-notes-more">
          …and {update.omittedReleases} earlier release
          {update.omittedReleases > 1 ? 's' : ''}
        </div>
      )}
    </div>
  )

  return (
    <div className="modal-backdrop" onClick={dismiss}>
      <div className="modal update-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{whatsNew ? `What’s new in Koloft ${update.current}` : 'Software Update'}</span>
          {!downloading && (
            <span className="modal-close" onClick={close} aria-label="Close">
              <LuX size={16} />
            </span>
          )}
        </div>

        <div className="modal-body">
          {update.phase === 'checking' && (
            <div className="update-row">
              <span className="update-spinner" />
              <span>Checking for updates…</span>
            </div>
          )}

          {update.phase === 'current' && (
            <>
              <div className="update-status">
                <span className="update-check">✓</span> You’re on the latest version
                {update.current ? ` (v${update.current})` : ''}.
                {update.installed && update.installed !== update.current && (
                  <>
                    {' '}
                    The copy on disk is v{update.installed}, so that’s what the next launch runs.
                  </>
                )}
              </div>
              <button className="mini" onClick={close}>
                Close
              </button>
            </>
          )}

          {update.phase === 'restart-required' && (
            <>
              <div className="update-status">
                <span className="update-check">✓</span> v{update.installed} is already installed —
                this window is still running v{update.current}. Restart to finish the update.
              </div>
              <div className="update-actions">
                <button
                  className="btn-primary"
                  onClick={() => {
                    // Stays clickable on purpose: main arms the relaunch once but retries
                    // the quit, and a stalled quit — the very thing that produced this
                    // state — is exactly when the user needs a second press.
                    setUpdate({ restarting: true })
                    window.api.update.restart()
                  }}
                >
                  {restarting ? 'Restarting…' : 'Restart Now'}
                </button>
                <button className="mini" onClick={close}>
                  Later
                </button>
              </div>
            </>
          )}

          {update.phase === 'available' && (
            <>
              <div className="update-version">
                <span className="update-ver-old">v{update.installed ?? update.current}</span>
                <span className="update-arrow">→</span>
                <span className="update-ver-new">v{update.latest}</span>
              </div>
              {notes}
              <div className="update-actions">
                <button className="btn-primary" onClick={startUpdateDownload}>
                  Download &amp; Restart
                </button>
                <button className="mini" onClick={close}>
                  Later
                </button>
                {update.htmlUrl && (
                  <button className="update-link" onClick={() => window.api.update.openRelease()}>
                    View release ↗
                  </button>
                )}
              </div>
              <div className="update-hint">
                Koloft downloads the new version, replaces itself, and relaunches. It’s unsigned, so
                this is a direct in-app update — no App Store, no Gatekeeper prompt.
              </div>
            </>
          )}

          {whatsNew && (
            <>
              {notes}
              <div className="update-actions">
                <button className="btn-primary" onClick={close}>
                  Close
                </button>
              </div>
            </>
          )}

          {downloading && (
            <>
              <div className="update-status">
                {percent >= 100 ? 'Installing & restarting…' : 'Downloading update…'}
              </div>
              <div className="update-progress">
                <div
                  className={'update-progress-fill' + (percent < 0 ? ' indet' : '')}
                  style={percent >= 0 ? { width: `${Math.min(percent, 100)}%` } : undefined}
                />
              </div>
              {percent >= 0 && percent < 100 && <div className="update-hint">{percent}%</div>}
            </>
          )}

          {update.phase === 'error' && (
            <>
              <div className="update-status update-error">⚠ {update.error}</div>
              <div className="update-actions">
                <button className="btn-primary" onClick={openUpdateCheck}>
                  Try again
                </button>
                <button className="mini" onClick={close}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

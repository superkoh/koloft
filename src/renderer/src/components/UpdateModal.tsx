import { useEffect, useMemo, type JSX } from 'react'
import { LuX } from 'react-icons/lu'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { useStore } from '../store'

const md = new MarkdownIt({ html: false, linkify: false, breaks: false })

function renderNotes(markdown: string): string {
  return DOMPurify.sanitize(md.render(markdown), {
    FORBID_TAGS: ['a', 'img', 'iframe', 'script', 'style'],
    KEEP_CONTENT: true
  })
}

const HEADING_REPEATED_BY_EVERY_RELEASE_BODY = /^#{1,6}[ \t]*What[’']s Changed[ \t]*\r?\n+/i

export function UpdateModal(): JSX.Element | null {
  const update = useStore((s) => s.update)
  const setUpdate = useStore((s) => s.setUpdate)
  const startUpdateDownload = useStore((s) => s.startUpdateDownload)
  const openUpdateCheck = useStore((s) => s.openUpdateCheck)

  // PLATFORM§25
  const notesHtml = useMemo(() => {
    const rs = update.releases ?? []
    return rs.map((r) => ({
      __html: renderNotes(
        rs.length > 1 ? r.notes.replace(HEADING_REPEATED_BY_EVERY_RELEASE_BODY, '') : r.notes
      )
    }))
  }, [update.releases])

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
  const releases = update.releases ?? []
  const close = (): void => setUpdate({ open: false })
  const percent = update.percent ?? -1
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

import { useEffect, useState, type JSX } from 'react'
import { IconChevronDown, IconChevronUp, IconCopy, IconNotes } from '../icons'
import { GLOBAL_SCOPE, scopeName } from '@shared/conductors'
import { NOTES_TAB, notesOwner } from '@shared/cwdKey'
import { editRefusal, EditPane } from './EditPane'
import { beginEdit, getEntry } from '../editRegistry'
import { useStore } from '../store'

export interface NotesIslandProps {
  wsPath: string | null
  height: number
  folded: boolean
  focusNonce: number
  onToggleFold: () => void
  onReturnFocus: () => void
}

export function NotesIsland({
  wsPath,
  height,
  folded,
  focusNonce,
  onToggleFold,
  onReturnFocus
}: NotesIslandProps): JSX.Element | null {
  const [path, setPath] = useState<{ ws: string; file: string } | null>(null)
  const [body, setBody] = useState<{ ws: string; failure: string | null } | null>(null)
  const showToast = useStore((s) => s.showToast)
  const butler = useStore((s) => s.settings.butler.name)

  useEffect(() => {
    setPath(null)
    setBody(null)
    if (!wsPath) return
    let cancelled = false
    if (getEntry(notesOwner(wsPath), NOTES_TAB)) setBody({ ws: wsPath, failure: null })
    void window.api.notes
      .path(wsPath)
      .then((p) => {
        if (cancelled || !p) return
        setPath({ ws: wsPath, file: p })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setBody({ ws: wsPath, failure: String((err as Error)?.message ?? '') })
      })
    return () => {
      cancelled = true
    }
  }, [wsPath])

  useEffect(() => {
    if (!wsPath || path?.ws !== wsPath || folded) return
    const owner = notesOwner(wsPath)
    if (getEntry(owner, NOTES_TAB)) {
      setBody({ ws: wsPath, failure: null })
      return
    }
    let cancelled = false
    const file = path.file
    window.api.edit
      .open(file)
      .then((r) => {
        if (cancelled) return
        beginEdit(owner, NOTES_TAB, {
          path: file,
          text: r.text,
          eol: r.eol,
          stamp: { mtimeMs: r.mtimeMs, size: r.size },
          readOnly: r.readOnly
        })
        setBody({ ws: wsPath, failure: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setBody({ ws: wsPath, failure: String((err as Error)?.message ?? '') })
      })
    return () => {
      cancelled = true
    }
  }, [wsPath, path, folded])

  if (!wsPath) return null
  const owner = notesOwner(wsPath)
  const ready = body && body.ws === wsPath ? body : null
  const file = path && path.ws === wsPath ? path.file : null

  return (
    <div className="island isl-dock isl-notes" style={folded ? undefined : { height }}>
      <div className="wb-bar">
        <span className="wb-title" title={file ?? wsPath}>
          <span className="ic">
            <IconNotes size={14} />
          </span>
          <span className="nm">Notes</span>
          <span className="dir">
            &nbsp;· {wsPath === GLOBAL_SCOPE ? butler : scopeName(wsPath)}
          </span>
        </span>
        <button
          className="icobtn"
          title="Copy path"
          aria-label="Copy path"
          disabled={!file}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!file) return
            navigator.clipboard?.writeText(file).catch(() => {})
            showToast('Copied path')
          }}
        >
          <IconCopy size={14} />
        </button>
        <button
          className="icobtn"
          title={folded ? 'Unfold' : 'Fold'}
          aria-label={folded ? 'Unfold' : 'Fold'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleFold}
        >
          {folded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        </button>
      </div>
      {!folded && (
        <div
          className="notes-body"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            onReturnFocus()
          }}
        >
          {ready === null ? null : ready.failure !== null ? (
            <div className="ed-ro" role="status">
              {editRefusal(ready.failure)}
            </div>
          ) : (
            <EditPane
              key={owner}
              ownerTab={owner}
              tabId={NOTES_TAB}
              prose
              autosave
              focusNonce={focusNonce}
              onSaved={() => {}}
            />
          )}
        </div>
      )}
    </div>
  )
}

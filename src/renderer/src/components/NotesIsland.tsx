import { useEffect, useState, type JSX } from 'react'
import { LuChevronDown, LuChevronUp, LuCopy, LuNotebookPen } from 'react-icons/lu'
import { basename } from '@shared/preview'
import { NOTES_TAB, notesOwner } from '@shared/cwdKey'
import { editRefusal, EditPane } from './EditPane'
import { beginEdit, getEntry } from '../editRegistry'
import { useStore } from '../store'

/**
 * D2…D8 — the workspace note: a second island in the left dock, under the sessions
 * island, always showing the CURRENT workspace's note and editing it in place.
 *
 * Why the dock and not the Workbench. A Workbench panel belongs to one session: it comes
 * up with that session and goes away with it. A note is the workspace's — it is where the
 * user keeps the things that are still true after this session ends, and after the next
 * one too — so it has to sit somewhere that outlives every session in the folder. The
 * dock is that place, beside the list of sessions the note is about. The note therefore
 * never opens as a Workbench tab; there is no button here that would open it there.
 *
 * The buffer lives in the shared edit registry like every other one, so the unsaved
 * guards see it, and switching workspaces and coming back finds the typing still there
 * (B-30).
 */

export interface NotesIslandProps {
  /** the current workspace, or null when nothing is pinned — then this renders nothing */
  wsPath: string | null
  /** the island's height in px while it is open */
  height: number
  folded: boolean
  /** bump it to put the caret in the note (⌥⌘N) */
  focusNonce: number
  onToggleFold: () => void
  /** Esc, and a second ⌥⌘N: send the caret back to the centre */
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
  /** The note file, and for WHICH workspace it is the note. The pair is one piece of state
   *  on purpose: the effect below reads the file, and it re-runs on a workspace switch
   *  BEFORE the new path has arrived — a bare path would then have it read (and adopt) the
   *  previous workspace's file under the new workspace's name. */
  const [path, setPath] = useState<{ ws: string; file: string } | null>(null)
  /** What the body may draw, and for WHICH workspace — the answer arrives an IPC round
   *  trip after the workspace changed, so a stale one must not be shown against the new
   *  head. `null` while the answer is still coming; `failure` non-null when it will not
   *  come at all. */
  const [body, setBody] = useState<{ ws: string; failure: string | null } | null>(null)
  const showToast = useStore((s) => s.showToast)

  // A workspace switch asks main which file holds that workspace's note (main makes an
  // empty one the first time). Only the file NAME is settled here; reading it is the next
  // effect's job, because that has to happen again later without this one running.
  useEffect(() => {
    // both belong to the workspace we are leaving: a path left standing would let Copy
    // path hand over the PREVIOUS workspace's file
    setPath(null)
    setBody(null)
    if (!wsPath) return
    let cancelled = false
    // coming back to a workspace whose buffer never left the registry: its text is shown
    // straight away, so the switch has no blank frame, and the read below then catches it
    // up with the file
    if (getEntry(notesOwner(wsPath), NOTES_TAB)) setBody({ ws: wsPath, failure: null })
    void window.api.notes
      .path(wsPath)
      .then((p) => {
        // main answers null for a folder it does not have pinned, which is a workspace
        // this island is on its way off already — so nothing is shown and nothing is said
        if (cancelled || !p) return
        setPath({ ws: wsPath, file: p })
      })
      .catch((err: unknown) => {
        // an editable box with no buffer behind it eats every key silently, so the box
        // does not appear at all — one line saying why takes its place
        if (cancelled) return
        setBody({ ws: wsPath, failure: String((err as Error)?.message ?? '') })
      })
    return () => {
      cancelled = true
    }
  }, [wsPath])

  // The first time a workspace's note is about to be on screen its file is read into a
  // buffer. After that the buffer outlives the box — folding the island unmounts it, as
  // does going to another workspace — and EditPane's own mount brings it back in line
  // with a file edited from outside in the meantime.
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

  // D3 — with nothing pinned there is no workspace to have a note, so the island is not
  // in the dock at all rather than sitting there empty.
  if (!wsPath) return null
  const owner = notesOwner(wsPath)
  const ready = body && body.ws === wsPath ? body : null
  // the answer for the workspace on screen, or none — the previous workspace's file must
  // never be what Copy path hands over
  const file = path && path.ws === wsPath ? path.file : null

  return (
    <div className="island isl-notes" style={folded ? undefined : { height }}>
      <div className="wb-bar">
        <span className="wb-title" title={file ?? wsPath}>
          <span className="ic">
            <LuNotebookPen size={14} />
          </span>
          <span className="nm">Notes</span>
          <span className="dir">&nbsp;· {basename(wsPath)}</span>
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
          <LuCopy size={14} />
        </button>
        <button
          className="icobtn"
          title={folded ? 'Unfold' : 'Fold'}
          aria-label={folded ? 'Unfold' : 'Fold'}
          // decline the focus (like the titlebar icons): a clicked button would otherwise
          // keep the caret, lighting the island's focus ring on a head band that has no
          // caret to show
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleFold}
        >
          {folded ? <LuChevronUp size={14} /> : <LuChevronDown size={14} />}
        </button>
      </div>
      {!folded && (
        <div
          className="notes-body"
          onKeyDown={(e) => {
            // Esc hands the caret back to the centre and does nothing else. It does NOT
            // fold the island: folding is a layout the user asked for, and Esc is for
            // leaving, not for putting things away.
            if (e.key !== 'Escape') return
            e.preventDefault()
            onReturnFocus()
          }}
        >
          {/* Nothing at all until the buffer is open (no spinner: the wait is one IPC
              round trip). `key` on the owner so a workspace switch UNMOUNTS the old pane:
              that unmount is what writes the outgoing note out (EditPane's autosave). The
              buffer it leaves behind stays in the registry — never `endEdit` here, or
              unsaved text would go with it. */}
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

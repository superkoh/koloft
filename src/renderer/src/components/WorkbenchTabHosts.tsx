import { memo, type JSX } from 'react'
import type { ArtifactView } from '@shared/types'
import { ArtifactPane, type ArtifactCaps } from './ArtifactPane'
import { EditPane } from './EditPane'
import { TerminalView } from './TerminalView'

export const TerminalHost = memo(function TerminalHost({
  id,
  shown,
  focusSignal
}: {
  id: string
  shown: boolean
  focusSignal: number
}): JSX.Element {
  return (
    <div className="wb-host wb-term" data-pty={id} style={{ display: shown ? undefined : 'none' }}>
      <TerminalView id={id} active={shown} autoFocus={false} focusSignal={focusSignal} />
    </div>
  )
})

export interface FileTabHostProps {
  ownerTab: string | null
  tabId: string
  path: string
  view?: ArtifactView
  line?: number
  scrollTop?: number
  shown: boolean
  editing: boolean
  editFocus: number
  editText?: string
  editUnsaved: boolean
  wsRoot: string | null
  base: string | null | undefined
  changed: boolean
  reloadNonce: number
  outlineOpen: boolean
  zoom: string | null
  onSaved: () => void
  onCaps: (tabId: string, caps: ArtifactCaps) => void
  onNavigate: (tabId: string, path: string, line?: number) => void
  onBody: (tabId: string, el: HTMLElement | null) => void
  onZoomImage: (src: string) => void
  onCloseZoom: () => void
  onOutlineClose: (tabId: string) => void
  onClose: (tabId: string) => void
  onUnmount: (tabId: string, scrollTop: number) => void
}

export const FileTabHost = memo(function FileTabHost({
  ownerTab,
  tabId,
  path,
  view,
  line,
  scrollTop,
  shown,
  editing,
  editFocus,
  editText,
  editUnsaved,
  wsRoot,
  base,
  changed,
  reloadNonce,
  outlineOpen,
  zoom,
  onSaved,
  onCaps,
  onNavigate,
  onBody,
  onZoomImage,
  onCloseZoom,
  onOutlineClose,
  onClose,
  onUnmount
}: FileTabHostProps): JSX.Element {
  return (
    <div className="wb-host" style={{ visibility: shown ? undefined : 'hidden' }}>
      {ownerTab && editing ? (
        <EditPane ownerTab={ownerTab} tabId={tabId} focusNonce={editFocus} onSaved={onSaved} />
      ) : (
        <ArtifactPane
          tabId={tabId}
          path={path}
          view={view}
          wsRoot={wsRoot}
          line={line}
          base={base}
          changed={changed}
          initialScrollTop={scrollTop}
          reloadNonce={reloadNonce}
          outlineOpen={outlineOpen}
          onCaps={onCaps}
          onNavigate={onNavigate}
          onBody={onBody}
          onZoomImage={onZoomImage}
          zoom={zoom}
          onCloseZoom={onCloseZoom}
          onOutlineClose={onOutlineClose}
          onClose={onClose}
          onUnmount={onUnmount}
          editText={editText}
          editUnsaved={editUnsaved}
        />
      )}
    </div>
  )
})

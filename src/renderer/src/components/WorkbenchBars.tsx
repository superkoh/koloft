import { memo, type JSX, type RefObject } from 'react'
import { IconEdit, IconExpand, IconOutline, IconReload, IconShrink } from '../icons'
import type { ArtifactView, GitFileStatus } from '@shared/types'
import type { ArtifactCaps } from './ArtifactPane'
import type { EditProbe } from './EditPane'
import { GIT_LETTER, splitPath } from './filesModel'

const VIEW_LABEL: Record<ArtifactView, string> = {
  render: 'Rendered',
  diff: 'Diff',
  source: 'Source'
}

export const FullWidthButton = memo(function FullWidthButton({
  full,
  onToggle
}: {
  full: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      className="icobtn"
      aria-label={full ? 'Restore ⌘⏎' : 'Full width ⌘⏎'}
      aria-pressed={full}
      title={full ? 'Restore ⌘⏎' : 'Full width ⌘⏎'}
      onClick={onToggle}
    >
      {full ? <IconShrink size={14} /> : <IconExpand size={14} />}
    </button>
  )
})

export const FileTabBar = memo(function FileTabBar({
  tabId,
  path,
  treeRoot,
  status,
  added,
  removed,
  caps,
  editing,
  editProbe,
  outlineOpen,
  outlineBtnRef,
  full,
  onToggleFull,
  onView,
  onReload,
  onEnterEdit,
  onExitEdit,
  onToggleOutline
}: {
  tabId: string
  path: string
  treeRoot: string | null
  status: GitFileStatus | undefined
  added: number
  removed: number
  caps: ArtifactCaps
  editing: boolean
  editProbe: EditProbe
  outlineOpen: boolean
  outlineBtnRef: RefObject<HTMLButtonElement | null>
  full: boolean
  onToggleFull: () => void
  onView: (tabId: string, view: ArtifactView) => void
  onReload: () => void
  onEnterEdit: (tabId: string, path: string) => void
  onExitEdit: (tabId: string) => void
  onToggleOutline: (tabId: string) => void
}): JSX.Element {
  const { dir, name } = splitPath(path, treeRoot)
  return (
    <div className="wb-bar">
      <span className="wb-title" title={path}>
        {dir && <span className="dir">{dir}</span>}
        <span className="nm">{name}</span>
      </span>
      {status && (
        <span className={'ft-gbadge git-' + status} title={status}>
          {GIT_LETTER[status]}
        </span>
      )}
      {(added > 0 || removed > 0) && (
        <span className="ft-delta">
          {added > 0 && <span className="add">+{added}</span>}
          {removed > 0 && <span className="del">−{removed}</span>}
        </span>
      )}
      {caps.views.length > 0 && (
        <div className="seg" role="group" aria-label="View mode">
          {caps.views.map((v) => (
            <button
              key={v}
              className={!editing && v === caps.current ? 'on' : undefined}
              aria-pressed={!editing && v === caps.current}
              disabled={v === 'diff' && !caps.hasDiff}
              onClick={() => {
                if (editing) onExitEdit(tabId)
                onView(tabId, v)
              }}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      )}
      <button
        className="icobtn"
        onClick={onReload}
        title={editing ? 'Not while you are editing' : 'Reload'}
        aria-label="Reload"
        disabled={editing}
      >
        <IconReload size={14} />
      </button>
      <button
        className={'icobtn wb-edit' + (editing ? ' on' : '')}
        aria-label="Edit"
        aria-pressed={editing}
        title={editing ? 'Stop editing' : editProbe.title || 'Edit'}
        disabled={!editing && !editProbe.can}
        onClick={() => (editing ? onExitEdit(tabId) : onEnterEdit(tabId, path))}
      >
        <IconEdit size={13} />
      </button>
      <button
        ref={outlineBtnRef}
        className={'icobtn' + (outlineOpen ? ' on' : '')}
        title="Outline"
        aria-label="Outline"
        disabled={!caps.hasOutline}
        onClick={() => onToggleOutline(tabId)}
      >
        <IconOutline size={14} />
      </button>
      <FullWidthButton full={full} onToggle={onToggleFull} />
    </div>
  )
})

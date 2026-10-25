import { useState, type JSX, type ReactNode, type RefObject } from 'react'
import { IconBack, IconClose, IconForward, IconOpenOutside, IconReload } from '../icons'
import { loadHistory, match } from '../browserHistory'

export function BrowserAddressBar({
  url,
  workspace,
  loading,
  canBack,
  canForward,
  inputRef,
  onSubmit,
  onBack,
  onForward,
  onReload,
  onStop,
  onExternalOpen,
  actions,
  overflow
}: {
  url: string
  workspace: string | null
  loading: boolean
  canBack: boolean
  canForward: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onSubmit: (value: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop: () => void
  onExternalOpen: () => void
  actions?: ReactNode
  overflow?: ReactNode
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const [index, setIndex] = useState(-1)
  const sugg = draft === null ? [] : match(loadHistory(), draft, workspace)

  const close = (): void => {
    setDraft(null)
    setIndex(-1)
  }
  const pick = (value: string): void => {
    onSubmit(value)
    close()
  }

  return (
    <div className="baddr">
      <button
        className={'bnav' + (canBack ? '' : ' dis')}
        aria-label="Back"
        title="Back ⌘["
        disabled={!canBack}
        onClick={onBack}
      >
        <IconBack size={16} />
      </button>
      <button
        className={'bnav' + (canForward ? '' : ' dis')}
        aria-label="Forward"
        title="Forward ⌘]"
        disabled={!canForward}
        onClick={onForward}
      >
        <IconForward size={16} />
      </button>
      {loading ? (
        <button className="bnav" aria-label="Stop" title="Stop" onClick={onStop}>
          <IconClose size={16} />
        </button>
      ) : (
        <button className="bnav" aria-label="Reload" title="Reload ⌘R" onClick={onReload}>
          <IconReload size={16} />
        </button>
      )}
      <input
        ref={inputRef}
        className="url"
        value={draft ?? url}
        placeholder="Search, address or file name"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setDraft(e.target.value)
          setIndex(-1)
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            pick(index >= 0 ? sugg[index].url : (draft ?? url))
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          } else if (sugg.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            const next = e.key === 'ArrowDown' ? index + 1 : index - 1
            setIndex(Math.max(-1, Math.min(sugg.length - 1, next)))
          }
        }}
      />
      {sugg.length > 0 && (
        <div className="bext-menu baddr-sugg" role="listbox">
          {sugg.map((s, i) => (
            <div
              key={s.url}
              className={'bext-mrow' + (i === index ? ' on' : '')}
              role="option"
              aria-selected={i === index}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(s.url)
              }}
            >
              <span className="baddr-sugg-u">{s.url}</span>
              {s.title && <span className="baddr-sugg-t">{s.title}</span>}
            </div>
          ))}
        </div>
      )}
      {actions}
      <button
        className="bnav"
        aria-label="Open in system browser"
        title="Open in system browser"
        onClick={onExternalOpen}
      >
        <IconOpenOutside size={16} />
      </button>
      {overflow}
      {loading && <span className="prog" />}
    </div>
  )
}

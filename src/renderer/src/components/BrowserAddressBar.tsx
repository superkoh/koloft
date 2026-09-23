import { useState, type JSX, type ReactNode, type RefObject } from 'react'
import { LuArrowLeft, LuArrowRight, LuExternalLink, LuRotateCw, LuX } from 'react-icons/lu'
import { loadHistory, match } from '../browserHistory'

/**
 * §05C/§06B — the Browser's second head-band row: history, reload/stop, the editable
 * address, and the ↗ escape hatch. It decides nothing about a typed target: the value
 * goes up to the pane, which runs it through the shared routing table (SEC-13), so the
 * scheme whitelist has exactly one implementation.
 *
 * The field shows the tab's url at rest and the user's own text while they edit it
 * (blur / Esc / a submit drop back to the canonical form). While editing it offers
 * matching pages from the browser's own history; picking one just fills the value
 * that goes out through onSubmit, so the routing table still decides.
 */
export function BrowserAddressBar({
  url,
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
  /** the extension action row (browser-extensions D3) — right of the field, and its own
   *  business entirely: this bar neither knows nor decides what is in it */
  actions?: ReactNode
  /** B12: the ⋯ menu button, last in the row. Kept a slot rather than built here for
   *  the same reason as `actions`: what the menu contains is the pane's business. */
  overflow?: ReactNode
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const [index, setIndex] = useState(-1)
  const sugg = draft === null ? [] : match(loadHistory(), draft)

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
        <LuArrowLeft size={16} />
      </button>
      <button
        className={'bnav' + (canForward ? '' : ' dis')}
        aria-label="Forward"
        title="Forward ⌘]"
        disabled={!canForward}
        onClick={onForward}
      >
        <LuArrowRight size={16} />
      </button>
      {loading ? (
        <button className="bnav" aria-label="Stop" title="Stop" onClick={onStop}>
          <LuX size={16} />
        </button>
      ) : (
        <button className="bnav" aria-label="Reload" title="Reload ⌘R" onClick={onReload}>
          <LuRotateCw size={16} />
        </button>
      )}
      <input
        ref={inputRef}
        className="url"
        value={draft ?? url}
        placeholder="Search or enter address (http(s) / file://)"
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
        <LuExternalLink size={16} />
      </button>
      {overflow}
      {loading && <span className="prog" />}
    </div>
  )
}

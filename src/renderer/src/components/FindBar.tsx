import type { JSX, RefObject } from 'react'
import { LuChevronLeft, LuChevronRight, LuX } from 'react-icons/lu'
import type { FindCount } from '../useDomFind'

/**
 * The find-in-page bar that floats top-right over the file viewer. Pure presentation +
 * input keyboard (Enter / ⇧Enter step matches; Esc is handled by FilePane so it can
 * also fall through to closing the pane). Focus is driven by FilePane via `inputRef`
 * (so re-triggering ⌘F over a focused webview re-focuses the input). The matching/
 * navigation backend (DOM or webview) is wired by FilePane via `count` + the handlers.
 */
export function FindBar({
  inputRef,
  query,
  onQueryChange,
  count,
  onNext,
  onPrev,
  onClose
}: {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (q: string) => void
  count: FindCount
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}): JSX.Element {
  const noMatch = query.length > 0 && count.total === 0

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className={'find-input' + (noMatch ? ' no-match' : '')}
        value={query}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          }
        }}
      />
      <span className="find-count">
        {count.total ? `${count.current}/${count.total}` : query ? '0/0' : ''}
      </span>
      <button
        className="find-btn"
        onClick={onPrev}
        disabled={!count.total}
        title="Previous (⇧Enter)"
      >
        <LuChevronLeft size={14} />
      </button>
      <button className="find-btn" onClick={onNext} disabled={!count.total} title="Next (Enter)">
        <LuChevronRight size={14} />
      </button>
      <button className="find-btn find-close" onClick={onClose} title="Close (Esc)">
        <LuX size={14} />
      </button>
    </div>
  )
}

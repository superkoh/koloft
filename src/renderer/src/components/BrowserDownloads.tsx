import { useEffect, useRef, type JSX } from 'react'
import { LuFileText, LuTrash2 } from 'react-icons/lu'
import type { DownloadItem, DownloadList } from './downloadList'

const OPENER_BUTTON_IS_NOT_OUTSIDE = '[data-panel-toggle="downloads"]'

function sizeText(item: DownloadItem): string {
  const mb = (n: number): string => (n / 1024 / 1024).toFixed(1) + ' MB'
  if (item.state === 'progress') {
    return item.total > 0 ? `${mb(item.received)} / ${mb(item.total)}` : mb(item.received)
  }
  if (item.state === 'done') return 'Completed'
  if (item.state === 'cancelled') return 'Cancelled'
  return 'Failed'
}

export function BrowserDownloads({
  list,
  onReveal,
  onCancel,
  onRetry,
  onClear,
  onClose
}: {
  list: DownloadList
  onReveal: (path: string) => void
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onClear: () => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (ref.current?.contains(target as Node)) return
      if (target?.closest(OPENER_BUTTON_IS_NOT_OUTSIDE)) return
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  return (
    <div className="bdl" ref={ref} role="dialog" aria-label="Downloads">
      <div className="bdl-head">
        Downloads
        <button className="bdl-clear" onClick={onClear} title="Clear finished downloads">
          <LuTrash2 size={12} />
          Clear
        </button>
      </div>
      {list.items.length === 0 && <div className="bdl-empty">Nothing downloaded yet this run</div>}
      {list.items.map((item) => (
        <div className="bdl-row" key={item.id} data-state={item.state}>
          <span className="bdl-ico">
            <LuFileText size={14} />
          </span>
          <span className="bdl-nm">
            <b title={item.name}>{item.name}</b>
            <small>{sizeText(item)}</small>
            {item.state === 'progress' && item.total > 0 && (
              <span className="bdl-bar">
                <i style={{ width: `${Math.min(100, (item.received / item.total) * 100)}%` }} />
              </span>
            )}
          </span>
          {item.state === 'progress' && (
            <button className="bdl-act" onClick={() => onCancel(item.id)}>
              Cancel
            </button>
          )}
          {item.state === 'done' && item.path && (
            <button className="bdl-act" onClick={() => onReveal(item.path as string)}>
              Show in Finder
            </button>
          )}
          {(item.state === 'failed' || item.state === 'cancelled') && (
            <button className="bdl-act" onClick={() => onRetry(item.id)}>
              Retry
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

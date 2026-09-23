import { useState, type JSX, type KeyboardEvent } from 'react'
import { LuX } from 'react-icons/lu'
import { remoteKeyFromForm } from '../remoteWorkspace'
import { isComposing } from '../keys'

export function RemoteWorkspaceDialog({
  onAdd,
  onClose
}: {
  onAdd: (key: string) => void
  onClose: () => void
}): JSX.Element {
  const [machine, setMachine] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const r = remoteKeyFromForm(machine, path)
    if (!r.ok) {
      setError(r.message)
      return
    }
    onAdd(r.key)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Enter' && !isComposing(e)) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal remotews"
        role="dialog"
        aria-label="Remote directory"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-header">
          <span>
            Remote directory<span className="tag">alpha</span>
          </span>
          <span className="modal-close" onClick={onClose} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          <span className="flabel">Machine</span>
          <div className="cb-input">
            <input
              autoFocus
              className="cb-field"
              spellCheck={false}
              autoComplete="off"
              aria-label="Machine"
              placeholder="user@host or an ssh config name"
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
            />
          </div>
          <span className="flabel">Path on the machine</span>
          <div className="cb-input">
            <input
              className="cb-field"
              spellCheck={false}
              autoComplete="off"
              aria-label="Path on the machine"
              placeholder="/home/me/project"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </div>
          {error && <div className="rws-err">{error}</div>}
          <div className="rws-note">
            Password or ssh keys: whatever <code>ssh &lt;machine&gt;</code> needs; put ports and
            keys in ~/.ssh/config.
          </div>
        </div>
        <div className="modal-foot">
          <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={submit}>
            Add<span className="k">⏎</span>
          </button>
        </div>
      </div>
    </div>
  )
}

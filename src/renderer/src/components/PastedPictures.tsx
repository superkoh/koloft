import type { JSX } from 'react'
import type { PastedPicture } from '@shared/pastedPictures'
import { IconClose } from '../icons'
import '../pastedPictures.css'

export function PastedPictures({
  pictures,
  disabled,
  onRemove
}: {
  pictures: readonly PastedPicture[]
  disabled?: boolean
  onRemove: (picture: PastedPicture) => void
}): JSX.Element | null {
  if (!pictures.length) return null
  return (
    <div className="pasted-pics" role="list" aria-label="Pasted pictures">
      {pictures.map((p) => (
        <div key={p.path} className="pasted-pic" role="listitem">
          <img src={p.shown} alt="" />
          <button
            className="pasted-pic-x"
            aria-label="Remove picture"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onRemove(p)}
          >
            <IconClose size={8} />
          </button>
        </div>
      ))}
    </div>
  )
}

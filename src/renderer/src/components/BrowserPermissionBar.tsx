import type { JSX } from 'react'
import { LuBell, LuCamera, LuClipboard, LuMapPin, LuMic, LuShieldOff } from 'react-icons/lu'
import type { BrowserPermissionAsk, BrowserPermissionRefusal } from '@shared/types'

const LABEL: Record<string, string> = {
  microphone: 'your microphone',
  camera: 'your camera',
  'camera-and-microphone': 'your camera and microphone',
  notifications: 'send desktop notifications',
  geolocation: 'your location',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'share your screen'
}

const ICON: Record<string, JSX.Element> = {
  microphone: <LuMic size={16} />,
  camera: <LuCamera size={16} />,
  'camera-and-microphone': <LuCamera size={16} />,
  notifications: <LuBell size={16} />,
  geolocation: <LuMapPin size={16} />,
  'clipboard-read': <LuClipboard size={16} />
}

function label(permission: string): string {
  return LABEL[permission] ?? permission
}

export function BrowserPermissionBar({
  ask,
  refusal,
  onAnswer,
  onDismissRefusal,
  onEscapeHatch
}: {
  ask: BrowserPermissionAsk | null
  refusal: BrowserPermissionRefusal | null
  onAnswer: (id: string, granted: boolean) => void
  onDismissRefusal: () => void
  onEscapeHatch: (origin: string) => void
}): JSX.Element | null {
  if (ask) {
    return (
      <div className="bperm" role="alertdialog" aria-label="Page permission request">
        <span className="bperm-ico">{ICON[ask.permission] ?? <LuShieldOff size={16} />}</span>
        <span className="bperm-msg">
          <b>{ask.origin}</b> wants to use <b>{label(ask.permission)}</b>
        </span>
        <span className="bperm-btns">
          <button className="bperm-b" onClick={() => onAnswer(ask.id, false)}>
            Block
          </button>
          <button className="bperm-b pri" onClick={() => onAnswer(ask.id, true)}>
            Allow
          </button>
        </span>
      </div>
    )
  }
  if (refusal) {
    return (
      <div className="bperm refused" role="status">
        <span className="bperm-ico">
          <LuShieldOff size={16} />
        </span>
        <span className="bperm-msg">
          Blocked <b>{refusal.origin}</b> from <b>{label(refusal.permission)}</b> — Koloft&rsquo;s
          browser does not support it
        </span>
        <span className="bperm-btns">
          <button className="bperm-b" onClick={() => onEscapeHatch(refusal.origin)}>
            Open in system browser
          </button>
          <button className="bperm-b" aria-label="Dismiss" onClick={onDismissRefusal}>
            Dismiss
          </button>
        </span>
      </div>
    )
  }
  return null
}

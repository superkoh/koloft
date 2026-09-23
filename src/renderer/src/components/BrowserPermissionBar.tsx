import type { JSX } from 'react'
import { LuBell, LuCamera, LuClipboard, LuMapPin, LuMic, LuShieldOff } from 'react-icons/lu'
import type { BrowserPermissionAsk, BrowserPermissionRefusal } from '@shared/types'

/**
 * §03 B7 — the prompt that stands between a page and the microphone, and the notice that
 * stands where a silent refusal used to be.
 *
 * It sits under the address bar and over the page, never over the chrome: the address
 * bar has to stay usable while a page is asking (BB-C44). The site's name is main's
 * word, read off the request Chromium made — a page cannot sign someone else's name to
 * a prompt (SEC-10's rule).
 */

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

/** what the sentence reads as for a permission nobody named — the raw string is still
 *  better than an empty gap, and the refusal notice is the only place it shows */
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

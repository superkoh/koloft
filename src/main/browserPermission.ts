export type PermissionName =
  | 'microphone'
  | 'camera'
  | 'camera-and-microphone'
  | 'notifications'
  | 'geolocation'
  | 'clipboard-read'

const PROMPTABLE = new Set(['media', 'notifications', 'geolocation', 'clipboard-read'])

// PLATFORM§11
const SILENT_ALLOW = new Set(['clipboard-sanitized-write', 'fullscreen'])

const ELSEWHERE = new Set(['openExternal'])

export interface PermissionDetails {
  requestingUrl?: string
  embeddingOrigin?: string
  securityOrigin?: string
  isMainFrame?: boolean
  mediaTypes?: string[]
  mediaType?: string
}

export type PermissionAsk =
  | { kind: 'ask'; permission: PermissionName; origin: string }
  | { kind: 'allow' }
  | { kind: 'refuse'; permission: string; origin: string; tell: boolean }
  | { kind: 'elsewhere' }

// PLATFORM§11
export function permissionOriginOf(details: PermissionDetails): string {
  for (const candidate of [
    details.requestingUrl,
    details.securityOrigin,
    details.embeddingOrigin
  ]) {
    if (!candidate) continue
    try {
      const origin = new URL(candidate).origin
      if (origin && origin !== 'null') return origin
    } catch {}
  }
  return ''
}

// PLATFORM§11
function mediaName(details: PermissionDetails): PermissionName | null {
  const types = details.mediaTypes ?? (details.mediaType ? [details.mediaType] : [])
  const audio = types.includes('audio')
  const video = types.includes('video')
  if (audio && video) return 'camera-and-microphone'
  if (video) return 'camera'
  if (audio) return 'microphone'
  return null
}

const TELL_ABOUT = new Set([
  'display-capture',
  'media',
  'usb',
  'bluetooth',
  'serial',
  'hid',
  'midi'
])

export function permissionAsk(permission: string, details: PermissionDetails): PermissionAsk {
  if (ELSEWHERE.has(permission)) return { kind: 'elsewhere' }
  if (SILENT_ALLOW.has(permission)) return { kind: 'allow' }

  const origin = permissionOriginOf(details)
  const tell = TELL_ABOUT.has(permission)
  if (!origin) return { kind: 'refuse', permission, origin: '', tell: false }
  if (details.isMainFrame === false) return { kind: 'refuse', permission, origin, tell: false }
  if (!PROMPTABLE.has(permission)) return { kind: 'refuse', permission, origin, tell }

  if (permission === 'media') {
    const device = mediaName(details)
    if (!device) return { kind: 'refuse', permission: 'display-capture', origin, tell: true }
    return { kind: 'ask', permission: device, origin }
  }
  return { kind: 'ask', permission: permission as PermissionName, origin }
}

export function permissionKey(origin: string, permission: PermissionName): string {
  return `${origin} ${permission}`
}

export function permissionKeysFor(origin: string, permission: PermissionName): string[] {
  if (permission === 'camera-and-microphone') {
    return [
      permissionKey(origin, 'camera-and-microphone'),
      permissionKey(origin, 'camera'),
      permissionKey(origin, 'microphone')
    ]
  }
  return [permissionKey(origin, permission)]
}

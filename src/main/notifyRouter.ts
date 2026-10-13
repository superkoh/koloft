import type { AttentionEvent, AttentionKind, Settings } from '@shared/types'

export interface RouteContext {
  windowFocused: boolean
  offScreenTest: boolean
}

export interface RouteDecision {
  os: boolean
  sound: boolean
}

const NONE: RouteDecision = { os: false, sound: false }

function categoryEnabled(kind: AttentionKind, s: Settings): boolean {
  switch (kind) {
    case 'turn-done':
      return s.notifyTurnDone
    case 'approval':
      return s.notifyApproval
    case 'exited':
      return s.notifyExited
  }
}

export function dockBadgeText(
  pendingCount: number,
  dockBadgeEnabled: boolean,
  offScreenTest: boolean
): string | null {
  if (offScreenTest) return null
  if (!dockBadgeEnabled || pendingCount <= 0) return ''
  return String(pendingCount)
}

export function route(event: AttentionEvent, ctx: RouteContext, settings: Settings): RouteDecision {
  if (!categoryEnabled(event.kind, settings)) return NONE
  if (ctx.offScreenTest) return NONE
  const sound = event.kind === 'approval' && settings.notifyApprovalSound
  return { os: !ctx.windowFocused, sound }
}

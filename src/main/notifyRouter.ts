import type { AttentionEvent, AttentionKind, Settings } from '@shared/types'

export interface RouteContext {
  windowFocused: boolean
  backgroundTest: boolean
}

export type OsOutlet = 'none' | 'banner' | 'recordForTest'

export interface RouteDecision {
  os: OsOutlet
  sound: boolean
}

const NONE: RouteDecision = { os: 'none', sound: false }

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

export function dockBadgeText(pendingCount: number, dockBadgeEnabled: boolean): string {
  if (!dockBadgeEnabled || pendingCount <= 0) return ''
  return String(pendingCount)
}

export function route(event: AttentionEvent, ctx: RouteContext, settings: Settings): RouteDecision {
  if (!categoryEnabled(event.kind, settings)) return NONE
  const sound = !ctx.backgroundTest && event.kind === 'approval' && settings.notifyApprovalSound
  if (ctx.windowFocused) return { os: 'none', sound }
  return { os: ctx.backgroundTest ? 'recordForTest' : 'banner', sound }
}

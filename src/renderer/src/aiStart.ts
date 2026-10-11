import type { SessionRoute } from '@shared/sessionRoute'

let lastAsk = 0

export function askRoute(message: string): {
  result: Promise<SessionRoute | null>
  cancel: () => void
} {
  const id = ++lastAsk
  return {
    result: window.api.assist.route(id, message).catch(() => null),
    cancel: () => window.api.assist.cancel(id)
  }
}

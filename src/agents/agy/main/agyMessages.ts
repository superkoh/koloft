import type { SessionMessages } from '@core/agent/sessionBackends'

export function agyMessages(
  throughItsApi: (tabId: string, text: string) => Promise<boolean>
): SessionMessages {
  return {
    // AGY§15 AGY§16
    send: async (tabId, m) =>
      !('handedOverAs' in m) && (await throughItsApi(tabId, m.text))
        ? 'taken'
        : 'only-its-terminal-takes-it',
    mightNotTakeAMessageNow: async (tabId, turnHasEnded) => !(await turnHasEnded(tabId))
  }
}

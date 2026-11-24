import type { SessionBackends } from '@core/agent/sessionBackends'
import type { SessionRuntime } from '@core/agent/sessionRuntime'

export function wireRunState(
  runtime: SessionRuntime,
  backends: Pick<SessionBackends, 'workStillRunning'>,
  rows: { updateSoon(): void }
): void {
  runtime.workStillRunning = (tabId) => backends.workStillRunning(tabId)
  runtime.on('turn-over', () => rows.updateSoon())
}

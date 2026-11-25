import type { SessionBackends } from '@core/agent/sessionBackends'
import type { SessionRuntime } from '@core/agent/sessionRuntime'

export function wireRunState(
  runtime: SessionRuntime,
  backends: Pick<SessionBackends, 'workStillRunning'>
): void {
  runtime.workStillRunning = (tabId) => backends.workStillRunning(tabId)
}

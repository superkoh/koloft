import { SessionBackends } from '../../../src/core/agent/sessionBackends'
import { SessionRuntime } from '../../../src/core/agent/sessionRuntime'
import { ClaudeBackend, type ClaudeBackendDeps } from '../../../src/agents/claude/main/backend'
import { SessionTracker } from '../../../src/agents/claude/main/sessionTracker'
import { wireRunState } from '../../../src/plugins/sessions/main/runState'

const runtimes = new WeakMap<SessionTracker, SessionRuntime>()

const NOTHING_FOLLOWS_A_SESSION = {
  prompted: () => {},
  bound: () => {},
  exited: () => {},
  clearAttention: () => {},
  open: () => {},
  turnEnded: () => {},
  asked: () => {}
}

export function trackerWiredAsTheAppWiresIt(): SessionTracker {
  const runtime = new SessionRuntime()
  const tracker = new SessionTracker(runtime)
  const backends = new SessionBackends(NOTHING_FOLLOWS_A_SESSION)
  backends.register(
    new ClaudeBackend({ pty: { get: () => undefined }, tracker } as unknown as ClaudeBackendDeps)
  )
  wireRunState(runtime, backends, tracker)
  runtimes.set(tracker, runtime)
  return tracker
}

export function runtimeOf(tracker: SessionTracker): SessionRuntime {
  return runtimes.get(tracker)!
}

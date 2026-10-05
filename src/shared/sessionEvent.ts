import type { BackgroundItem, PreviewItem, SessionUsage } from './types'
import type { Turn } from './turns'

// CC§8
export interface ReportedTask {
  id: string
  type: string
  since?: number
}

// CC§14
export interface AskPayload {
  tool_name?: string
  tool_input?: Record<string, unknown>
}

export type SessionEvent =
  | { type: 'asked'; ask: AskPayload }
  | { type: 'prompt' }
  | { type: 'stop'; reported?: ReportedTask[] }
  | { type: 'notify'; need: 'approval' | 'input' }
  | { type: 'background-changed'; items: BackgroundItem[] }
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'title'; title: string }
  | { type: 'degraded'; message: string }
  | { type: 'open'; target: string }
  | { type: 'bound'; key: string }
  | { type: 'exited'; clean: boolean; title?: string; sessionId?: string }
  | { type: 'turn-ended'; turn: Turn }
  | {
      type: 'files-changed'
      files: PreviewItem[]
      lastTouched?: string
      lastWritten?: string
      liveWrites: number
    }

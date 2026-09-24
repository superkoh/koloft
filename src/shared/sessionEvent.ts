import type { BackgroundItem, SessionUsage } from './types'

// CC§8
export interface ReportedTask {
  id: string
  type: string
  since?: number
}

export type SessionEvent =
  | { type: 'prompt' }
  | { type: 'stop'; reported?: ReportedTask[] }
  | { type: 'notify'; need: 'approval' | 'input' }
  | { type: 'background-changed'; items: BackgroundItem[] }
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'title'; title: string }
  | { type: 'degraded'; message: string }

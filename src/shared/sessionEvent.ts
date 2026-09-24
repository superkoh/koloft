import type { BackgroundItem, PreviewItem, SessionUsage } from './types'

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
  | { type: 'open'; target: string }
  | {
      type: 'files-changed'
      files: PreviewItem[]
      lastTouched?: string
      lastWritten?: string
      liveWrites: number
    }

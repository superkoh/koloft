import type { SessionEvent } from '@shared/sessionEvent'
import { OscBodies } from './oscCwd'

const PROGRAM_STATUS = '7501;'

// MUSE§3
export const PROGRAM_STATUS_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'

export interface ProgramStatus {
  state: string
  kind?: string
}

function fields(body: string): Record<string, string> {
  return Object.fromEntries(
    body.split(':').flatMap((part) => {
      const eq = part.indexOf('=')
      return eq > 0 ? [[part.slice(0, eq), part.slice(eq + 1)]] : []
    })
  )
}

export class ProgramStatusParser {
  private bodies = new OscBodies()

  push(chunk: string): { asked: boolean; states: ProgramStatus[] } {
    let asked = false
    const states: ProgramStatus[] = []
    for (const body of this.bodies.push(chunk)) {
      if (!body.startsWith(PROGRAM_STATUS)) continue
      const rest = body.slice(PROGRAM_STATUS.length)
      if (rest === '?') {
        asked = true
        continue
      }
      const f = fields(rest)
      if (f.state && f.id === undefined) states.push({ state: f.state, kind: f.kind })
    }
    return { asked, states }
  }
}

// MUSE§3
export function statusEvent({ state, kind }: ProgramStatus): SessionEvent | undefined {
  switch (state) {
    case 'working':
      return { type: 'prompt' }
    case 'idle':
    case 'done':
    case 'error':
      return { type: 'stop' }
    case 'blocked':
      return { type: 'notify', need: kind === 'permission' ? 'approval' : 'input' }
  }
  return undefined
}

import type { SessionEvent } from '@shared/sessionEvent'
import { OscBodies } from './oscCwd'

const PROGRAM_STATUS = '7501;'

// MUSE§3
export const PROGRAM_STATUS_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'

export interface ProgramStatus {
  state: string
  kind?: string
  seq?: number
  msg?: string
}

// AGY§10
function decodedMsg(base64: string | undefined): string | undefined {
  if (!base64) return undefined
  const text = Buffer.from(base64, 'base64').toString('utf8')
  return text || undefined
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
  // AGY§10
  private bodies = new OscBodies(true)

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
      if (f.state && f.id === undefined)
        states.push({
          state: f.state,
          kind: f.kind,
          ...(f.seq && { seq: Number(f.seq) }),
          msg: decodedMsg(f.msg)
        })
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

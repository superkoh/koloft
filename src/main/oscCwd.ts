import os from 'os'

const ESC = '\x1b'
const BEL = '\x07'

export const OSC_CARRY_MAX = 4096

// PLATFORM§2
function isLocalHost(host: string, hostname: string): boolean {
  if (host === '') return true
  const h = host.toLowerCase()
  return h === 'localhost' || h === hostname.toLowerCase()
}

function cwdFromBody(body: string, hostname: string): string | undefined {
  const semi = body.indexOf(';')
  if (semi < 0 || body.slice(0, semi) !== '7') return undefined
  const uri = body.slice(semi + 1)
  if (!uri.startsWith('file://')) return undefined
  const rest = uri.slice('file://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return undefined
  if (!isLocalHost(rest.slice(0, slash), hostname)) return undefined
  try {
    return decodeURIComponent(rest.slice(slash))
  } catch {
    return undefined
  }
}

export class OscBodies {
  private carry = ''
  private carryIsHeadOnly = false

  constructor(private readonly keepHeadOfLongBodies = false) {}

  push(chunk: string): string[] {
    const s = this.carry + chunk
    const headOnly = this.carryIsHeadOnly
    this.carry = ''
    this.carryIsHeadOnly = false
    const found: string[] = []
    let i = 0
    while (i < s.length) {
      const esc = s.indexOf(ESC, i)
      if (esc < 0) break
      if (esc + 1 >= s.length) return this.hold(s.slice(esc), found)
      if (s[esc + 1] !== ']') {
        i = esc + 1
        continue
      }
      let j = esc + 2
      let end = -1
      let termLen = 0
      for (; j < s.length; j++) {
        const c = s[j]
        if (c === BEL) {
          end = j
          termLen = 1
          break
        }
        if (c === ESC) {
          if (j + 1 >= s.length) return this.hold(s.slice(esc), found, headOnly && esc === 0)
          if (s[j + 1] === '\\') {
            end = j
            termLen = 2
          }
          break
        }
      }
      if (end < 0) {
        if (j < s.length) {
          i = j
          continue
        }
        return this.hold(s.slice(esc), found, headOnly && esc === 0)
      }
      found.push(s.slice(esc + 2, headOnly && esc === 0 ? OSC_CARRY_MAX : end))
      i = end + termLen
    }
    return found
  }

  private hold(partial: string, found: string[], headOnly = false): string[] {
    if (!headOnly && partial.length <= OSC_CARRY_MAX) this.carry = partial
    else if (this.keepHeadOfLongBodies) {
      this.carry = partial.slice(0, OSC_CARRY_MAX) + (partial.endsWith(ESC) ? ESC : '')
      this.carryIsHeadOnly = true
    }
    return found
  }
}

// PLATFORM§2
export class OscCwdParser {
  private bodies = new OscBodies()

  constructor(private readonly hostname: string = os.hostname()) {}

  push(chunk: string): string | undefined {
    let found: string | undefined
    for (const body of this.bodies.push(chunk)) found = cwdFromBody(body, this.hostname) ?? found
    return found
  }
}

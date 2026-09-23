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

// PLATFORM§2
export class OscCwdParser {
  private carry = ''

  constructor(private readonly hostname: string = os.hostname()) {}

  push(chunk: string): string | undefined {
    const s = this.carry + chunk
    this.carry = ''
    let found: string | undefined
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
          if (j + 1 >= s.length) return this.hold(s.slice(esc), found)
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
        return this.hold(s.slice(esc), found)
      }
      found = cwdFromBody(s.slice(esc + 2, end), this.hostname) ?? found
      i = end + termLen
    }
    return found
  }

  private hold(partial: string, found: string | undefined): string | undefined {
    this.carry = partial.length <= OSC_CARRY_MAX ? partial : ''
    return found
  }
}

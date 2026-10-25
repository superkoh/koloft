import dns from 'dns'
import net from 'net'
import os from 'os'
import { urlOrNull } from '@shared/browserRoute'

const SCHEMES_THAT_REACH_A_SERVER = new Set(['http:', 'https:', 'ws:', 'wss:'])
const LOOPBACK_NAME = /^(localhost|.+\.localhost)\.?$/i
const IPV4_MAPPED = '::ffff:'

function bare(host: string): string {
  return host
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase()
}

function unmapped(ip: string): string {
  if (!ip.startsWith(IPV4_MAPPED)) return ip
  const rest = ip.slice(IPV4_MAPPED.length)
  if (net.isIPv4(rest)) return rest
  const [hi, lo] = rest.split(':').map((g) => parseInt(g, 16))
  if (hi === undefined || lo === undefined || Number.isNaN(hi) || Number.isNaN(lo)) return ip
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
}

function ownAddresses(): Set<string> {
  return new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .flatMap((i) => (i ? [bare(i.address)] : []))
  )
}

function isThisMacsAddress(address: string, own: Set<string>): boolean {
  const ip = unmapped(bare(address))
  if (net.isIPv4(ip)) return ip.startsWith('127.') || ip.startsWith('0.') || own.has(ip)
  return ip === '::1' || ip === '::' || own.has(ip)
}

function serverHost(url: string): string | null {
  const u = urlOrNull(url)
  return u && SCHEMES_THAT_REACH_A_SERVER.has(u.protocol) ? bare(u.hostname) : null
}

export function namesThisMacsServer(url: string): boolean {
  const host = serverHost(url)
  if (host === null) return false
  return (
    LOOPBACK_NAME.test(host) ||
    (net.isIP(unmapped(host)) !== 0 && isThisMacsAddress(host, ownAddresses()))
  )
}

const A_LOOKED_UP_NAME_STAYS_ANSWERED_MS = 10_000
const A_LOOKUP_GIVES_UP_MS = 3_000
const LOOKED_UP_NAMES_KEPT = 500
const lookedUp = new Map<string, { at: number; reaches: Promise<boolean> }>()

// PLATFORM§12
function nameReachesThisMac(host: string): Promise<boolean> {
  const known = lookedUp.get(host)
  if (known && Date.now() - known.at < A_LOOKED_UP_NAME_STAYS_ANSWERED_MS) return known.reaches
  const TOO_SLOW = Symbol('too slow')
  const reaches = Promise.race([
    dns.promises.lookup(host, { all: true }).then((found) => {
      const own = ownAddresses()
      return found.some((a) => isThisMacsAddress(a.address, own))
    }),
    new Promise<typeof TOO_SLOW>((resolve) =>
      setTimeout(resolve, A_LOOKUP_GIVES_UP_MS, TOO_SLOW).unref()
    )
  ]).then(
    (answer) => {
      if (answer === TOO_SLOW) lookedUp.delete(host)
      return answer !== false
    },
    () => false
  )
  if (lookedUp.size >= LOOKED_UP_NAMES_KEPT) lookedUp.clear()
  lookedUp.set(host, { at: Date.now(), reaches })
  return reaches
}

export async function reachesThisMacsServer(url: string): Promise<boolean> {
  const host = serverHost(url)
  if (host === null) return false
  if (namesThisMacsServer(url)) return true
  if (net.isIP(host)) return false
  return await nameReachesThisMac(host)
}

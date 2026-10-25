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

function isThisMacsAddress(address: string): boolean {
  const ip = unmapped(bare(address))
  if (net.isIPv4(ip)) return ip.startsWith('127.') || ip.startsWith('0.') || ownAddresses().has(ip)
  return ip === '::1' || ip === '::' || ownAddresses().has(ip)
}

function serverHost(url: string): string | null {
  const u = urlOrNull(url)
  return u && SCHEMES_THAT_REACH_A_SERVER.has(u.protocol) ? bare(u.hostname) : null
}

export function namesThisMacsServer(url: string): boolean {
  const host = serverHost(url)
  if (host === null) return false
  return LOOPBACK_NAME.test(host) || (net.isIP(unmapped(host)) !== 0 && isThisMacsAddress(host))
}

export async function reachesThisMacsServer(url: string): Promise<boolean> {
  const host = serverHost(url)
  if (host === null) return false
  if (namesThisMacsServer(url)) return true
  if (net.isIP(host)) return false
  try {
    const found = await dns.promises.lookup(host, { all: true })
    return found.some((a) => isThisMacsAddress(a.address))
  } catch {
    return false
  }
}

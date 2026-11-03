export type AddressSecurity = 'secure' | 'not-secure' | 'plain'

export interface PageLoad {
  certificateRefused: boolean
  failed: boolean
}

function hostIsLocalLikeChrome(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  return (
    host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1'
  )
}

// PLATFORM§8
export function addressSecurity(url: string, load: PageLoad): AddressSecurity {
  if (load.certificateRefused) return 'not-secure'
  if (load.failed) return 'plain'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'plain'
  }
  if (parsed.protocol === 'https:') return 'secure'
  if (parsed.protocol === 'http:')
    return hostIsLocalLikeChrome(parsed.hostname) ? 'plain' : 'not-secure'
  return 'plain'
}

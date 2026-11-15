import { LOOPBACK_NAME, urlOrNull } from './browserRoute'

export type AddressSecurity = 'secure' | 'not-secure' | 'plain'

export interface PageLoad {
  certificateRefused: boolean
  failed: boolean
}

const LOOPBACK_IPV4_AFTER_URL_PARSING = /^127(\.\d+){3}$/

function hostIsLocalLikeChrome(hostname: string): boolean {
  return (
    LOOPBACK_NAME.test(hostname) ||
    LOOPBACK_IPV4_AFTER_URL_PARSING.test(hostname) ||
    hostname === '[::1]'
  )
}

// PLATFORM§8
export function addressSecurity(url: string, load: PageLoad): AddressSecurity {
  if (load.certificateRefused) return 'not-secure'
  if (load.failed) return 'plain'
  const parsed = urlOrNull(url)
  if (parsed?.protocol === 'https:') return 'secure'
  if (parsed?.protocol === 'http:')
    return hostIsLocalLikeChrome(parsed.hostname) ? 'plain' : 'not-secure'
  return 'plain'
}

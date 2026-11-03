export type AddressSecurity = 'secure' | 'not-secure' | 'plain'

export function addressSecurity(url: string, certificateRefused: boolean): AddressSecurity {
  if (certificateRefused) return 'not-secure'
  if (/^https:/i.test(url)) return 'secure'
  if (/^http:/i.test(url)) return 'not-secure'
  return 'plain'
}

import { describe, it, expect } from 'vitest'
import { addressSecurity } from '../../src/shared/signInAddress'

const LOADED = { certificateRefused: false, failed: false }

describe('the sign-in window marks an address the way Chrome does', () => {
  it('counts the names and loopback addresses Chrome counts as this machine as neither secure nor Not secure', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://LOCALHOST./',
      'http://app.localhost:3000/cb',
      'http://app.localhost./',
      'http://127.0.0.1:8080/',
      'http://127.9.8.7/',
      'http://127.1/',
      'http://[::1]:4000/'
    ])
      expect(addressSecurity(url, LOADED), url).toBe('plain')
  })

  it('still marks http Not secure on a name that only looks local', () => {
    for (const url of [
      'http://localhost.example.com/',
      'http://mylocalhost/',
      'http://127.example.com/',
      'http://127.0.0.1.nip.io/',
      'http://128.0.0.1/',
      'http://[::ffff:127.0.0.1]/',
      'http://10.0.0.5/'
    ])
      expect(addressSecurity(url, LOADED), url).toBe('not-secure')
  })

  it('shows neither mark on a page that failed to load, http or https, unless its certificate was refused', () => {
    const failed = { certificateRefused: false, failed: true }
    expect(addressSecurity('https://example.com/', failed)).toBe('plain')
    expect(addressSecurity('http://example.com/', failed)).toBe('plain')
    expect(
      addressSecurity('https://example.com/', { certificateRefused: true, failed: true })
    ).toBe('not-secure')
  })
})

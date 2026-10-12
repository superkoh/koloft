import { describe, it, expect } from 'vitest'
import { pathWithInstallDir } from '../../src/main/toolInstall'

// CC§10
describe('pathWithInstallDir', () => {
  it('puts the folder the official installers use at the end of a PATH that lacks it, once', () => {
    const once = pathWithInstallDir('/usr/bin:/bin', '/Users/me')
    expect(once).toBe('/usr/bin:/bin:/Users/me/.local/bin')
    expect(pathWithInstallDir(once, '/Users/me')).toBe(once)
  })

  it('leaves a PATH that already has it where the user put it', () => {
    expect(pathWithInstallDir('/Users/me/.local/bin:/usr/bin', '/Users/me')).toBe(
      '/Users/me/.local/bin:/usr/bin'
    )
  })
})

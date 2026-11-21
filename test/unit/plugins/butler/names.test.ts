import { describe, it, expect } from 'vitest'
import { butlerName, peerNamesOf, renamedButler } from '@plugins/butler/shared/names'
import { buildResetPatch, sanitizeLoadedSettings, sanitizeSettingsPatch } from '@shared/settingsOps'

describe('the butler’s name', () => {
  it('is Alfred until the owner picks another, and stays one short line', () => {
    expect(butlerName(undefined)).toBe('Alfred')
    expect(butlerName('   ')).toBe('Alfred')
    expect(butlerName('  Jeeves \n the second ')).toBe('Jeeves the second')
    expect(butlerName('x'.repeat(100))).toHaveLength(40)
  })

  it('other sessions still reach the butler by the names the global Assist had', () => {
    expect(peerNamesOf('Jeeves')).toEqual(['Jeeves', 'Global-Assist', 'Global-conductor'])
  })

  it('a rename keeps every name the butler had before, and survives a save from the window, a restart and a settings reset', () => {
    const once = renamedButler({ name: 'Alfred', formerNames: [] }, ' Jeeves ')
    const back = renamedButler(renamedButler(once, 'Bunter'), 'Alfred')
    expect(once).toEqual({ name: 'Jeeves', formerNames: ['Alfred'] })
    expect(back).toEqual({ name: 'Alfred', formerNames: ['Jeeves', 'Bunter'] })
    expect(sanitizeSettingsPatch({ butler: back })).toEqual({ butler: back })
    expect(buildResetPatch()).not.toHaveProperty('butler')
    expect(sanitizeLoadedSettings({ butler: back }).butler).toEqual(back)
    expect(sanitizeLoadedSettings({ butler: { name: 'Jeeves' } }).butler).toEqual({
      name: 'Jeeves',
      formerNames: []
    })
  })
})

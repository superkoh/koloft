import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { exitSyncWindow } from '../../src/renderer/src/syncOutput'

const term = (core: unknown): Terminal => ({ _core: core }) as unknown as Terminal

describe('exitSyncWindow on xterm internals — the drift branches e2e can never reach', () => {
  it('clears an open sync window', () => {
    const modes = { synchronizedOutput: true }
    exitSyncWindow(term({ coreService: { decPrivateModes: modes } }))
    expect(modes.synchronizedOutput).toBe(false)
  })

  it('leaves a closed window closed', () => {
    const modes = { synchronizedOutput: false }
    exitSyncWindow(term({ coreService: { decPrivateModes: modes } }))
    expect(modes.synchronizedOutput).toBe(false)
  })

  it('does not disturb sibling modes', () => {
    const modes = { synchronizedOutput: true, bracketedPasteMode: true }
    exitSyncWindow(term({ coreService: { decPrivateModes: modes } }))
    expect(modes.bracketedPasteMode).toBe(true)
  })

  it('tolerates a missing, drifted or throwing _core shape, leaving xterm its own 1s safety timeout instead of breaking every resize', () => {
    expect(() => exitSyncWindow(term(undefined))).not.toThrow()
    expect(() => exitSyncWindow(term({}))).not.toThrow()
    expect(() => exitSyncWindow(term({ coreService: {} }))).not.toThrow()
    expect(() => exitSyncWindow({} as unknown as Terminal)).not.toThrow()
    const trapped = new Proxy(
      {},
      {
        get() {
          throw new Error('internal shape trap')
        }
      }
    )
    expect(() => exitSyncWindow(term(trapped))).not.toThrow()
  })
})

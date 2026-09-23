import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { exitSyncWindow } from '../../src/renderer/src/syncOutput'

// exitSyncWindow codes against xterm's INTERNAL shape (_core.coreService.
// decPrivateModes.synchronizedOutput), which no public API mirrors. The e2e spec
// (sync-output-resize.spec.ts) proves the happy path end-to-end but can only ever see
// the real, intact shape — the degradation branches (shape drift after an xterm bump,
// mode already off) are constructible only here.

const term = (core: unknown): Terminal => ({ _core: core }) as unknown as Terminal

describe('exitSyncWindow', () => {
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

  // an xterm bump renamed/moved the internals — degrade silently to the upstream
  // 1s safety timeout instead of breaking every resize
  it('tolerates a missing or drifted _core shape', () => {
    expect(() => exitSyncWindow(term(undefined))).not.toThrow()
    expect(() => exitSyncWindow(term({}))).not.toThrow()
    expect(() => exitSyncWindow(term({ coreService: {} }))).not.toThrow()
    expect(() => exitSyncWindow({} as unknown as Terminal)).not.toThrow()
    // a hostile getter must not escape either
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

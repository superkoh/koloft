import { describe, expect, it } from 'vitest'
import { isValidWorktreeName, portOffset } from '@shared/worktreeName'

describe('isValidWorktreeName (§5 name rule)', () => {
  it('accepts letters, digits, dot, underscore and dash', () => {
    for (const n of ['a', 'payment-retry', 'v1.2_x', 'A9', 'a-b_c.d', 'a'.repeat(64)]) {
      expect(isValidWorktreeName(n), n).toBe(true)
    }
  })

  it('rejects the empty name, over-long names and out-of-charset characters', () => {
    for (const n of ['', ' ', 'a'.repeat(65), 'a b', 'a/b', 'feat:x', 'naïve', 'a~1', 'a?']) {
      expect(isValidWorktreeName(n), n).toBe(false)
    }
  })

  it('rejects exactly what `git check-ref-format --branch worktree-<name>` rejects (probed against real git): trailing dot, `..`, `.lock` suffix — not `.lock` mid-name or a trailing dash', () => {
    for (const n of ['a.', 'a..b', 'a.lock']) {
      expect(isValidWorktreeName(n), n).toBe(false)
    }
    for (const n of ['a.lock.b', 'a.locky', 'a-']) {
      expect(isValidWorktreeName(n), n).toBe(true)
    }
  })

  it('rejects a leading dot even though the worktree- prefix would make git accept it', () => {
    expect(isValidWorktreeName('.hidden')).toBe(false)
  })

  it('rejects a leading dash — the name would reach the launch line flag-shaped (w --force)', () => {
    for (const n of ['-x', '--force', '-rf']) {
      expect(isValidWorktreeName(n), n).toBe(false)
    }
    expect(isValidWorktreeName('a-b')).toBe(true)
  })
})

describe('portOffset', () => {
  it('gives one worktree name the same offset every time, so a restarted session keeps its ports', () => {
    expect(portOffset('codex-feature')).toBe(50)
    expect(portOffset('featr')).toBe(20)
  })

  it('stays within 1..99 and spreads different names over the range', () => {
    const offsets = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const n = portOffset(`wt-${i}`)
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(99)
      offsets.add(n)
    }
    expect(offsets.size).toBeGreaterThan(80)
  })
})

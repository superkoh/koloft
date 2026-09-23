import { describe, expect, it } from 'vitest'
import { isValidWorktreeName } from '@shared/worktreeName'

// The `-w <name>` rule, shared since D11 because main
// now refuses what the renderer refuses instead of dropping the flag.

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

  it('rejects what `git check-ref-format --branch worktree-<name>` rejects', () => {
    // probed against real git: trailing dot, `..`, and a `.lock` suffix all fail
    for (const n of ['a.', 'a..b', 'a.lock']) {
      expect(isValidWorktreeName(n), n).toBe(false)
    }
    // …and only those — `.lock` mid-name and a trailing dash are legal refs
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
    // dash anywhere else stays legal
    expect(isValidWorktreeName('a-b')).toBe(true)
  })
})

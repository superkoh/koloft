// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { parseUnifiedDiff } from '../../src/shared/unifiedDiff'

const pending: { codes: string[]; resolve: (html: string[][]) => void }[] = []

vi.mock('../../src/renderer/src/offThread', () => ({
  dropQueuedColoring: () => {},
  highlightLinesOffThread: (_owner: object, codes: string[]) =>
    new Promise<string[][]>((resolve) => pending.push({ codes, resolve }))
}))

const { InlineDiff } = await import('../../src/renderer/src/components/InlineDiff')

const colored = (text: string): string => `<b class="hl">${text}</b>`

async function finishColoring(): Promise<void> {
  const job = pending.shift()!
  await act(async () => job.resolve(job.codes.map((code) => code.split('\n').map(colored))))
}

function rowsOf(container: HTMLElement): { text: string; colored: boolean }[] {
  return [...container.querySelectorAll('.idiff-code')].map((el) => ({
    text: el.textContent ?? '',
    colored: el.querySelector('.hl') != null
  }))
}

afterEach(() => {
  cleanup()
  pending.length = 0
})

describe('InlineDiff recoloring after a change', () => {
  it('keeps the colors of rows whose text did not change until the new colors arrive, and never gives a changed row old colors', async () => {
    const before = parseUnifiedDiff(
      '@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 3\n const c = 4'
    )
    const after = parseUnifiedDiff(
      '@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 5\n const c = 4'
    )
    const { container, rerender } = render(<InlineDiff src="x.ts" parsed={before} />)
    await finishColoring()
    expect(rowsOf(container).every((r) => r.colored)).toBe(true)

    rerender(<InlineDiff src="x.ts" parsed={after} />)
    expect(rowsOf(container)).toEqual([
      { text: 'const a = 1', colored: true },
      { text: 'const b = 2', colored: true },
      { text: 'const b = 5', colored: false },
      { text: 'const c = 4', colored: true }
    ])

    await finishColoring()
    expect(rowsOf(container).every((r) => r.colored)).toBe(true)
    expect(rowsOf(container)[2].text).toBe('const b = 5')
  })
})

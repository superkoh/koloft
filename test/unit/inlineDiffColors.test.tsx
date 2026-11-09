// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { parseUnifiedDiff } from '../../src/shared/unifiedDiff'
import { InlineDiff } from '../../src/renderer/src/components/InlineDiff'

const pending: {
  codes: string[]
  resolve: (html: string[][]) => void
  reject: (e: Error) => void
}[] = []

vi.mock('../../src/renderer/src/offThread', () => ({
  dropQueuedColoring: () => {},
  highlightLinesOffThread: (_owner: object, codes: string[]) =>
    new Promise<string[][]>((resolve, reject) => pending.push({ codes, resolve, reject }))
}))

const SIDES = ['new', 'old']

async function finishColoring(): Promise<void> {
  const job = pending.shift()!
  await act(async () =>
    job.resolve(
      job.codes.map((code, k) =>
        code.split('\n').map((text) => `<b data-side="${SIDES[k]}">${text}</b>`)
      )
    )
  )
}

async function failColoring(): Promise<void> {
  const job = pending.shift()!
  await act(async () => job.reject(new Error('worker died')))
}

function rowsOf(container: HTMLElement): { text: string; side: string | null }[] {
  return [...container.querySelectorAll('.idiff-code')].map((el) => ({
    text: el.textContent ?? '',
    side: el.querySelector('b')?.dataset.side ?? null
  }))
}

const diff = (body: string): ReturnType<typeof parseUnifiedDiff> =>
  parseUnifiedDiff('@@ -1,3 +1,3 @@\n' + body)

afterEach(() => {
  cleanup()
  pending.length = 0
})

describe('InlineDiff recoloring after a change', () => {
  it('keeps the colors of rows whose text did not change until the new colors arrive, and shows a row whose text is new as plain text', async () => {
    const { container, rerender } = render(
      <InlineDiff
        src="x.ts"
        parsed={diff(' const a = 1\n-const b = 2\n+const b = 3\n const c = 4')}
      />
    )
    await finishColoring()

    rerender(
      <InlineDiff
        src="x.ts"
        parsed={diff(' const a = 1\n-const b = 2\n+const b = 5\n const c = 4')}
      />
    )
    expect(rowsOf(container)).toEqual([
      { text: 'const a = 1', side: 'new' },
      { text: 'const b = 2', side: 'old' },
      { text: 'const b = 5', side: null },
      { text: 'const c = 4', side: 'new' }
    ])

    await finishColoring()
    expect(rowsOf(container).map((r) => r.side)).toEqual(['new', 'old', 'new', 'new'])
  })

  it('while recoloring, a deleted row reuses the old side and every other row the new side', async () => {
    const { container, rerender } = render(<InlineDiff src="x.ts" parsed={diff('-x\n+x')} />)
    await finishColoring()

    rerender(<InlineDiff src="x.ts" parsed={diff('-x\n+y\n x')} />)
    expect(rowsOf(container)).toEqual([
      { text: 'x', side: 'old' },
      { text: 'y', side: null },
      { text: 'x', side: 'new' }
    ])
  })

  it('goes back to plain text when the new coloring fails, instead of keeping the old colors', async () => {
    const { container, rerender } = render(<InlineDiff src="x.ts" parsed={diff(' a\n-b\n+c')} />)
    await finishColoring()

    rerender(<InlineDiff src="x.ts" parsed={diff(' a\n-b\n+d')} />)
    await failColoring()
    expect(rowsOf(container).map((r) => r.side)).toEqual([null, null, null])
  })
})

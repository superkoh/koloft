import { describe, it, expect } from 'vitest'
import { diffLines } from '../../src/renderer/src/components/editDiff'

const kinds = (o: string, n: string): string[] => diffLines(o, n).rows.map((r) => r.kind)
const texts = (o: string, n: string): string[] => diffLines(o, n).rows.map((r) => r.text)

describe('diffLines', () => {
  it('calls two identical files unchanged and shows every line as context', () => {
    const d = diffLines('a\nb\n', 'a\nb\n')
    expect(d.hasChange).toBe(false)
    expect(d.rows).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'ctx', oldNo: 2, newNo: 2, text: 'b' }
    ])
  })

  it('does not turn a trailing newline into an empty last row', () => {
    expect(diffLines('a\n', 'a\n').rows).toHaveLength(1)
    expect(diffLines('a', 'a').rows).toHaveLength(1)
  })

  it('shows an appended line as one addition, numbered on the new side only', () => {
    const d = diffLines('a\nb\n', 'a\nb\nc\n')
    expect(d.hasChange).toBe(true)
    expect(d.rows[2]).toEqual({ kind: 'add', oldNo: null, newNo: 3, text: 'c' })
    expect(kinds('a\nb\n', 'a\nb\nc\n')).toEqual(['ctx', 'ctx', 'add'])
  })

  it('shows a removed line as one deletion, numbered on the old side only', () => {
    const d = diffLines('a\nb\nc\n', 'a\nc\n')
    expect(d.rows[1]).toEqual({ kind: 'del', oldNo: 2, newNo: null, text: 'b' })
    expect(kinds('a\nb\nc\n', 'a\nc\n')).toEqual(['ctx', 'del', 'ctx'])
  })

  it('keeps the untouched lines around a changed one as context', () => {
    const d = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    expect(d.rows).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'del', oldNo: 2, newNo: null, text: 'b' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'B' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'c' }
    ])
  })

  it('carries both writers’ lines when each added one of their own (BB-M08)', () => {
    const theirs = 'x\nTHEIRS=1\n'
    const mine = 'x\nMINE=1\n'
    expect(texts(theirs, mine)).toEqual(['x', 'THEIRS=1', 'MINE=1'])
    expect(kinds(theirs, mine)).toEqual(['ctx', 'del', 'add'])
  })

  it('treats an empty file as no lines at all, so a first save reads as pure addition', () => {
    const d = diffLines('', 'a\n')
    expect(d.rows).toEqual([{ kind: 'add', oldNo: null, newNo: 1, text: 'a' }])
    expect(d.hasChange).toBe(true)
  })

  it('reconstructs each side, which is what the renderer highlights', () => {
    const d = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    expect(d.oldText).toBe('a\nb\nc')
    expect(d.newText).toBe('a\nB\nc')
  })
})

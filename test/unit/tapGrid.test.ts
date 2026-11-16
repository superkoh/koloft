import { describe, expect, it } from 'vitest'
import { boxAround, clipTo, gridOver, readSquares } from '../../src/main/tapGrid'

describe('the grid the owner names squares on', () => {
  it('has squares of at least 24 px, about 120 of them, and at most 26 columns (A to Z)', () => {
    const at = (width: number, height: number): [number, number, number] => {
      const g = gridOver({ x: 0, y: 0, width, height })
      return [g.side, g.columns, g.rows]
    }
    expect(at(300, 76)).toEqual([24, 13, 4])
    expect(at(520, 570)).toEqual([50, 11, 12])
    expect(at(1280, 800)).toEqual([93, 14, 9])
    expect(at(2000, 40)).toEqual([77, 26, 1])
  })

  it('turns each named square, in any case and with commas or spaces, into the middle of that square on the page, in the order named', () => {
    const grid = gridOver({ x: 100, y: 50, width: 300, height: 76 })
    expect(readSquares(grid, 'b2, a1')).toEqual({
      names: ['B2', 'A1'],
      points: [
        { x: 136, y: 86 },
        { x: 112, y: 62 }
      ]
    })
  })

  it('aims a square cut short at the edge at the middle of the part that is on the picture', () => {
    const grid = gridOver({ x: 0, y: 0, width: 300, height: 76 })
    expect(readSquares(grid, 'M4')).toEqual({ names: ['M4'], points: [{ x: 294, y: 74 }] })
  })

  it('taps nothing when any name is not a square on the picture, and says which', () => {
    const grid = gridOver({ x: 0, y: 0, width: 300, height: 76 })
    expect(readSquares(grid, 'A1 N1 A5 hello')).toEqual({ unknown: ['N1', 'A5', 'HELLO'] })
    expect(readSquares(grid, '  ')).toEqual({ unknown: [] })
  })
})

describe('the part of the page the picture shows', () => {
  it('takes in the named element and every frame that came into view, cut to what is in view', () => {
    const around = boxAround([
      { x: 10, y: 10, width: 300, height: 76 },
      { x: 40, y: 100, width: 400, height: 580 }
    ])
    expect(around).toEqual({ x: 10, y: 10, width: 430, height: 670 })
    expect(clipTo(around, { x: 0, y: 0, width: 1000, height: 600 })).toEqual({
      x: 10,
      y: 10,
      width: 430,
      height: 590
    })
    expect(clipTo(around, { x: 0, y: 700, width: 1000, height: 600 })).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { pictureRows } from '../../src/main/discord/pageShot'

describe('a page shot for Discord', () => {
  // PLATFORM§16
  it('is cut into pictures no taller than one capture can be at the screen’s pixel ratio, top to bottom', () => {
    expect(pictureRows({ width: 1280, height: 3000 }, 2)).toEqual([0])
    expect(pictureRows({ width: 1280, height: 20000 }, 2)).toEqual([0, 8000, 16000])
    expect(pictureRows({ width: 1280, height: 20000 }, 1)).toEqual([0, 16000])
  })

  it('stops at ten pictures, the most one Discord message carries', () => {
    expect(pictureRows({ width: 1280, height: 200000 }, 2)).toHaveLength(10)
  })
})

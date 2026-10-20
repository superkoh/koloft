import { describe, it, expect } from 'vitest'
import { pictureClips } from '../../src/main/discord/pageShot'

const ys = (clips: { y: number }[]): number[] => clips.map((c) => c.y)

describe('a page shot for Discord', () => {
  // PLATFORM§16
  it('is cut into pictures no taller or wider than one capture can be at the screen’s pixel ratio, top to bottom', () => {
    expect(pictureClips({ width: 1280, height: 3000 }, 2)).toEqual([
      { y: 0, width: 1280, height: 3000 }
    ])
    expect(pictureClips({ width: 1280, height: 20000 }, 2)).toEqual([
      { y: 0, width: 1280, height: 8000 },
      { y: 8000, width: 1280, height: 8000 },
      { y: 16000, width: 1280, height: 4000 }
    ])
    expect(ys(pictureClips({ width: 1280, height: 20000 }, 1))).toEqual([0, 16000])
    expect(pictureClips({ width: 30000, height: 100 }, 2)[0].width).toBe(8000)
  })

  it('stops at ten pictures, the most one Discord message carries', () => {
    expect(pictureClips({ width: 1280, height: 200000 }, 2)).toHaveLength(10)
  })
})

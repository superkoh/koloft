import { describe, expect, it } from 'vitest'
import { pastedPicturesIn } from '../../src/shared/pastedPictures'

const DIR = '/Users/me/Library/Application Support/koloft (dev)/palette-pictures'
const A = `${DIR}/0b0e7a52-6f0c-4c1e-9f44-2f1d1c5a9a10.png`
const B = `${DIR}/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg`

describe('pastedPicturesIn', () => {
  it('finds each pasted picture once wherever a prompt names it, also after a helper reworded the line, and nothing outside the folder', () => {
    const prompt = `fix it\n\nPicture: ${A}\nSee also (${B}) and again ${A}.\nPicture: /tmp/other.png`
    expect(pastedPicturesIn(prompt, DIR)).toEqual([A, B])
    expect(pastedPicturesIn('no picture here', DIR)).toEqual([])
  })
})

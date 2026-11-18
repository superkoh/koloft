import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const entry = fs.readFileSync(path.join(__dirname, '../../../../src/main/index.ts'), 'utf8')

describe('what the owner reads when a picked element has no picture, pinned so that moving it changes no character', () => {
  it.each([
    '`The picture of the element could not be taken: ${picked.pictureFailed}`',
    '`The picture of the element could not be copied to ${machine}: ${why}`',
    '`The picture of the element could not be saved: ${why}`'
  ])('%s', (text) => {
    expect(entry).toContain(text)
  })
})

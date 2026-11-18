import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const entry = fs.readFileSync(path.join(__dirname, '../../../../src/main/index.ts'), 'utf8')

describe('what an agent driving a page hears when a tab operation fails, pinned so that moving it changes no character', () => {
  it.each([
    "'the Koloft window did not answer'",
    "'could not open that tab'",
    "'could not create a tab'"
  ])('%s', (text) => {
    expect(entry).toContain(text)
  })
})

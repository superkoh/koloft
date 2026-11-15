import { createRequire } from 'module'
import path from 'path'
import { expect, it } from 'vitest'

it('a unit test that loads the electron package never looks for, or downloads, its binary', () => {
  const electronPath: string = createRequire(import.meta.url)('electron')
  expect(electronPath).toContain(path.join('test', 'unit', 'no-electron-binary', path.sep))
})

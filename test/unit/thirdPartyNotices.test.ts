import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const root = path.resolve(__dirname, '../..')
const script = path.join(root, 'scripts/third-party-notices.mjs')
const read = (file: string) => fs.readFileSync(file, 'utf8').trim()
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-notices-'))
afterAll(() => fs.rmSync(out, { recursive: true, force: true }))

function writeBundleLicenses(build: string, entries: unknown[]) {
  fs.mkdirSync(path.join(out, build, '.vite'), { recursive: true })
  fs.writeFileSync(path.join(out, build, '.vite/license.json'), JSON.stringify(entries))
}

function generateNotices(): string {
  const reactIcons = path.join(root, 'node_modules/react-icons')
  writeBundleLicenses('main', [])
  writeBundleLicenses('preload', [])
  writeBundleLicenses('renderer', [
    {
      name: 'react-icons',
      version: JSON.parse(read(path.join(reactIcons, 'package.json'))).version,
      identifier: 'MIT',
      text: read(path.join(reactIcons, 'LICENSE'))
    }
  ])
  const run = spawnSync(process.execPath, [script, out], { encoding: 'utf8' })
  expect(run.stderr).toBe('')
  return fs.readFileSync(path.join(out, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
}

describe('third-party notices', () => {
  const notices = generateNotices()

  it("carries a bundled package's license and those of the Bootstrap and LobeHub marks the app draws", () => {
    expect(notices).toContain(read(path.join(root, 'node_modules/react-icons/LICENSE')))
    expect(notices).toContain(read(path.join(root, 'build/licenses/bootstrap-icons.txt')))
    expect(notices).toContain(read(path.join(root, 'build/licenses/lobehub-icons.txt')))
  })

  it('lists every production dependency the app ships, at its installed version', () => {
    const { dependencies } = JSON.parse(read(path.join(root, 'package.json')))
    for (const name of Object.keys(dependencies)) {
      const { version } = JSON.parse(read(path.join(root, 'node_modules', name, 'package.json')))
      expect(notices).toContain(`==== ${name} ${version} ====`)
    }
  })
})

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-machine-package-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(async () => {
  await BackgroundFile.whenAllWritten()
  fs.rmSync(app.getPath('userData'), { recursive: true, force: true })
})

import { knowPluginStates } from '@core/switches'
import { plugin as passwordsPlugin } from '@plugins/passwords/plugin'
import {
  AGENT_PLUGIN_DIR,
  buildMachinePackage,
  DOCS_PLUGIN_DIR
} from '../../src/main/remote/launch'
import { machinePackageFiles } from '../../src/main/remote/machinePackageFiles'
import { makeWorld, type World } from './helpers/agentTabs'
import { BackgroundFile } from '../../src/main/backgroundFile'

const PINNED = './machine-package'
const PROMPT_TEXT = path.join(__dirname, 'prompt-text')
const STATUS_LINE_BUNDLE = path.join(__dirname, '../../node_modules/ccstatusline/dist')
const KOLOFT_SKILL = `${AGENT_PLUGIN_DIR}skills/koloft/SKILL.md`

interface Built {
  name: string
  dir: string
  files: string[]
}

let world: World

beforeEach(() => {
  world = makeWorld()
})

afterEach(async () => {
  knowPluginStates({})
  await world.gone()
})

function machinePackageWith(passwords: boolean): Built {
  knowPluginStates({ [passwordsPlugin.id]: { on: passwords } })
  const pkg = buildMachinePackage(path.join(world.userData, 'remote', 'pkg'), machinePackageFiles())
  const files = fs
    .readdirSync(pkg.dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel !== '.complete' && fs.statSync(path.join(pkg.dir, rel)).isFile())
    .sort()
  return { ...pkg, files }
}

const bytesOf = (pkg: Built, rel: string): Buffer => fs.readFileSync(path.join(pkg.dir, rel))

const fromTheStatusLineBundle = (rel: string): boolean =>
  rel.startsWith('statusline/') &&
  fs.existsSync(path.join(STATUS_LINE_BUNDLE, rel.slice('statusline/'.length)))

function pinnedInPromptText(rel: string, passwords: boolean): string | undefined {
  if (!passwords && rel === KOLOFT_SKILL) return 'passwords-off/koloft-skill.md'
  if (rel.startsWith(AGENT_PLUGIN_DIR))
    return `koloft-plugin/${rel.slice(AGENT_PLUGIN_DIR.length)}.txt`
  if (rel.startsWith(DOCS_PLUGIN_DIR))
    return `koloft-docs-plugin/${rel.slice(DOCS_PLUGIN_DIR.length)}.txt`
  return undefined
}

function asPinned(pkg: Built, rels: string[], passwords: boolean): string {
  return rels
    .map((rel) => {
      const executable = fs.statSync(path.join(pkg.dir, rel)).mode & 0o100
      const pinnedIn = pinnedInPromptText(rel, passwords)
      const text = fromTheStatusLineBundle(rel)
        ? "(the file of the same name in ccstatusline's dist folder, byte for byte)"
        : pinnedIn
          ? `(its text is pinned in prompt-text/${pinnedIn})`
          : bytesOf(pkg, rel).toString('utf8')
      return `=== file ${rel}${executable ? ' (executable)' : ''} ===\n${text}`
    })
    .join('\n')
}

function nameFromTheFilesOnDisk(pkg: Built): string {
  const h = crypto.createHash('sha256')
  for (const rel of pkg.files) {
    h.update(rel)
    h.update('\0')
    h.update(bytesOf(pkg, rel))
    h.update('\0')
  }
  return `m-${h.digest('hex').slice(0, 16)}`
}

describe('the machine package Koloft pushes once to every machine it has a tab on, pinned so that moving the code changes no character', () => {
  it('every file in it, whether it is executable, and its text, with every plugin on as Koloft ships', async () => {
    const pkg = machinePackageWith(true)
    await expect(asPinned(pkg, pkg.files, true)).toMatchFileSnapshot(`${PINNED}/passwords-on.txt`)
  })

  it('with the passwords plugin off, the files it leaves out and the ones whose text changes', async () => {
    const on = machinePackageWith(true)
    const off = machinePackageWith(false)
    expect(on.files).toEqual(expect.arrayContaining(off.files))
    const leftOut = on.files.filter((rel) => !off.files.includes(rel))
    const changed = off.files.filter((rel) => !bytesOf(off, rel).equals(bytesOf(on, rel)))
    await expect(
      ['=== left out ===', ...leftOut, asPinned(off, changed, false)].join('\n')
    ).toMatchFileSnapshot(`${PINNED}/passwords-off-what-differs.txt`)
  })

  it("its name is the hash of every file's path and bytes in path order, so a change to any file, ccstatusline's too, names a new package", async () => {
    const on = machinePackageWith(true)
    const off = machinePackageWith(false)
    expect(on.name).toBe(nameFromTheFilesOnDisk(on))
    expect(off.name).toBe(nameFromTheFilesOnDisk(off))
    await expect(`passwords on: ${on.name}\npasswords off: ${off.name}\n`).toMatchFileSnapshot(
      `${PINNED}/names.txt`
    )
  })

  it.each([true, false])(
    "with the passwords plugin on: %s, the status line bundle's files are ccstatusline's own byte for byte, and the two plugins' files are the texts prompt-text pins",
    (passwords) => {
      const pkg = machinePackageWith(passwords)
      const bundled = fs.readdirSync(STATUS_LINE_BUNDLE).sort()
      expect(pkg.files.filter(fromTheStatusLineBundle)).toEqual(
        bundled.map((name) => `statusline/${name}`)
      )
      for (const name of bundled)
        expect(bytesOf(pkg, `statusline/${name}`)).toEqual(
          fs.readFileSync(path.join(STATUS_LINE_BUNDLE, name))
        )
      const pluginFiles = pkg.files.filter((rel) => pinnedInPromptText(rel, passwords))
      expect(pluginFiles).toContain(KOLOFT_SKILL)
      for (const rel of pluginFiles)
        expect(bytesOf(pkg, rel).toString('utf8')).toBe(
          fs.readFileSync(path.join(PROMPT_TEXT, pinnedInPromptText(rel, passwords)!), 'utf8')
        )
    }
  )
})

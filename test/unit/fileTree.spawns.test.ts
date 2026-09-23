import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { search } from '../../src/main/fileTree'

/**
 * A-07 — the `ls-files` spawns behind ⌘P must set `maxBuffer`.
 *
 * Node's default is 1 MB, and a real repo blows past it: measured on a checkout with a
 * 20 000-file `node_modules`, the ignored listing alone printed 1 240 022 bytes. Over the
 * limit the child throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, the catch swallows it, and
 * search silently falls back to walking the whole tree — the user just sees "⌘P got slow
 * and the results are wrong", with nothing logged anywhere.
 *
 * Pinned with a fake `git` earlier on PATH that prints ~1.4 MB for each of the three
 * listings (tracked / untracked / ignored), the same recording-binary trick
 * `gitStatus.spawns.test.ts` uses. Production code is what runs; only the git answer is
 * staged. If any of the three spawns loses its buffer, its files stop being findable.
 */

let tmp: string
let root: string
let savedPath: string | undefined

/** ~1.4 MB of NUL-separated relative paths, well past Node's 1 MB default */
function payload(prefix: string): string {
  const pad = 'x'.repeat(40)
  const names: string[] = []
  for (let i = 0; i < 25000; i++) {
    names.push(`${prefix}${pad}/${prefix}${String(i).padStart(5, '0')}.txt`)
  }
  return names.join('\0') + '\0'
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ftbuf-')))
  root = path.join(tmp, 'repo')
  fs.mkdirSync(root)
  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  const files = {
    trk: path.join(tmp, 'tracked.txt'),
    oth: path.join(tmp, 'others.txt'),
    ign: path.join(tmp, 'ignored.txt')
  }
  fs.writeFileSync(files.trk, payload('trk'))
  fs.writeFileSync(files.oth, payload('oth'))
  fs.writeFileSync(files.ign, payload('ign'))
  // --ignored is checked first: that invocation carries --others too. Anything that is
  // not `ls-files` is handed to the real git rather than failed — this binary sits on
  // PATH, and a fake that answered "exit 1" to, say, a check-ignore would look exactly
  // like the A-08 bug to any suite that ever shared this process.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh
case " $* " in
  *" --ignored "*) cat ${files.ign}; exit 0;;
  *" --others "*) cat ${files.oth}; exit 0;;
  *" ls-files "*) cat ${files.trk}; exit 0;;
esac
exec ${realGit} "$@"
`,
    { mode: 0o755 }
  )
  savedPath = process.env.PATH
  process.env.PATH = bin + ':' + savedPath
})

afterAll(() => {
  process.env.PATH = savedPath
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('search survives a git listing bigger than 1 MB', () => {
  it('finds a tracked file', async () => {
    const { hits } = await search(root, 'trk00042', { showIgnored: true })
    expect(hits.map((h) => h.name)).toEqual(['trk00042.txt'])
  })

  it('finds an untracked file', async () => {
    const { hits } = await search(root, 'oth00042', { showIgnored: true })
    expect(hits.map((h) => h.name)).toEqual(['oth00042.txt'])
  })

  it('finds an ignored file, marked', async () => {
    const { hits } = await search(root, 'ign00042', { showIgnored: true })
    expect(hits.map((h) => h.name)).toEqual(['ign00042.txt'])
    expect(hits[0].ignored).toBe(true)
  })
})

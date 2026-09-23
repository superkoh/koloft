import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * The one place anything leaves Koloft for the OS (PRD TEST-2 / SEC-4). Two properties are
 * asserted here rather than in e2e: the scheme whitelist (a suite can show one refusal,
 * not a family) and the suppression seam — a test run must never launch a real app, so
 * "nothing escaped" has to be readable from the log even while the hand-off is off.
 */
const calls = vi.hoisted(() => ({
  external: [] as string[],
  paths: [] as string[],
  revealed: [] as string[]
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => {
      calls.external.push(url)
      return Promise.resolve()
    },
    openPath: (p: string) => {
      calls.paths.push(p)
      return Promise.resolve('')
    },
    showItemInFolder: (p: string) => {
      calls.revealed.push(p)
    }
  }
}))

const { leaveForOS, openUrlExternally, osOpenFallback } = await import('../../src/main/osOpen')

let dir = ''
let log = ''

beforeEach(() => {
  calls.external.length = 0
  calls.paths.length = 0
  calls.revealed.length = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-osopen-'))
  log = path.join(dir, 'external-opens')
  process.env.KOLOFT_EXTERNAL_OPENS_FILE = log
  delete process.env.KOLOFT_SUPPRESS_OS_OPEN
})

afterEach(() => {
  delete process.env.KOLOFT_EXTERNAL_OPENS_FILE
  delete process.env.KOLOFT_SUPPRESS_OS_OPEN
  fs.rmSync(dir, { recursive: true, force: true })
})

/** the choke-point log once all `n` async appends have landed, sorted: two appends
 *  fired in the same tick reach the file in either order, and every reader of this file
 *  (the suite's own `osHandoffs`) filters rather than indexes. */
async function logged(n: number): Promise<string[]> {
  return vi.waitFor(() => {
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(n)
    return lines.sort()
  })
}

describe('leaveForOS', () => {
  it('records every hand-off and performs the one the kind asks for', async () => {
    leaveForOS('https://koloft.test/a', 'url')
    expect(await logged(1)).toEqual(['https://koloft.test/a'])
    expect(calls.external).toEqual(['https://koloft.test/a'])
    expect(calls.paths).toEqual([])

    leaveForOS('/tmp/report.pdf', 'path')
    expect(calls.paths).toEqual(['/tmp/report.pdf'])
  })

  it('reveals a file without opening it (the download toast may not launch anything)', async () => {
    leaveForOS('/tmp/downloads/report.pdf', 'reveal')
    expect(await logged(1)).toEqual(['/tmp/downloads/report.pdf'])
    expect(calls.revealed).toEqual(['/tmp/downloads/report.pdf'])
    expect(calls.paths).toEqual([])
    expect(calls.external).toEqual([])
  })

  it('still records, but performs nothing, while the suppression seam is set', async () => {
    process.env.KOLOFT_SUPPRESS_OS_OPEN = '1'
    leaveForOS('https://koloft.test/a', 'url')
    leaveForOS('/tmp/report.pdf', 'path')
    leaveForOS('/tmp/downloads/report.pdf', 'reveal')
    expect(await logged(3)).toEqual([
      '/tmp/downloads/report.pdf',
      '/tmp/report.pdf',
      'https://koloft.test/a'
    ])
    expect(calls.external).toEqual([])
    expect(calls.paths).toEqual([])
    expect(calls.revealed).toEqual([])
  })
})

describe('openUrlExternally (SEC-4: the escape hatch is http/https/mailto/tel only)', () => {
  it('hands over the four whitelisted schemes', async () => {
    openUrlExternally('https://koloft.test/a')
    openUrlExternally('http://localhost:5173/')
    openUrlExternally('mailto:user@koloft.test')
    openUrlExternally('tel:+15551234')
    expect(calls.external).toEqual([
      'https://koloft.test/a',
      'http://localhost:5173/',
      'mailto:user@koloft.test',
      'tel:+15551234'
    ])
    expect(await logged(4)).toHaveLength(4)
  })

  it('refuses everything else outright — nothing performed, nothing recorded', () => {
    openUrlExternally('file:///Applications/Evil.app')
    openUrlExternally('zoommtg://koloft-e2e-meeting')
    openUrlExternally('javascript:alert(1)')
    openUrlExternally('data:text/html,<h1>koloft</h1>')
    openUrlExternally('/Applications/Evil.app')
    expect(calls.external).toEqual([])
    expect(fs.existsSync(log)).toBe(false)
  })
})

describe('osOpenFallback', () => {
  it('sends an absolute path to the file opener and a whitelisted url to the url opener', async () => {
    osOpenFallback('/tmp/report.pdf')
    osOpenFallback('https://koloft.test/a')
    expect(calls.paths).toEqual(['/tmp/report.pdf'])
    expect(calls.external).toEqual(['https://koloft.test/a'])
    expect(await logged(2)).toEqual(['/tmp/report.pdf', 'https://koloft.test/a'])
  })

  it('drops a target that is neither', () => {
    osOpenFallback('zoommtg://koloft-e2e-meeting')
    osOpenFallback('')
    expect(calls.paths).toEqual([])
    expect(calls.external).toEqual([])
    expect(fs.existsSync(log)).toBe(false)
  })
})

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGY_LIST_JS, historyEntries, type SummaryRow } from '../../src/main/agyStore'
import { AGY_LIST_FILE, listAgyCmd } from '../../src/main/remote/agyTab'
import { writeSummaries } from './helpers/agyStore'

let home: string

function onMachine(cmd: string): { code: number | null; stdout: string } {
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin' }
  })
  return { code: r.status, stdout: r.stdout }
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-machine-')))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('the command Koloft runs on a remote machine to list its Antigravity conversations (AGY§8)', () => {
  it("lists the machine's conversations with its own Node once Koloft's files are there, and an empty list before, leaving out one whose own db was deleted", () => {
    const cmd = listAgyCmd('m-test')
    expect(onMachine(cmd).stdout).toBe('[]')
    const bin = path.join(home, '.koloft', 'node', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.symlinkSync(process.execPath, path.join(bin, 'node'))
    fs.mkdirSync(path.join(home, '.koloft', 'm-test'))
    fs.writeFileSync(path.join(home, '.koloft', 'm-test', AGY_LIST_FILE), AGY_LIST_JS)
    writeSummaries(path.join(home, '.gemini'), [
      {
        conversation_id: 'c1',
        title: 'On the box',
        workspace_uris: JSON.stringify(['file:///home/me/proj']),
        step_count: 3
      },
      { conversation_id: 'c2', title: 'Never used', step_count: 0 },
      {
        conversation_id: 'c3',
        title: 'Deleted',
        workspace_uris: JSON.stringify(['file:///home/me/proj']),
        dbRemoved: true
      }
    ])
    const rows = JSON.parse(onMachine(cmd).stdout) as SummaryRow[]
    expect(historyEntries(rows)).toEqual([
      expect.objectContaining({ id: 'c1', name: 'On the box', cwd: '/home/me/proj' })
    ])
  })
})

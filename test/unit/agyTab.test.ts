import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGY_LIST_JS, historyEntries, type SummaryRow } from '../../src/main/agyStore'
import { AGY_BRAIN_FLAGS, AGY_LIST_FILE, listAgyCmd } from '../../src/main/remote/agyTab'
import { answerOf } from '../../src/main/remote/ssh'
import { writeSummaries } from './helpers/agyStore'

let home: string

function onMachine(cmd: string): { code: number | null; stdout: string } {
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    env: { HOME: home, PATH: '/usr/bin:/bin' }
  })
  return { code: r.status, stdout: answerOf(cmd, r.stdout).toString('utf8') }
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-machine-')))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('the command Koloft runs on a remote machine to list its Antigravity conversations (AGY§8)', () => {
  it("lists the machine's conversations with its own Node once Koloft's files are there, leaving out one whose own db was deleted, and fails before, so a machine not ready yet never reads as one with no conversations", () => {
    const cmd = listAgyCmd('m-test')
    expect(onMachine(cmd).code).not.toBe(0)
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

it('the pull of a machine’s agy brain brings each conversation’s artifacts, their sidecars and its transcript, and nothing else, so a plan waiting for review can be read on the Mac (AGY§8 AGY§19)', () => {
  const src = path.join(home, 'brain')
  for (const f of [
    'c1/implementation_plan.md',
    'c1/implementation_plan.md.metadata.json',
    'c1/.system_generated/logs/transcript.jsonl',
    'c1/.system_generated/logs/transcript_full.jsonl',
    'c1/.system_generated/steps/3/output.txt',
    'c1/scratch/run.md',
    'c1/notes.txt'
  ]) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true })
    fs.writeFileSync(path.join(src, f), 'x')
  }
  const dst = path.join(home, 'mirror')
  const r = spawnSync('rsync', ['-a', ...AGY_BRAIN_FLAGS, `${src}/`, `${dst}/`], {
    encoding: 'utf8'
  })
  expect(r.stderr).toBe('')
  const mirrored = fs
    .readdirSync(dst, { recursive: true, encoding: 'utf8' })
    .filter((f) => fs.statSync(path.join(dst, f)).isFile())
    .sort()
  expect(mirrored).toEqual([
    'c1/.system_generated/logs/transcript.jsonl',
    'c1/implementation_plan.md',
    'c1/implementation_plan.md.metadata.json'
  ])
})

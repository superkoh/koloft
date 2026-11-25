import { afterAll, describe, it, vi } from 'vitest'
import fs from 'fs'
import { app } from 'electron'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-ask-text-refusals-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(() => fs.rmSync(app.getPath('userData'), { recursive: true, force: true }))

vi.mock('../../src/main/cliRuntime', () => ({
  resolveCliRuntime: async (spec: {
    command: string
    environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  }) => ({
    binary: `/fixture/${spec.command}`,
    env: spec.environment({ HOME: process.env.HOME, PATH: '/usr/bin:/bin' }),
    version: '999.0.0',
    verified: true
  })
}))

vi.mock('../../src/agents/codex/main/codexTransport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agents/codex/main/codexTransport')>()
  const { CodexRpcThatListsNoHooks } = await import('./helpers/codexRpcStub')
  const { codexWires } = await import('./helpers/codexWires')
  return {
    ...real,
    createCodexTransport: async (options: (typeof codexWires)[number]) => {
      codexWires.push(options)
      return { url: 'unix:///test/rpc.sock', stop: async () => {}, request: async () => ({}) }
    },
    CodexRpc: CodexRpcThatListsNoHooks
  }
})

import { A_REFUSALS_TAKE_UP_TO_MS, pinRefusals, useAskTable } from './helpers/askTable'

useAskTable()

describe('every sentence Koloft refuses an answer with that the situations do not show, for each kind of tab', () => {
  it(
    'an answer on its way, one never taken, an old card, someone else, nothing to answer, nothing readable, the owner already at the keys',
    pinRefusals,
    A_REFUSALS_TAKE_UP_TO_MS
  )
})

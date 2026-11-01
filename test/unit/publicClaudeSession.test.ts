import { describe, it, expect } from 'vitest'
import { publicClaudeSession } from '../../src/main/host/hosts'
import type { ClaudeSessionInfo } from '../../src/shared/types'

const SCRATCH = '/home/me/.claude-tmp/-repo/sid/scratchpad'

function claudeTab(remote?: { host: string }): ClaudeSessionInfo {
  return {
    tabId: 't',
    sessionId: 'sid',
    title: 'x',
    cwd: '/repo',
    treeRoot: '/repo',
    alive: true,
    updatedAt: 0,
    jsonlPath: '/home/me/.claude/projects/-repo/sid.jsonl',
    scratchpadDir: SCRATCH,
    files: [],
    remote
  }
}

describe('publicClaudeSession and the Scratchpad folder', () => {
  it('a Claude tab on this Mac hands its folder over in the same top-level field as every other agent', () => {
    expect(publicClaudeSession(claudeTab()).scratchpadDir).toBe(SCRATCH)
  })

  it('a remote Claude tab hands its folder over as a key on that machine, so Browse never lists the Mac’s own folder', () => {
    expect(publicClaudeSession(claudeTab({ host: 'devbox' })).scratchpadDir).toBe(
      `ssh://devbox${SCRATCH}`
    )
  })
})

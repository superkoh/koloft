import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(__dirname, '../..')
const at = (rel: string): string => path.join(repoRoot, rel)
const codexConfig = fs.readFileSync(at('.codex/config.toml'), 'utf8')
const codexHookLines = [...codexConfig.matchAll(/^command = '(.*)'$/gm)].map((m) => m[1])
const agyHookLines = Object.values(
  JSON.parse(fs.readFileSync(at('.agents/hooks.json'), 'utf8')) as Record<
    string,
    Record<string, { command?: string; hooks?: { command: string }[] }[]>
  >
)
  .flatMap((events) => Object.values(events).flat())
  .flatMap((entry) => (entry.hooks ? entry.hooks.map((h) => h.command) : [entry.command!]))

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('the rules every agent reads, and the hooks that enforce them', () => {
  it.each(['CLAUDE.md', 'test/CLAUDE.md'])('%s is a symlink to the AGENTS.md beside it', (rel) => {
    expect(fs.lstatSync(at(rel)).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(at(rel))).toBe('AGENTS.md')
  })

  it('both AGENTS.md files together fit in what .codex/config.toml lets Codex read', () => {
    const limit = Number(/^project_doc_max_bytes = (\d+)$/m.exec(codexConfig)?.[1])
    const size = fs.statSync(at('AGENTS.md')).size + fs.statSync(at('test/AGENTS.md')).size
    expect(limit).toBe(65_536)
    expect(size).toBeLessThanOrEqual(limit)
  })

  it('keeps the Codex hook lines every machine trusted: change one and run node scripts/trust-codex-hooks.mjs on each machine', () => {
    const line = (check: string): string =>
      `r="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -f "$r/scripts/agent-hook.sh" ] && exec sh "$r/scripts/agent-hook.sh" codex ${check}; exit 0`
    expect(codexHookLines).toEqual([
      line('session-start'),
      line('before-shell-command'),
      line('after-file-edit')
    ])
  })

  it('lets everything through, printing nothing, in a checkout made before agent-hook.sh existed', () => {
    const old = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-oldtree-')))
    createdDirs.push(old)
    execFileSync('git', ['init', '-q', old])
    fs.mkdirSync(path.join(old, '.agents'))
    const runs = [
      ...codexHookLines.map((line) => ({ line, cwd: old })),
      ...agyHookLines.map((line) => ({ line, cwd: path.join(old, '.agents') }))
    ].map(({ line, cwd }) =>
      spawnSync('/bin/sh', ['-c', line], { cwd, input: '{}', encoding: 'utf8' })
    )
    expect(runs).toHaveLength(7)
    expect(runs.map((r) => [r.status, r.stdout])).toEqual(runs.map(() => [0, '']))
  })
})

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeDocsPlugin } from '../../src/main/agentPlugin'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('the koloft-docs plugin Koloft writes for Claude Code', () => {
  // CC§13
  it('is a plugin named koloft-docs holding the koloft-docs skill with its reference files, and a rewrite leaves nothing of an older copy behind', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-docs-plugin-'))
    roots.push(userData)
    const dir = writeDocsPlugin(userData)
    const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8')
    expect(JSON.parse(read('.claude-plugin/plugin.json')).name).toBe('koloft-docs')
    expect(read('skills/koloft-docs/SKILL.md')).toMatch(/^---\nname: koloft-docs\n/)
    expect(read('skills/koloft-docs/references/core.md')).not.toBe('')
    const leftOver = path.join(dir, 'skills', 'koloft-docs', 'references', 'old.md')
    fs.writeFileSync(leftOver, 'old')
    expect(writeDocsPlugin(userData)).toBe(dir)
    expect(fs.existsSync(leftOver)).toBe(false)
    expect(read('skills/koloft-docs/references/core.md')).not.toBe('')
  })
})

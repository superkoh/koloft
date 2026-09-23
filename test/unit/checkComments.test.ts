import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(__dirname, '../..')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
}

function gitInit(dir: string): void {
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir], { env: GIT_ENV })
}

function commitAll(dir: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'], { env: GIT_ENV })
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture'], { env: GIT_ENV })
}

function fixtureRepo(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-comments-')))
  createdDirs.push(dir)
  gitInit(dir)
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.copyFileSync(
    path.join(repoRoot, 'scripts/check-comments.mjs'),
    path.join(dir, 'scripts/check-comments.mjs')
  )
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'))
  write(dir, {
    '.gitignore': 'node_modules\n',
    'docs/claude-code-contract.md': '# CC\n\n## §9 Launch flags\n',
    'docs/codex-cli-contract.md': '# Codex\n\n## 5. Process exit\n',
    'docs/platform-contract.md': '# Platform\n',
    ...files
  })
  commitAll(dir)
  return dir
}

function check(dir: string): { code: number | null; err: string } {
  const r = spawnSync('node', [path.join(dir, 'scripts/check-comments.mjs')], {
    cwd: dir,
    encoding: 'utf8'
  })
  return { code: r.status, err: r.stderr }
}

function hook(dir: string, file: string): { code: number | null; err: string } {
  const r = spawnSync('node', [path.join(dir, 'scripts/check-comments.mjs'), '--hook'], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ tool_input: { file_path: file } })
  })
  return { code: r.status, err: r.stderr }
}

function reportedSites(err: string): string[] {
  return [...err.matchAll(/^ {2}(\S+:\d+) {2}/gm)].map((m) => m[1]).sort()
}

const lines = (...l: string[]): string => l.join('\n') + '\n'

describe('check-comments', () => {
  it('reports only prose comments, never tool directives, markers, or code that merely looks like a comment', () => {
    const dir = fixtureRepo({
      'docs/adr/0001-kept.md': '# 0001 Kept\n',
      'a.ts': lines(
        '// @ts-expect-error',
        "const a: number = 'x'",
        '// ADR-0001',
        '// CC§9 CODEX§5',
        '/* @vite-ignore */',
        'const u = `http://${a}`',
        'const r = /\\/\\/i/',
        '// prose line',
        'const b = 1 // trailing prose',
        '// @ts-expect-error with a reason',
        'const c = 1 /** CC§9 */',
        'export const S = `#!/bin/sh',
        '# shell prose',
        '# CC§9',
        'echo \\${#x} ${u} ${r} ${b} ${c}',
        '`'
      ),
      'b.css': lines(
        '.a {}',
        '/* ADR-0001 */',
        '/* css prose */',
        '.c,',
        '/* selector prose */',
        '.d {}'
      ),
      'c.tsx': lines(
        'export const X = () => (',
        '  <div>',
        '    {/* ADR-0001 */}',
        '    {/* jsx prose */}',
        '  </div>',
        ')'
      )
    })
    const r = check(dir)
    expect(r.code).toBe(1)
    expect(reportedSites(r.err)).toEqual(
      ['a.ts:8', 'a.ts:9', 'a.ts:10', 'a.ts:11', 'a.ts:13', 'b.css:3', 'b.css:4', 'c.tsx:4'].sort()
    )
  })

  it('fails on an uncited ADR, a reused ADR number, and a marker that points nowhere', () => {
    const dir = fixtureRepo({
      'docs/adr/README.md': '# ADRs\n',
      'docs/adr/0001-first.md': '# 0001\n',
      'docs/adr/0001-clash.md': '# 0001\n',
      'docs/adr/0002-orphan.md': '# 0002\n',
      'x.ts': lines('// ADR-0001', '// ADR-0003', '// CC§42', 'export {}')
    })
    const r = check(dir)
    expect(r.code).toBe(1)
    expect(r.err).toContain('ADR number 0001 is used twice')
    expect(r.err).toContain('docs/adr/0002-orphan.md: no code cites ADR-0002')
    expect(r.err).toContain('x.ts:2: ADR-0003 points at no ADR')
    expect(r.err).toContain('x.ts:3: CC§42 points at no ADR')
  })

  it('the hook blocks a comment in the edited file, and ignores files of another checkout', () => {
    const dir = fixtureRepo({ 'a.ts': lines('export const a = 1') })
    expect(hook(dir, path.join(dir, 'a.ts')).code).toBe(0)

    write(dir, { 'a.ts': lines('// added prose', 'export const a = 1') })
    const added = hook(dir, path.join(dir, 'a.ts'))
    expect(added.code).toBe(2)
    expect(reportedSites(added.err)).toEqual(['a.ts:1'])

    const nested = path.join(dir, '.claude/worktrees/other')
    fs.mkdirSync(nested, { recursive: true })
    gitInit(nested)
    write(nested, { 'b.ts': lines('// prose in another checkout', 'export {}') })
    expect(hook(dir, path.join(nested, 'b.ts')).code).toBe(0)
  })
})

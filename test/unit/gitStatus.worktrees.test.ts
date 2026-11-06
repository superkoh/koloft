import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { gitStatus } from '../../src/main/gitStatus'

let tmp: string
let repo: string

const git = (...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitwt-')))
  repo = path.join(tmp, 'work')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
  git('config', 'user.email', 't@t.com')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('gitStatus in a folder that holds session worktrees', () => {
  it('does not list another session’s .claude/worktrees folder as a change of the main folder', async () => {
    git('worktree', 'add', '-q', '.claude/worktrees/other', '-b', 'worktree-other')
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'new\n')
    expect(await gitStatus(repo)).toEqual({ [path.join(repo, 'mine.txt')]: 'untracked' })
  })
})

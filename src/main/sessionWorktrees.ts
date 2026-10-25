import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { isValidWorktreeName } from '@shared/worktreeName'
import { isRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { SessionStore, type WorktreeResource } from './sessionStore'
import { gitIgnoredAmong } from './gitIgnored'
import { worktreeHomeRoot } from './resumePlan'

const execFileAsync = promisify(execFile)

interface Checkout {
  path: string
  head: string
  branch: string | null
  locked: boolean
}

export interface TreeIo {
  git(cwd: string, args: string[]): Promise<string>
  exists(p: string): Promise<boolean>
  real(p: string): string
  keyed(listed: string): string
  onThisMac: boolean
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trimEnd()
}

const LOCAL_IO: TreeIo = {
  git,
  exists: async (p) => fs.existsSync(p),
  real: (p) => fs.realpathSync(p),
  keyed: (listed) => path.resolve(listed),
  onThisMac: true
}

async function checkouts(io: TreeIo, cwd: string): Promise<Checkout[]> {
  const raw = await io.git(cwd, ['worktree', 'list', '--porcelain', '-z'])
  return raw
    .split('\0\0')
    .filter(Boolean)
    .map((block) => {
      const fields = block.split('\0')
      const field = (prefix: string): string =>
        fields.find((v) => v.startsWith(prefix))?.slice(prefix.length) ?? ''
      const branch = field('branch ')
      return {
        path: io.keyed(field('worktree ')),
        head: field('HEAD '),
        branch: branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : null,
        locked: fields.some((v) => v === 'locked' || v.startsWith('locked '))
      }
    })
}

async function rootOf(io: TreeIo, cwd: string): Promise<string> {
  const listed = await checkouts(io, cwd)
  const root = listed[0]?.path
  if (!root || (await io.git(cwd, ['rev-parse', '--is-bare-repository'])) !== 'false') {
    throw new Error('A Git working repository is required')
  }
  return io.real(root)
}

async function branchExists(io: TreeIo, cwd: string, branch: string): Promise<boolean> {
  try {
    await io.git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false
    throw error
  }
}

function validName(name: string): void {
  if (!isValidWorktreeName(name)) throw new Error('Invalid worktree name')
}

// CC§3
export async function copyWorktreeIncludes(root: string, worktreePath: string): Promise<void> {
  try {
    const includeFile = path.join(root, '.worktreeinclude')
    if (!fs.existsSync(includeFile)) return
    const listed = (
      await git(root, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${includeFile}`])
    )
      .split('\0')
      .filter(Boolean)
    if (!listed.length) return
    for (const rel of await gitIgnoredAmong(root, listed)) {
      const from = path.join(root, rel)
      const to = path.join(worktreePath, rel)
      if (!fs.lstatSync(from).isFile() || fs.existsSync(to)) continue
      await fs.promises.mkdir(path.dirname(to), { recursive: true })
      await fs.promises.copyFile(from, to)
    }
  } catch (error) {
    console.error('[koloft] could not copy the .worktreeinclude files into', worktreePath, error)
  }
}

async function sameFileInRoot(root: string, tree: string, rel: string): Promise<boolean> {
  try {
    const here = path.join(tree, rel)
    const there = path.join(root, rel)
    const [a, b] = await Promise.all([fs.promises.lstat(here), fs.promises.lstat(there)])
    if (!a.isFile() || !b.isFile() || a.size !== b.size) return false
    const [x, y] = await Promise.all([fs.promises.readFile(here), fs.promises.readFile(there)])
    return x.equals(y)
  } catch {
    return false
  }
}

export class SessionWorktrees {
  private readonly preparing = new Set<string>()

  constructor(
    private readonly store: SessionStore,
    private readonly remoteIo?: (cwd: string) => TreeIo
  ) {}

  // ADR-0025
  private io(cwd: string): TreeIo {
    return isRemoteKey(cwd) && this.remoteIo ? this.remoteIo(cwd) : LOCAL_IO
  }

  async create(originalCwd: string, name: string): Promise<WorktreeResource> {
    validName(name)
    const io = this.io(originalCwd)
    const root = await rootOf(io, originalCwd)
    return this.createAt(root, name, await io.git(originalCwd, ['rev-parse', 'HEAD']))
  }

  async adopt(originalCwd: string, checkoutPath: string): Promise<WorktreeResource> {
    const io = this.io(originalCwd)
    const root = await rootOf(io, originalCwd)
    const target = io.real(checkoutPath)
    if (target === root) throw new Error('Select a linked worktree')
    const checkout = (await checkouts(io, root)).find((c) => c.path === target)
    if (!checkout) throw new Error('The checkout is not a worktree of this repository')
    const known = this.store
      .listResources()
      .find((r) => r.originalCwd === root && r.worktreePath === target)
    if (known) {
      const ready: WorktreeResource = {
        ...known,
        worktreeBranch: checkout.branch,
        state: 'ready',
        error: undefined
      }
      this.store.putResource(ready)
      return ready
    }
    const resource: WorktreeResource = {
      id: randomUUID(),
      originalCwd: root,
      worktreePath: target,
      worktreeName: path.posix.basename(target),
      worktreeBranch: checkout.branch,
      originalHeadCommit: checkout.head,
      state: 'ready',
      managed: false
    }
    this.store.putResource(resource)
    return resource
  }

  async untouched(resource: WorktreeResource): Promise<boolean> {
    if (!resource.managed) return false
    const tree = resource.worktreePath
    const io = this.io(tree)
    try {
      const [branch, head, changes, ignored] = await Promise.all([
        io.git(tree, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        io.git(tree, ['rev-parse', 'HEAD']),
        io.git(tree, ['status', '--porcelain', '--untracked-files=all']),
        io.git(tree, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])
      ])
      if (
        branch !== `worktree-${resource.worktreeName}` ||
        head !== resource.originalHeadCommit ||
        changes
      )
        return false
      for (const rel of ignored.split('\0').filter(Boolean)) {
        if (!io.onThisMac || !(await sameFileInRoot(resource.originalCwd, tree, rel))) return false
      }
      return true
    } catch {
      return false
    }
  }

  recorded(worktreePath: string): boolean {
    return this.store.listResources().some((r) => r.worktreePath === worktreePath)
  }

  async rebuild(resourceId: string): Promise<WorktreeResource> {
    const resource = this.requiredResource(resourceId)
    if (await this.io(resource.worktreePath).exists(resource.worktreePath)) {
      return this.adopt(resource.originalCwd, resource.worktreePath)
    }
    return this.materialize(resource)
  }

  // CC§3 CODEX§6
  async recover(worktreePath: string): Promise<WorktreeResource> {
    const home = worktreeHomeRoot(worktreePath)
    if (!home) throw new Error('Not a .claude/worktrees folder')
    const name = path.basename(worktreePath)
    validName(name)
    const root = await rootOf(LOCAL_IO, home)
    return this.materialize({
      id: randomUUID(),
      originalCwd: root,
      worktreePath,
      worktreeName: name,
      worktreeBranch: `worktree-${name}`,
      originalHeadCommit: await LOCAL_IO.git(root, ['rev-parse', 'HEAD']),
      state: 'creating',
      managed: false
    })
  }

  async prepareRenamed(resourceId: string, name: string): Promise<WorktreeResource> {
    validName(name)
    const resource = this.requiredResource(resourceId)
    const io = this.io(resource.originalCwd)
    const base =
      resource.worktreeBranch &&
      (await branchExists(io, resource.originalCwd, resource.worktreeBranch))
        ? await io.git(resource.originalCwd, ['rev-parse', `refs/heads/${resource.worktreeBranch}`])
        : resource.originalHeadCommit
    return this.createAt(resource.originalCwd, name, base)
  }

  private requiredResource(id: string): WorktreeResource {
    const resource = this.store.getResource(id)
    if (!resource) throw new Error('Worktree recovery information is unavailable')
    return resource
  }

  private async createAt(root: string, name: string, base: string): Promise<WorktreeResource> {
    const io = this.io(root)
    const target = `${root}/.claude/worktrees/${name}`
    if (await io.exists(target)) throw new Error('Worktree directory already exists')
    const branch = `worktree-${name}`
    if (await branchExists(io, root, branch)) throw new Error('Worktree branch already exists')
    if (this.recorded(target)) {
      throw new Error(
        'This worktree name has a recovery record; recover it or choose a different name'
      )
    }
    const resource: WorktreeResource = {
      id: randomUUID(),
      originalCwd: root,
      worktreePath: target,
      worktreeName: name,
      worktreeBranch: branch,
      originalHeadCommit: base,
      state: 'creating',
      managed: true
    }
    return this.materialize(resource, false)
  }

  private async materialize(
    resource: WorktreeResource,
    reuseBranch = true
  ): Promise<WorktreeResource> {
    if (this.preparing.has(resource.worktreePath))
      throw new Error('Worktree preparation is already in progress')
    this.preparing.add(resource.worktreePath)
    const pending: WorktreeResource = { ...resource, state: 'creating', error: undefined }
    try {
      this.store.putResource(pending)
      return await this.materializeRecorded(pending, reuseBranch)
    } finally {
      this.preparing.delete(resource.worktreePath)
    }
  }

  private async materializeRecorded(
    pending: WorktreeResource,
    reuseBranch: boolean
  ): Promise<WorktreeResource> {
    const resource = pending
    const io = this.io(resource.originalCwd)
    const bare = (p: string): string => parseRemoteKey(p)?.path ?? p
    try {
      const root = await rootOf(io, resource.originalCwd)
      if (root !== resource.originalCwd) throw new Error('The recorded repository has changed')
      if (await io.exists(resource.worktreePath))
        throw new Error('Worktree directory already exists')
      const stale = (await checkouts(io, root)).find((c) => c.path === resource.worktreePath)
      if (stale) {
        if (stale.locked)
          throw new Error('The missing worktree is locked; unlock it before rebuilding')
        await io.git(root, ['worktree', 'remove', bare(resource.worktreePath)])
      }
      const tree = bare(resource.worktreePath)
      const branch = resource.worktreeBranch
      const args = branch
        ? reuseBranch && (await branchExists(io, root, branch))
          ? ['worktree', 'add', tree, branch]
          : ['worktree', 'add', '-b', branch, tree, resource.originalHeadCommit]
        : ['worktree', 'add', '--detach', tree, resource.originalHeadCommit]
      await io.git(root, args)
      if (io.onThisMac) await copyWorktreeIncludes(root, resource.worktreePath)
      const ready: WorktreeResource = { ...pending, state: 'ready' }
      this.store.putResource(ready)
      return ready
    } catch (error) {
      this.store.putResource({
        ...pending,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
}

import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { isValidWorktreeName } from '@shared/worktreeName'
import { SessionStore, type WorktreeResource } from './sessionStore'

const execFileAsync = promisify(execFile)

interface Checkout {
  path: string
  head: string
  branch: string | null
  locked: boolean
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trimEnd()
}

async function checkouts(cwd: string): Promise<Checkout[]> {
  const raw = await git(cwd, ['worktree', 'list', '--porcelain', '-z'])
  return raw
    .split('\0\0')
    .filter(Boolean)
    .map((block) => {
      const fields = block.split('\0')
      const field = (prefix: string): string =>
        fields.find((v) => v.startsWith(prefix))?.slice(prefix.length) ?? ''
      const branch = field('branch ')
      return {
        path: field('worktree '),
        head: field('HEAD '),
        branch: branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : null,
        locked: fields.some((v) => v === 'locked' || v.startsWith('locked '))
      }
    })
}

async function rootOf(cwd: string): Promise<string> {
  const listed = await checkouts(cwd)
  const root = listed[0]?.path
  if (!root || (await git(cwd, ['rev-parse', '--is-bare-repository'])) !== 'false') {
    throw new Error('A Git working repository is required')
  }
  return fs.realpathSync(root)
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false
    throw error
  }
}

async function unregisterOnlyThisMissingCheckout(
  root: string,
  checkoutPath: string
): Promise<void> {
  await git(root, ['worktree', 'remove', checkoutPath])
}

function validName(name: string): void {
  if (!isValidWorktreeName(name)) throw new Error('Invalid worktree name')
}

export class SessionWorktrees {
  private readonly preparing = new Set<string>()

  constructor(private readonly store: SessionStore) {}

  async create(originalCwd: string, name: string): Promise<WorktreeResource> {
    validName(name)
    const root = await rootOf(originalCwd)
    return this.createAt(root, name, await git(originalCwd, ['rev-parse', 'HEAD']))
  }

  async adopt(originalCwd: string, checkoutPath: string): Promise<WorktreeResource> {
    const root = await rootOf(originalCwd)
    const target = fs.realpathSync(checkoutPath)
    if (target === root) throw new Error('Select a linked worktree')
    const checkout = (await checkouts(root)).find((c) => path.resolve(c.path) === target)
    if (!checkout) throw new Error('The checkout is not a worktree of this repository')
    const known = this.store
      .listResources()
      .find((r) => r.originalCwd === root && r.worktreePath === target)
    if (known) {
      if (known.worktreeBranch !== checkout.branch)
        throw new Error('The worktree branch has changed')
      const ready: WorktreeResource = { ...known, state: 'ready', error: undefined }
      this.store.putResource(ready)
      return ready
    }
    const resource: WorktreeResource = {
      id: randomUUID(),
      originalCwd: root,
      worktreePath: target,
      worktreeName: path.basename(target),
      worktreeBranch: checkout.branch,
      originalHeadCommit: checkout.head,
      state: 'ready',
      managed: false
    }
    this.store.putResource(resource)
    return resource
  }

  async rebuild(resourceId: string): Promise<WorktreeResource> {
    const resource = this.requiredResource(resourceId)
    if (fs.existsSync(resource.worktreePath)) {
      return this.adopt(resource.originalCwd, resource.worktreePath)
    }
    return this.materialize(resource)
  }

  async prepareRenamed(resourceId: string, name: string): Promise<WorktreeResource> {
    validName(name)
    const resource = this.requiredResource(resourceId)
    const base =
      resource.worktreeBranch && (await branchExists(resource.originalCwd, resource.worktreeBranch))
        ? await git(resource.originalCwd, ['rev-parse', `refs/heads/${resource.worktreeBranch}`])
        : resource.originalHeadCommit
    return this.createAt(resource.originalCwd, name, base)
  }

  private requiredResource(id: string): WorktreeResource {
    const resource = this.store.getResource(id)
    if (!resource) throw new Error('Worktree recovery information is unavailable')
    return resource
  }

  private async createAt(root: string, name: string, base: string): Promise<WorktreeResource> {
    const target = path.join(root, '.claude', 'worktrees', name)
    if (fs.existsSync(target)) throw new Error('Worktree directory already exists')
    const branch = `worktree-${name}`
    if (await branchExists(root, branch)) throw new Error('Worktree branch already exists')
    if (this.store.listResources().some((r) => r.worktreePath === target)) {
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
    try {
      const root = await rootOf(resource.originalCwd)
      if (root !== resource.originalCwd) throw new Error('The recorded repository has changed')
      if (fs.existsSync(resource.worktreePath)) throw new Error('Worktree directory already exists')
      const stale = (await checkouts(root)).find(
        (c) => path.resolve(c.path) === resource.worktreePath
      )
      if (stale) {
        if (stale.locked)
          throw new Error('The missing worktree is locked; unlock it before rebuilding')
        await unregisterOnlyThisMissingCheckout(root, resource.worktreePath)
      }
      const branch = resource.worktreeBranch
      const args = branch
        ? reuseBranch && (await branchExists(root, branch))
          ? ['worktree', 'add', resource.worktreePath, branch]
          : ['worktree', 'add', '-b', branch, resource.worktreePath, resource.originalHeadCommit]
        : ['worktree', 'add', '--detach', resource.worktreePath, resource.originalHeadCommit]
      await git(root, args)
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

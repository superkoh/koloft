import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { isValidWorktreeName, SESSION_WORKTREES_FOLDER } from '@shared/worktreeName'
import { barePath, isRemoteKey } from '@shared/remoteKey'
import {
  A_FOLDER_BEING_PREPARED,
  A_NAME_WITH_A_RECOVERY_RECORD,
  type WorktreeRecords,
  type WorktreeResource
} from '@core/agent/worktreeRecords'
import {
  copyWorktreeIncludes,
  TREE_IO_ON_THIS_MAC,
  type TreeIo
} from '../../../main/sessionWorktrees'
import { worktreeHomeRoot } from '../../../main/resumePlan'
import { preparedKeyOf, whenNobodyPrepares } from '../../../main/worktreesBeingPrepared'
import type { SessionStore } from './sessionStore'

interface Checkout {
  path: string
  head: string
  branch: string | null
  locked: boolean
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

const IGNORED_FILES_SAME_AS_ROOT_SH = `root=$1 tree=$2
git -C "$tree" ls-files -z --others --ignored --exclude-standard |
  xargs -0 sh -c 'root=$1 tree=$2; shift 2
for rel do
  [ -f "$tree/$rel" ] && [ ! -L "$tree/$rel" ] && [ -f "$root/$rel" ] && [ ! -L "$root/$rel" ] &&
    cmp -s "$root/$rel" "$tree/$rel" || exit 1
done' sh "$root" "$tree"`

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

async function ignoredFilesSameAsRoot(io: TreeIo, root: string, tree: string): Promise<boolean> {
  if (io.machine) {
    const args = [barePath(root), barePath(tree)]
    return (await io.machine.runScript(IGNORED_FILES_SAME_AS_ROOT_SH, args)) !== null
  }
  const ignored = await io.git(tree, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard'
  ])
  for (const rel of ignored.split('\0').filter(Boolean)) {
    if (!(await sameFileInRoot(root, tree, rel))) return false
  }
  return true
}

export interface WorktreesOfEveryAgent {
  recorded(worktreePath: string): boolean
  occupantOf(dir: string): string | null
  readonly preparing: Map<string, Promise<unknown>>
}

export class SessionWorktrees {
  private readonly preparingHere = new Set<string>()
  readonly records: WorktreeRecords = {
    of: (workspace) => this.store.listResources().filter((r) => r.originalCwd === workspace),
    at: (dir) => this.store.listResources().find((r) => r.worktreePath === dir),
    untouched: (record) => this.untouched(record),
    forgetUnusedAt: (treeRoot) => this.store.removeUnusedResourcesAt(treeRoot)
  }

  constructor(
    private readonly store: SessionStore,
    private readonly everyAgent: WorktreesOfEveryAgent,
    private readonly remoteIo?: (cwd: string) => TreeIo
  ) {}

  // ADR-0025
  private io(cwd: string): TreeIo {
    return isRemoteKey(cwd) && this.remoteIo ? this.remoteIo(cwd) : TREE_IO_ON_THIS_MAC
  }

  async create(originalCwd: string, name: string): Promise<WorktreeResource> {
    validName(name)
    const io = this.io(originalCwd)
    const root = await rootOf(io, originalCwd)
    return this.createAt(root, name, await io.git(originalCwd, ['rev-parse', 'HEAD']))
  }

  whenSettled(worktreePath: string): Promise<void> {
    return whenNobodyPrepares(this.everyAgent.preparing, preparedKeyOf(worktreePath))
  }

  async adopt(originalCwd: string, checkoutPath: string): Promise<WorktreeResource> {
    const { preparing } = this.everyAgent
    const target = this.io(originalCwd).real(checkoutPath)
    const key = preparedKeyOf(target)
    for (let p = preparing.get(key); p; p = preparing.get(key)) await p.catch(() => undefined)
    const work = this.adoptSettled(originalCwd, target)
    const held = work.catch(() => null)
    preparing.set(key, held)
    try {
      return await work
    } finally {
      if (preparing.get(key) === held) preparing.delete(key)
    }
  }

  private async adoptSettled(originalCwd: string, target: string): Promise<WorktreeResource> {
    const io = this.io(originalCwd)
    const root = await rootOf(io, originalCwd)
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
      const [branch, head, changes, ignoredSame] = await Promise.all([
        io.git(tree, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        io.git(tree, ['rev-parse', 'HEAD']),
        io.git(tree, ['status', '--porcelain', '--untracked-files=all']),
        ignoredFilesSameAsRoot(io, resource.originalCwd, tree)
      ])
      return (
        branch === `worktree-${resource.worktreeName}` &&
        head === resource.originalHeadCommit &&
        !changes &&
        ignoredSame
      )
    } catch {
      return false
    }
  }

  async rebuild(resourceId: string): Promise<WorktreeResource> {
    const resource = this.requiredResource(resourceId)
    await this.afterOtherAgentsPreparing(resource.worktreePath)
    if (await this.io(resource.worktreePath).exists(resource.worktreePath)) {
      return this.adopt(resource.originalCwd, resource.worktreePath)
    }
    return this.materialize(resource)
  }

  // CC§3 CODEX§6
  async recover(sessionCwd: string): Promise<WorktreeResource> {
    const listedRoot = worktreeHomeRoot(sessionCwd)
    if (!listedRoot) throw new Error(`Not a ${SESSION_WORKTREES_FOLDER} folder`)
    const name = path.basename(sessionCwd)
    validName(name)
    const io = this.io(listedRoot)
    const root = io.real(listedRoot)
    const worktreePath = `${root}/${SESSION_WORKTREES_FOLDER}/${name}`
    await this.afterOtherAgentsPreparing(worktreePath)
    if (await io.exists(worktreePath)) return this.adopt(root, worktreePath)
    return this.materialize({
      id: randomUUID(),
      originalCwd: root,
      worktreePath,
      worktreeName: name,
      worktreeBranch: `worktree-${name}`,
      originalHeadCommit: await io.git(root, ['rev-parse', 'HEAD']),
      state: 'creating',
      managed: false
    }).catch((error) => {
      this.store.removeUnusedResourcesAt(worktreePath)
      throw error
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

  private async afterOtherAgentsPreparing(worktreePath: string): Promise<void> {
    if (this.preparingHere.has(worktreePath)) throw new Error(A_FOLDER_BEING_PREPARED)
    await this.everyAgent.preparing.get(preparedKeyOf(worktreePath))
  }

  private requiredResource(id: string): WorktreeResource {
    const resource = this.store.getResource(id)
    if (!resource) throw new Error('Worktree recovery information is unavailable')
    return resource
  }

  private async createAt(root: string, name: string, base: string): Promise<WorktreeResource> {
    const io = this.io(root)
    const target = `${root}/${SESSION_WORKTREES_FOLDER}/${name}`
    if (this.everyAgent.preparing.has(preparedKeyOf(target)) || this.everyAgent.occupantOf(target))
      throw new Error(A_FOLDER_BEING_PREPARED)
    if (await io.exists(target)) throw new Error('Worktree directory already exists')
    const branch = `worktree-${name}`
    if (await branchExists(io, root, branch)) throw new Error('Worktree branch already exists')
    if (this.everyAgent.recorded(target)) throw new Error(A_NAME_WITH_A_RECOVERY_RECORD)
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
    const { preparing } = this.everyAgent
    const at = resource.worktreePath
    const key = preparedKeyOf(at)
    if (this.preparingHere.has(at)) throw new Error(A_FOLDER_BEING_PREPARED)
    const running = preparing.get(key)
    if (running) {
      if (!reuseBranch) throw new Error(A_FOLDER_BEING_PREPARED)
      await running
      return this.materialize(resource, reuseBranch)
    }
    const pending: WorktreeResource = { ...resource, state: 'creating', error: undefined }
    const work = (async () => {
      this.store.putResource(pending)
      return this.materializeRecorded(pending, reuseBranch)
    })()
    preparing.set(key, work)
    this.preparingHere.add(at)
    try {
      return await work
    } finally {
      if (preparing.get(key) === work) preparing.delete(key)
      this.preparingHere.delete(at)
    }
  }

  private async materializeRecorded(
    pending: WorktreeResource,
    reuseBranch: boolean
  ): Promise<WorktreeResource> {
    const resource = pending
    const io = this.io(resource.originalCwd)
    try {
      const root = await rootOf(io, resource.originalCwd)
      if (root !== resource.originalCwd) throw new Error('The recorded repository has changed')
      if (await io.exists(resource.worktreePath)) {
        const checkout =
          reuseBranch && (await checkouts(io, root)).find((c) => c.path === resource.worktreePath)
        if (!checkout) throw new Error('Worktree directory already exists')
        const ready: WorktreeResource = {
          ...pending,
          worktreeBranch: checkout.branch,
          state: 'ready'
        }
        this.store.putResource(ready)
        return ready
      }
      const stale = (await checkouts(io, root)).find((c) => c.path === resource.worktreePath)
      if (stale) {
        if (stale.locked)
          throw new Error('The missing worktree is locked; unlock it before rebuilding')
        await io.git(root, ['worktree', 'remove', barePath(resource.worktreePath)])
      }
      const tree = barePath(resource.worktreePath)
      const branch = resource.worktreeBranch
      const args = branch
        ? reuseBranch && (await branchExists(io, root, branch))
          ? ['worktree', 'add', tree, branch]
          : ['worktree', 'add', '-b', branch, tree, resource.originalHeadCommit]
        : ['worktree', 'add', '--detach', tree, resource.originalHeadCommit]
      await io.git(root, args)
      await copyWorktreeIncludes(root, resource.worktreePath, io.machine)
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

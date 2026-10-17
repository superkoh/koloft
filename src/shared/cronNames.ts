import type { BackendId, CronPermission } from './types'

export const CRON_PERMISSIONS: CronPermission[] = ['same', 'acceptEdits', 'skipAll']

export const NEW_JOB_PERMISSION: Record<BackendId, CronPermission> = {
  claude: 'same',
  codex: 'skipAll',
  muse: 'same'
}

const SLUG_CAP_LEAVING_ROOM_FOR_STAMP_IN_64_CHAR_WORKTREE_NAME = 48

export function slugOf(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_CAP_LEAVING_ROOM_FOR_STAMP_IN_64_CHAR_WORKTREE_NAME)
    .replace(/-+$/g, '')
  return s || 'job'
}

export function hasWordChar(name: string): boolean {
  return /[A-Za-z0-9]/.test(name)
}

export function isValidModelName(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,80}$/.test(model)
}

export function worktreeBase(name: string, at: number): string {
  const d = new Date(at)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
  return `${slugOf(name)}-${stamp}`
}

export function worktreeHomeOf(root: string): string {
  return `${root}/.claude/worktrees`
}

export function isRunFolderOf(slug: string, name: string): boolean {
  return new RegExp(`^${slug}-\\d{6}-\\d{4}(-.+)?$`).test(name)
}

export function cronBackend(job: { backend?: BackendId }): BackendId {
  return job.backend ?? 'claude'
}

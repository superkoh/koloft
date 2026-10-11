import type { ProjectCreateResult, WorkspaceAddResult } from '@shared/types'
import { isValidWorktreeName } from '@shared/worktreeName'
import type { Host } from './host/host'

const FREE_NAME_TRIES = 50

export type ProjectHost = Pick<Host, 'dirExists' | 'makeDir' | 'gitOut'>

export async function createProject(
  host: ProjectHost,
  parent: string,
  name: string,
  add: (dir: string) => WorkspaceAddResult | undefined
): Promise<ProjectCreateResult> {
  if (!isValidWorktreeName(name)) return { ok: false, reason: 'Only letters, digits, . _ -' }
  if (!(await host.dirExists(parent))) return { ok: false, reason: 'That folder does not exist.' }
  if ((await host.gitOut(parent, ['rev-parse', '--show-toplevel'])) !== null)
    return { ok: false, reason: 'That folder is inside a git repository — pick one outside it.' }
  const base = parent.replace(/\/+$/, '')
  for (let n = 1; n <= FREE_NAME_TRIES; n++) {
    const dir = `${base}/${n === 1 ? name : `${name}-${n}`}`
    if (await host.dirExists(dir)) continue
    if (!(await host.makeDir(dir))) return { ok: false, reason: `Could not create ${dir}.` }
    const added = add(dir)
    if (added?.code === 'added' || added?.code === 'exists') return { ok: true, path: added.path }
    return { ok: false, reason: `Created ${dir}, but could not add it as a workspace.` }
  }
  return { ok: false, reason: `Too many folders named ${name} already.` }
}

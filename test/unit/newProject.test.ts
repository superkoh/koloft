import { describe, expect, it } from 'vitest'
import type { WorkspaceAddResult } from '../../src/shared/types'
import { createProject, type ProjectHost } from '../../src/main/newProject'

function fakeHost(dirs: string[], gitRoots: string[] = [], mkdirFails = false) {
  const made: string[] = []
  const host: ProjectHost = {
    dirExists: async (d) => dirs.includes(d) || made.includes(d),
    makeDir: async (d) => {
      if (mkdirFails) return false
      made.push(d)
      return true
    },
    gitOut: async (d) => (gitRoots.some((r) => d.startsWith(r)) ? `${d}\n` : null)
  }
  return { host, made }
}

const added =
  (log: string[]) =>
  (dir: string): WorkspaceAddResult => {
    log.push(dir)
    return { code: 'added', path: dir }
  }

describe('createProject: make the folder, then add it as a workspace', () => {
  it('makes <parent>/<name> and adds exactly that folder', async () => {
    const { host, made } = fakeHost(['/w'])
    const adds: string[] = []
    expect(await createProject(host, '/w', 'shop', added(adds))).toEqual({
      ok: true,
      path: '/w/shop'
    })
    expect(made).toEqual(['/w/shop'])
    expect(adds).toEqual(['/w/shop'])
  })

  it('never takes over a folder that is already there: the name counts up', async () => {
    const { host, made } = fakeHost(['/w', '/w/shop', '/w/shop-2'])
    expect(await createProject(host, '/w', 'shop', added([]))).toEqual({
      ok: true,
      path: '/w/shop-3'
    })
    expect(made).toEqual(['/w/shop-3'])
  })

  it('refuses a parent inside a git checkout, which would add the outer repository instead', async () => {
    const { host, made } = fakeHost(['/home'], ['/home'])
    const adds: string[] = []
    const r = await createProject(host, '/home', 'shop', added(adds))
    expect(r.ok).toBe(false)
    expect(made).toEqual([])
    expect(adds).toEqual([])
  })

  it('adds nothing when the folder cannot be made, the parent is gone, or the name is not a plain name', async () => {
    const adds: string[] = []
    expect((await createProject(fakeHost(['/w'], [], true).host, '/w', 'a', added(adds))).ok).toBe(
      false
    )
    expect((await createProject(fakeHost([]).host, '/w', 'a', added(adds))).ok).toBe(false)
    expect((await createProject(fakeHost(['/w']).host, '/w', '../a', added(adds))).ok).toBe(false)
    expect(adds).toEqual([])
  })
})

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import type { WorkspaceRows } from '@shared/types'
import { useStore } from '../../../../src/renderer/src/store'
import { everyWorkspaceRows } from '../../../../src/renderer/src/sessionRows'
import { placePluginUi } from '../../../../src/renderer/src/pluginUi'

const ws = (path: string, butler?: true): WorkspaceRows => ({
  workspace: {
    path,
    missing: false,
    isGit: false,
    hasHistory: false,
    ...(butler && { claimedBy: 'butler' })
  },
  rows: []
})

describe("the butler's folder in the sidebar", () => {
  it('is kept out of the workspace list once the plugins are placed, and still comes last among every workspace', () => {
    placePluginUi()
    const project = ws('/project')
    const butlers = ws('/userData/conductors/global', true)
    useStore.getState().setWorkspaceRows([butlers, project])
    const s = useStore.getState()
    expect(s.workspaceRows.map((w) => w.workspace.path)).toEqual(['/project'])
    expect(s.claimedWorkspaces.map((w) => w.workspace.path)).toEqual([
      '/userData/conductors/global'
    ])
    expect(everyWorkspaceRows(s).map((w) => w.workspace.path)).toEqual([
      '/project',
      '/userData/conductors/global'
    ])
  })
})

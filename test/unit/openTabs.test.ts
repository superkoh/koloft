import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect } from 'vitest'
import {
  OpenTabsFile,
  openTabsNow,
  readOpenTabs,
  restorePlan,
  type OpenTab
} from '../../src/main/openTabs'

const tab = (sessionId: string, over: Partial<OpenTab> = {}): OpenTab => ({
  sessionId,
  kind: 'claude',
  title: `Title ${sessionId}`,
  cwd: '/repo',
  ...over
})

describe('restorePlan: which saved tabs come back running and which come back asleep', () => {
  it('brings the selected tab back first, keeps the others in order, and leaves sleepers asleep', () => {
    const plan = restorePlan(
      { tabs: [tab('a'), tab('b', { asleep: true }), tab('c')], active: 'c' },
      []
    )
    expect(plan.awake).toEqual(['c', 'a'])
    expect(plan.asleep.map((t) => t.sessionId)).toEqual(['b'])
  })

  it('a Keep running session always comes back running, even when its tab was asleep or closed', () => {
    const plan = restorePlan({ tabs: [tab('a', { asleep: true })] }, ['a', 'closed'])
    expect(plan.awake).toEqual(['a', 'closed'])
    expect(plan.asleep).toEqual([])
  })
})

describe('the open-tabs file', () => {
  it('a missing or broken file restores nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-open-tabs-'))
    expect(readOpenTabs(path.join(dir, 'none.json'))).toEqual({ tabs: [] })
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"tabs": [')
    expect(readOpenTabs(path.join(dir, 'broken.json'))).toEqual({ tabs: [] })
  })

  it('reads back what was written: running tabs, sleepers and the selected one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-open-tabs-'))
    const file = path.join(dir, 'open-tabs.json')
    const state = openTabsNow([tab('a')], [tab('b')], 'b')
    new OpenTabsFile(file).write(state)
    expect(readOpenTabs(file)).toEqual({
      tabs: [tab('a'), tab('b', { asleep: true })],
      active: 'b'
    })
  })
})

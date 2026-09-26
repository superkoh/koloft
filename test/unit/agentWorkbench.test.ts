import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { workbenchVerbs } from '../../src/main/agentWorkbench'
import { EXIT_USAGE, NOT_PINNED, type AgentCaller } from '../../src/main/agentRequests'
import type { ArtifactView } from '../../src/shared/types'

let dir: string
let note: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-agent-wb-'))
  note = path.join(dir, 'notes.md')
  fs.writeFileSync(note, '')
  fs.writeFileSync(path.join(dir, 'plan.md'), '# plan')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function verbs(over: { canShow?: boolean; pinned?: boolean } = {}): ReturnType<
  typeof workbenchVerbs
> & {
  opened: { tabId: string; target: string; view?: ArtifactView }[]
} {
  const opened: { tabId: string; target: string; view?: ArtifactView }[] = []
  const v = workbenchVerbs({
    open: (tabId, target, view) => {
      opened.push({ tabId, target, view })
      return over.canShow ?? true
    },
    notesFileOf: () => (over.pinned === false ? undefined : note)
  })
  return Object.assign(v, { opened })
}

const caller = (): AgentCaller => ({
  tabId: 't1',
  cwd: dir,
  session: {
    tabId: 't1',
    backendId: 'claude',
    host: 'local',
    sessionId: 's1',
    title: 'Fix login',
    cwd: dir,
    treeRoot: dir,
    alive: true,
    updatedAt: 1
  }
})

describe('koloft open / diff', () => {
  it("open shows a file named relative to the caller's folder, with no view asked", async () => {
    const v = verbs()
    const reply = await v.open(['plan.md'], caller())
    expect(reply.exit).toBe(0)
    expect(v.opened).toEqual([{ tabId: 't1', target: path.join(dir, 'plan.md'), view: undefined }])
  })

  it('open passes a web address through untouched', async () => {
    const v = verbs()
    await v.open(['https://example.com/a'], caller())
    expect(v.opened[0].target).toBe('https://example.com/a')
  })

  it('diff asks the Workbench for the diff view', async () => {
    const v = verbs()
    await v.diff(['plan.md'], caller())
    expect(v.opened[0].view).toBe('diff')
  })

  it('diff refuses a web address as a usage mistake', async () => {
    const v = verbs()
    const reply = await v.diff(['https://example.com'], caller())
    expect(reply).toMatchObject({ exit: EXIT_USAGE })
    expect(v.opened).toEqual([])
  })

  it('a file the Workbench cannot show, missing or not, is refused and named', async () => {
    const reply = await verbs({ canShow: false }).open(['missing.md'], caller())
    expect(reply.exit).not.toBe(0)
    expect(reply.text).toContain(path.join(dir, 'missing.md'))
  })
})

describe('koloft note', () => {
  it('prints the note, and says so when it is empty', async () => {
    const v = verbs()
    expect((await v.note([], caller())).text).toMatch(/empty/)
    fs.writeFileSync(note, 'use npm ci\n')
    expect(await v.note([], caller())).toMatchObject({ exit: 0, text: 'use npm ci\n' })
  })

  it('append puts the text on a line of its own at the end, joining unquoted words', async () => {
    fs.writeFileSync(note, 'owner wrote this')
    const v = verbs()
    expect((await v.note(['append', 'run', 'the', 'tests'], caller())).exit).toBe(0)
    await v.note(['append', 'then ship'], caller())
    expect(fs.readFileSync(note, 'utf8')).toBe('owner wrote this\nrun the tests\nthen ship\n')
  })

  it('an unpinned workspace is refused', async () => {
    const reply = await verbs({ pinned: false }).note(['append', 'x'], caller())
    expect(reply).toMatchObject({ exit: 1, text: NOT_PINNED })
  })

  it('an unknown word or an append with no text is a usage mistake, and the note is untouched', async () => {
    const v = verbs()
    expect(await v.note(['erase'], caller())).toMatchObject({ exit: EXIT_USAGE })
    expect(await v.note(['append', ' '], caller())).toMatchObject({ exit: EXIT_USAGE })
    expect(fs.readFileSync(note, 'utf8')).toBe('')
  })
})

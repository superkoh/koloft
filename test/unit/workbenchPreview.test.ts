import { describe, it, expect } from 'vitest'
import type { PreviewItem } from '@shared/types'
import {
  docLanding,
  previewDocs,
  type PreviewDoc
} from '../../src/renderer/src/components/workbenchPreviewModel'
import type { WorkbenchTab } from '../../src/renderer/src/components/workbenchTabs'

const wrote = (src: string, wroteAt: number): PreviewItem => ({
  src,
  label: src.split('/').pop() ?? src,
  access: 'wrote',
  wroteAt
})

const webTab = (url: string, agentOpenedAt?: number): WorkbenchTab => ({
  id: url,
  kind: 'web',
  url,
  title: '',
  unread: agentOpenedAt !== undefined,
  openedByAgent: agentOpenedAt !== undefined ? true : undefined,
  agentOpenedAt
})

describe('Workbench preview card: the docs it lists', () => {
  it('lists only the Markdown and HTML files the agent wrote or opened, newest first, each once', () => {
    const docs = previewDocs({
      files: [
        wrote('/repo/docs/old.md', 100),
        wrote('/repo/src/app.ts', 900),
        { src: '/repo/README.md', label: 'README.md', access: 'read' },
        wrote('/repo/notes.mdx', 950),
        wrote('/tmp/scratch/mock.html', 300),
        wrote('/repo/docs/plan.md', 500)
      ],
      webTabs: [
        webTab('file:///tmp/scratch/mock.html', 700),
        webTab('file:///repo/site/index.html'),
        webTab('https://example.com/page.html', 800)
      ],
      openFile: { src: '/repo/docs/guide.md', openedAt: 400 }
    })
    expect(docs.map((d) => d.src)).toEqual([
      '/tmp/scratch/mock.html',
      '/repo/docs/plan.md',
      '/repo/docs/guide.md',
      '/repo/docs/old.md'
    ])
    expect(docs[0]).toEqual({ src: '/tmp/scratch/mock.html', kind: 'page', at: 700 })
  })

  it('leaves out what the agent writes for itself — memory, CLAUDE.md/AGENTS.md/SKILL.md, skill and agent config — unless the agent opens it', () => {
    const docs = previewDocs({
      files: [
        wrote('/Users/koh/.claude/projects/-Users-koh-repo/memory/MEMORY.md', 100),
        wrote('ssh://devbox/home/koh/.claude/projects/-home-koh-repo/memory/note.md', 110),
        wrote('/repo/CLAUDE.md', 120),
        wrote('/repo/sub/AGENTS.md', 130),
        wrote('/repo/plugins/p/skills/review/SKILL.md', 140),
        wrote('/repo/plugins/p/skills/review/references/rules.md', 150),
        wrote('/repo/.claude/agents/helper.md', 160),
        wrote('/repo/.claude/commands/ship.md', 170),
        wrote('/repo/.claude/worktrees/wt/.claude/skills/x/guide.md', 180),
        wrote('/repo/.claude/worktrees/wt/docs/design.html', 190),
        wrote('/Users/koh/.claude/plans/plan.md', 200),
        wrote('/tmp/review.md', 210)
      ],
      webTabs: [],
      openFile: { src: '/repo/CLAUDE.md', openedAt: 300 }
    })
    expect(docs.map((d) => d.src).sort()).toEqual([
      '/Users/koh/.claude/plans/plan.md',
      '/repo/.claude/worktrees/wt/docs/design.html',
      '/repo/CLAUDE.md',
      '/tmp/review.md'
    ])
  })

  it('leaves out a file the user opened in Browse themselves, and a page the user opened', () => {
    const docs = previewDocs({
      files: [],
      webTabs: [webTab('file:///repo/site/index.html')],
      openFile: { src: '/repo/docs/guide.md' }
    })
    expect(docs).toEqual([])
  })

  it('opens Markdown rendered, a local page in a web tab, and a page on an ssh machine as source', () => {
    const doc = (src: string, kind: PreviewDoc['kind']): PreviewDoc => ({ src, kind, at: 0 })
    expect(docLanding(doc('/repo/a.md', 'markdown'))).toBe('reading-rendered')
    expect(docLanding(doc('ssh://devbox/home/koh/a.md', 'markdown'))).toBe('reading-rendered')
    expect(docLanding(doc('/repo/a.html', 'page'))).toBe('web-tab')
    expect(docLanding(doc('ssh://devbox/home/koh/a.html', 'page'))).toBe('reading-source')
  })
})

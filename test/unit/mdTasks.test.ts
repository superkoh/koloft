import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { tasks } from '../../src/renderer/src/markdown/tasks'

/** FR-09: `- [ ]` is a read-only checkbox. Disabled is the whole point — the preview pane
 *  is read-only, so a click must not look like it wrote the file back. */
const md = new MarkdownIt().use(tasks)

describe('tasks', () => {
  it('renders unchecked and checked items as disabled checkboxes', () => {
    const html = md.render('- [ ] open item\n- [x] done item\n')
    expect(html).toContain('<input class="md-task" type="checkbox" disabled>')
    expect(html).toContain('<input class="md-task" type="checkbox" checked disabled>')
    expect(html).toContain('open item')
    expect(html).toContain('done item')
    expect(html).not.toContain('[ ]')
    expect(html).not.toContain('[x]')
  })

  it('accepts the uppercase X form', () => {
    expect(md.render('- [X] done\n')).toContain('checked')
  })

  it('works in an ordered list too', () => {
    expect(md.render('1. [ ] one\n')).toContain('md-task')
  })

  it('leaves a bracket that is not a task marker as text', () => {
    const html = md.render('- [link](https://example.com)\n')
    expect(html).not.toContain('md-task')
    const literal = md.render('- [not a task] text\n')
    expect(literal).not.toContain('md-task')
    expect(literal).toContain('[not a task]')
  })

  it('leaves a bracket outside a list alone', () => {
    const html = md.render('[ ] not in a list\n')
    expect(html).not.toContain('md-task')
  })

  it('keeps inline markup in the label', () => {
    const html = md.render('- [ ] **bold** rest\n')
    expect(html).toContain('md-task')
    expect(html).toContain('<strong>bold</strong>')
  })
})

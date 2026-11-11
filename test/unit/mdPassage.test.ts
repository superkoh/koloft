// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderBlocks } from '../../src/renderer/src/markdown/render'
import { cleanBlock } from '../../src/renderer/src/markdown/index'
import {
  findInBlocks,
  linesOfRange,
  withoutEmptyTail,
  type DrawnBlock
} from '../../src/renderer/src/components/mdPassage'

const PLAN = `# Retry plan

The sync job fails once a day.

- Wait 30 s.
- Give up after 3 tries.
- Keep the old token.

Show a toast.
`

async function draw(text: string): Promise<{ body: HTMLElement; drawn: DrawnBlock[] }> {
  const doc = await renderBlocks(text, { srcPath: '/ws/plan.md', token: 'T' })
  const body = document.createElement('div')
  document.body.replaceChildren(body)
  const drawn = doc.blocks.map((html, i) => {
    const el = document.createElement('div')
    el.append(cleanBlock(html))
    body.append(el)
    return { el, lines: doc.lines[i] }
  })
  return { body, drawn }
}

function textNode(body: HTMLElement, words: string): Text {
  const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  while (walk.nextNode())
    if (walk.currentNode.textContent?.includes(words)) return walk.currentNode as Text
  throw new Error(`no text ${words}`)
}

function select(from: [Node, number], to: [Node, number]): Range {
  const r = document.createRange()
  r.setStart(...from)
  r.setEnd(...to)
  return r
}

describe('which lines of the file a selection in the rendered Markdown names', () => {
  it('names the one list item the words sit in', async () => {
    const { body, drawn } = await draw(PLAN)
    const t = textNode(body, 'Give up')
    expect(linesOfRange(select([t, 0], [t, 7]), body, drawn)).toEqual([5, 6])
  })

  it('names the whole list when the selection runs over two of its items', async () => {
    const { body, drawn } = await draw(PLAN)
    const a = textNode(body, 'Wait')
    const b = textNode(body, 'Give up')
    expect(linesOfRange(select([a, 0], [b, 4]), body, drawn)).toEqual([4, 8])
  })

  it('runs from the first block’s first line to the last block’s end when the selection crosses blocks', async () => {
    const { body, drawn } = await draw(PLAN)
    const a = textNode(body, 'sync job')
    const b = textNode(body, 'Give up')
    expect(linesOfRange(select([a, 4], [b, 4]), body, drawn)).toEqual([2, 8])
  })

  it('leaves out the next block when a triple-click ends the selection at its very start', async () => {
    const { body, drawn } = await draw(PLAN)
    const a = textNode(body, 'sync job')
    const next = drawn[2].el
    const r = withoutEmptyTail(select([a, 0], [next, 0]), body)
    expect(linesOfRange(r, body, drawn)).toEqual([2, 3])
  })

  it('finds the words again in a block drawn anew, so the mark survives a reload', async () => {
    const { drawn } = await draw(PLAN)
    const r = findInBlocks(drawn, [5, 6], 'after 3')
    expect(r?.toString()).toBe('after 3')
    expect(findInBlocks(drawn, [5, 6], 'not there')).toBeNull()
  })
})

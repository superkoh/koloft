// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderBlocks } from '../../src/renderer/src/markdown/render'
import { cleanBlock } from '../../src/renderer/src/markdown/index'

const DOC = `---
title: Plan
---

<p align="center"><img src="logo.png" alt="logo"></p>

# Heading

Text with <kbd>Ctrl</kbd> and a note[^1], another[^2] and an inline one^[right here].

- [x] done
- open
  - nested

> [!NOTE]
> heads up

> plain quote

| a | b |
| --- | --- |
| 1 | 2 |

\`\`\`ts
const x: number = 1
\`\`\`

\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`

<details>
<summary>More</summary>

**inside**

</details>

Math $E = mc^2$ inline.

---

[^1]: first
[^2]: second
`

describe('a Markdown document put on screen block by block', () => {
  it('sanitizes to the same page block by block as it does whole', async () => {
    const { blocks } = await renderBlocks(DOC, { srcPath: '/ws/a.md', token: 'T' })
    expect(blocks.length).toBeGreaterThan(10)
    const piecewise = document.createElement('div')
    for (const b of blocks) piecewise.append(cleanBlock(b))
    const whole = document.createElement('div')
    whole.append(cleanBlock(blocks.join('')))
    expect(piecewise.innerHTML).toBe(whole.innerHTML)
  })
})

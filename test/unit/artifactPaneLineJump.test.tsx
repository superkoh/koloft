// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { useState, type JSX } from 'react'

const { lagReactTasks, stopLaggingReactTasks, expectReactTasksLagged } =
  await import('./helpers/reactTaskLag')

const coloring = new Map<string, (html: string) => void>()
const coloredAtOnce = new Set<string>()
vi.mock('../../src/renderer/src/offThread', async (orig) => ({
  ...(await orig<object>()),
  highlightCodeOffThread: (code: string) =>
    coloredAtOnce.has(code)
      ? Promise.resolve(coloredHtml(code))
      : new Promise<string>((resolve) => coloring.set(code, resolve))
}))

function numbered(name: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `const ${name}${i + 1} = ${i + 1}`).join('\n')
}

const files: Record<string, string> = {
  '/ws/a.ts': numbered('a', 3),
  '/ws/b.ts': numbered('b', 12)
}

function coloredHtml(code: string): string {
  return code
    .split('\n')
    .map((l) => `<span class="line">${l}</span>`)
    .join('\n')
}

function anyApi(): unknown {
  return new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : anyApi()),
    apply: () =>
      Object.assign(() => {}, {
        then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(null).then(ok, bad)
      })
  })
}
const api = anyApi() as Record<string, unknown>
const preview = { readText: (p: string): Promise<string> => Promise.resolve(files[p]) }
const fs = new Proxy(api.fs as Record<string, unknown>, {
  get: (t, k) =>
    k === 'gitFileDiffFull'
      ? () => Promise.resolve({ text: '' })
      : k === 'onFileChange'
        ? () => () => {}
        : t[k as string]
})
;(window as unknown as { api: unknown }).api = new Proxy(api, {
  get: (t, k) => (k === 'preview' ? preview : k === 'fs' ? fs : t[k as string])
})

const scrolledTo: string[] = []
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this.textContent ?? '')
  }
})

const { render, cleanup, waitFor } = await import('@testing-library/react')
const { ArtifactPane } = await import('../../src/renderer/src/components/ArtifactPane')

afterEach(() => {
  stopLaggingReactTasks()
  cleanup()
  scrolledTo.length = 0
  coloring.clear()
  coloredAtOnce.clear()
})

let openAt: (path: string, line: number) => void = () => {}

function ReadingArea(): JSX.Element {
  const [at, setAt] = useState({ path: '/ws/a.ts', line: 2 })
  openAt = (path, line) => setAt({ path, line })
  return (
    <ArtifactPane
      tabId="reading"
      path={at.path}
      wsRoot="/ws"
      line={at.line}
      reloadNonce={0}
      outlineOpen={false}
      onCaps={() => {}}
      onNavigate={() => {}}
      onBody={() => {}}
      onZoomImage={() => {}}
      zoom={null}
      onCloseZoom={() => {}}
      onOutlineClose={() => {}}
      onClose={() => {}}
      commentTo={{} as never}
    />
  )
}

async function finishColoring(code: string): Promise<void> {
  await waitFor(() => expect(coloring.has(code)).toBe(true))
  coloring.get(code)!(coloredHtml(code))
}

describe('ArtifactPane: opening a file at a line', () => {
  it('lands on that line of the new file even when React lags and the coloring of the file shown before finishes first', async () => {
    render(<ReadingArea />)
    await finishColoring(files['/ws/a.ts'])
    await waitFor(() => expect(scrolledTo).toEqual(['const a2 = 2']))

    coloredAtOnce.add(files['/ws/a.ts'])
    lagReactTasks()
    await Promise.resolve().then(() => openAt('/ws/b.ts', 9))
    await finishColoring(files['/ws/b.ts'])
    expectReactTasksLagged()

    await waitFor(() => expect(scrolledTo.at(-1)).toBe('const b9 = 9'), { timeout: 3000 })
  })
})

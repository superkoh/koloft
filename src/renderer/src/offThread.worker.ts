import { highlightLines } from './highlight'
import { renderBlocks } from './markdown/render'
import type { OffThreadAsk, OffThreadReply } from './offThread'

const COLORED_TEXTS_KEPT_FOR_BOTH_SIDES_OF_A_DIFF = 2

const scope = self as unknown as {
  onmessage: (e: MessageEvent<OffThreadAsk>) => void
  postMessage: (r: OffThreadReply) => void
}

const recent = new Map<string, string[]>()

async function colorText(code: string, lang: string): Promise<string[]> {
  const key = `${lang}\u{0}${code}`
  const lines = recent.get(key) ?? (await highlightLines(code, lang))
  recent.delete(key)
  recent.set(key, lines)
  for (const oldest of recent.keys()) {
    if (recent.size <= COLORED_TEXTS_KEPT_FOR_BOTH_SIDES_OF_A_DIFF) break
    recent.delete(oldest)
  }
  return lines
}

scope.onmessage = async (e) => {
  const ask = e.data
  try {
    const value =
      ask.job === 'markdown'
        ? await renderBlocks(ask.text, { srcPath: ask.srcPath, token: ask.token })
        : await Promise.all(ask.codes.map((code) => colorText(code, ask.lang)))
    scope.postMessage({ id: ask.id, ok: true, value })
  } catch (err) {
    scope.postMessage({ id: ask.id, ok: false, message: String((err as Error)?.message ?? err) })
  }
}

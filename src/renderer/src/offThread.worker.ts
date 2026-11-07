import { highlightLines } from './highlight'
import { renderBlocks } from './markdown/render'
import type { OffThreadAsk, OffThreadReply } from './offThread'

const scope = self as unknown as {
  onmessage: (e: MessageEvent<OffThreadAsk>) => void
  postMessage: (r: OffThreadReply) => void
}

scope.onmessage = async (e) => {
  const ask = e.data
  try {
    const value =
      ask.job === 'markdown'
        ? await renderBlocks(ask.text, { srcPath: ask.srcPath, token: ask.token })
        : await highlightLines(ask.code, ask.lang)
    scope.postMessage({ id: ask.id, ok: true, value })
  } catch (err) {
    scope.postMessage({ id: ask.id, ok: false, message: String((err as Error)?.message ?? err) })
  }
}

import { createElement, useEffect, useRef, type JSX } from 'react'

/** the subset of Electron's <webview> methods the reload path touches (typed locally so
 *  the renderer needn't depend on electron's types, same as FilePane's WebviewEl) */
type ReloadableWebview = HTMLElement & {
  reload(): void
  executeJavaScript(code: string): Promise<unknown>
}

/**
 * Thin wrapper over Electron's <webview> tag. Rendered via createElement to avoid
 * having to augment React's JSX intrinsic elements. `plugins` enables Chromium's
 * built-in PDF viewer for koloft-file://*.pdf urls.
 *
 * `reloadToken`: bumping it reloads the guest (preview auto-refresh / the ↻ button).
 * The guest's scroll position is captured before the reload and restored on the next
 * dom-ready — best-effort: an html page's own JS state is inherently lost, and the
 * PDFium viewer keeps its page position internally where we can't reach it (which is
 * why the pdf path asks the user before reloading at all).
 */
export function WebView({
  src,
  reloadToken = 0
}: {
  src: string
  reloadToken?: number
}): JSX.Element {
  const ref = useRef<ReloadableWebview | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true // token 0 at mount = initial load, nothing to reload
      return
    }
    const wv = ref.current
    if (!wv) return
    let reloaded = false
    const reloadRestoring = (x: number, y: number): void => {
      if (reloaded) return
      reloaded = true
      const onReady = (): void => {
        wv.removeEventListener('dom-ready', onReady)
        if (x || y) {
          try {
            void wv.executeJavaScript(`window.scrollTo(${x}, ${y})`)
          } catch {
            /* guest gone */
          }
        }
      }
      wv.addEventListener('dom-ready', onReady)
      try {
        wv.reload()
      } catch {
        wv.removeEventListener('dom-ready', onReady)
      }
    }
    try {
      wv.executeJavaScript('[window.scrollX, window.scrollY]')
        .then((v: unknown) => {
          const [x, y] = Array.isArray(v) ? v : [0, 0]
          reloadRestoring(Number(x) || 0, Number(y) || 0)
        })
        .catch(() => reloadRestoring(0, 0))
    } catch {
      reloadRestoring(0, 0)
    }
    // a wedged guest may never resolve executeJavaScript — still reload
    const t = setTimeout(() => reloadRestoring(0, 0), 500)
    return () => clearTimeout(t)
  }, [reloadToken])

  return createElement('webview', {
    ref,
    src,
    plugins: true,
    style: { width: '100%', height: '100%', border: 'none', background: '#fff' }
  })
}

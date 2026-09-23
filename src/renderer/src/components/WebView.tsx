import { createElement, useEffect, useRef, type JSX } from 'react'

const WEDGED_GUEST_RELOAD_FALLBACK_MS = 500

type ReloadableWebview = HTMLElement & {
  reload(): void
  executeJavaScript(code: string): Promise<unknown>
}

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
      mounted.current = true
      return
    }
    const wv = ref.current
    if (!wv) return
    // PLATFORM§12
    let reloaded = false
    const reloadRestoring = (x: number, y: number): void => {
      if (reloaded) return
      reloaded = true
      const onReady = (): void => {
        wv.removeEventListener('dom-ready', onReady)
        if (x || y) {
          try {
            void wv.executeJavaScript(`window.scrollTo(${x}, ${y})`)
          } catch {}
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
    const t = setTimeout(() => reloadRestoring(0, 0), WEDGED_GUEST_RELOAD_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [reloadToken])

  return createElement('webview', {
    ref,
    src,
    plugins: true,
    style: { width: '100%', height: '100%', border: 'none', background: '#fff' }
  })
}

import { describe, it, expect } from 'vitest'
import {
  routeFor,
  dedupKey,
  canOpenExternally,
  folderFileOf,
  loopbackPortOf,
  onMacPort,
  machinePageUrl,
  MACHINE_PAGE_SCHEME,
  pagePathOf
} from '@shared/browserRoute'

describe('routeFor — the §05B routing table', () => {
  it('sends http(s) to the Browser from every source, localhost included', () => {
    for (const source of ['agent', 'user', 'address'] as const) {
      expect(routeFor('http://localhost:5173/app', source)).toEqual({
        dest: 'browser',
        target: 'http://localhost:5173/app'
      })
      expect(routeFor('https://example.com/x?a=1#f', source)).toEqual({
        dest: 'browser',
        target: 'https://example.com/x?a=1#f'
      })
    }
  })

  it('routes an http(s) .pdf to the Browser, not to Preview (X-5)', () => {
    expect(routeFor('https://example.com/invoice.pdf', 'user')).toEqual({
      dest: 'browser',
      target: 'https://example.com/invoice.pdf'
    })
  })

  it('routes file:// by extension rather than by scheme (C-21/BB-C14)', () => {
    expect(routeFor('file:///w/docs/page.html', 'agent')).toEqual({
      dest: 'browser',
      target: 'file:///w/docs/page.html'
    })
    expect(routeFor('file:///w/notes.md', 'agent')).toEqual({
      dest: 'preview',
      target: '/w/notes.md'
    })
    expect(routeFor('file://localhost/w/notes.md', 'agent')).toEqual({
      dest: 'preview',
      target: '/w/notes.md'
    })
    expect(routeFor('file:///w/a%20b/shot.png', 'user')).toEqual({
      dest: 'preview',
      target: '/w/a b/shot.png'
    })
  })

  it('routes a bare local path by extension, .html to the Browser (D5)', () => {
    expect(routeFor('/w/docs/page.html', 'agent')).toEqual({
      dest: 'browser',
      target: 'file:///w/docs/page.html'
    })
    expect(routeFor('/w/docs/page.HTM', 'user')).toEqual({
      dest: 'browser',
      target: 'file:///w/docs/page.HTM'
    })
    expect(routeFor('/w/a b/report.pdf', 'agent')).toEqual({
      dest: 'preview',
      target: '/w/a b/report.pdf'
    })
    expect(routeFor('/w/src/main.ts', 'agent')).toEqual({
      dest: 'drop',
      target: '',
      reason: 'unsupported-target'
    })
  })

  it('percent-encodes a bare path on its way to a file:// URL', () => {
    expect(routeFor('/w/my docs/a#b.html', 'user')).toEqual({
      dest: 'browser',
      target: 'file:///w/my%20docs/a%23b.html'
    })
  })

  it('accepts about:blank as a legal new-tab state and refuses other about: URLs', () => {
    expect(routeFor('about:blank', 'user')).toEqual({ dest: 'browser', target: 'about:blank' })
    expect(routeFor('about:gpu', 'user')).toEqual({
      dest: 'drop',
      target: '',
      reason: 'blocked-scheme'
    })
  })

  it('allows data: only from a user source (C-33/BB-C30)', () => {
    expect(routeFor('data:text/html,<h1>x</h1>', 'user')).toEqual({
      dest: 'browser',
      target: 'data:text/html,<h1>x</h1>'
    })
    for (const source of ['agent', 'address'] as const) {
      expect(routeFor('data:text/html,<h1>x</h1>', source)).toEqual({
        dest: 'drop',
        target: '',
        reason: 'source-not-allowed'
      })
    }
  })

  it('hard-blocks javascript:, chrome://, devtools:// and koloft-file: from every source', () => {
    for (const source of ['agent', 'user', 'address'] as const) {
      for (const target of [
        'javascript:alert(1)',
        'JavaScript:alert(1)',
        'chrome://settings',
        'devtools://devtools/bundled/x.html',
        'koloft-file://localhost/Users/x/.ssh/id_rsa'
      ]) {
        expect(routeFor(target, source)).toEqual({
          dest: 'drop',
          target: '',
          reason: 'blocked-scheme'
        })
      }
    }
  })

  it('opens a page on an ssh machine as a machine page web tab that maps back to the same file, and keeps every other machine file out of the browser', () => {
    for (const source of ['agent', 'user', 'address'] as const) {
      expect(routeFor('ssh://dev/srv/a.html', source).target).not.toMatch(/^koloft-machine:\/\/\d/)
      const decision = routeFor('ssh://u@Box.lan/srv/my site/a#b.html', source)
      expect(decision.dest).toBe('browser')
      expect(decision.target.startsWith(`${MACHINE_PAGE_SCHEME}://`)).toBe(true)
      expect(routeFor(decision.target, source)).toEqual(decision)
      expect(pagePathOf(decision.target)).toBe('ssh://u@Box.lan/srv/my site/a#b.html')
      expect(routeFor('ssh://box/srv/notes.md', source).dest).toBe('drop')
      expect(routeFor('ssh://box/srv/run.sh', source).dest).toBe('drop')
    }
    expect(new URL('style.css', machinePageUrl('box', '/srv/site/a.html')).href).toBe(
      machinePageUrl('box', '/srv/site/style.css')
    )
    expect(pagePathOf('file:///w/a.html')).toBe('/w/a.html')
    expect(pagePathOf(`${MACHINE_PAGE_SCHEME}://zz/srv/a.html`)).toBeNull()
  })

  it('hands mailto:/tel: to the OS on a user action only (SEC-4)', () => {
    expect(routeFor('mailto:x@y.z', 'user')).toEqual({ dest: 'system', target: 'mailto:x@y.z' })
    expect(routeFor('tel:+123', 'user')).toEqual({ dest: 'system', target: 'tel:+123' })
    for (const source of ['agent', 'address'] as const) {
      expect(routeFor('mailto:x@y.z', source)).toEqual({
        dest: 'drop',
        target: '',
        reason: 'source-not-allowed'
      })
    }
  })

  it('never hands a non-whitelisted scheme to the OS (SEC-4: zoom:/vscode:/file:)', () => {
    for (const source of ['agent', 'user', 'address'] as const) {
      expect(routeFor('zoommtg://example', source).dest).not.toBe('system')
      expect(routeFor('vscode://file/x', source).dest).not.toBe('system')
      expect(routeFor('file:///Applications/Evil.app', source).dest).not.toBe('system')
    }
    expect(routeFor('zoommtg://example', 'user')).toEqual({
      dest: 'drop',
      target: '',
      reason: 'blocked-scheme'
    })
    expect(routeFor('file:///Applications/Evil.app', 'user')).toEqual({
      dest: 'drop',
      target: '',
      reason: 'unsupported-target'
    })
  })

  it('accepts only http/https/file from the address bar (SEC-13)', () => {
    expect(routeFor('file:///w/docs/', 'address')).toEqual({
      dest: 'browser',
      target: 'file:///w/docs/'
    })
    expect(routeFor('file:///w/notes.md', 'address')).toEqual({
      dest: 'browser',
      target: 'file:///w/notes.md'
    })
    expect(routeFor('http://localhost:3000', 'address')).toEqual({
      dest: 'browser',
      target: 'http://localhost:3000'
    })
  })

  it('turns a scheme-less address-bar entry into a host URL or a DuckDuckGo search (B3)', () => {
    expect(routeFor('localhost:5173', 'address')).toEqual({
      dest: 'browser',
      target: 'http://localhost:5173'
    })
    expect(routeFor('example.com/x', 'address')).toEqual({
      dest: 'browser',
      target: 'http://example.com/x'
    })
    expect(routeFor('127.0.0.1:8787/docs', 'address')).toEqual({
      dest: 'browser',
      target: 'http://127.0.0.1:8787/docs'
    })
    const search = routeFor('error message text', 'address')
    expect(search.dest).toBe('browser')
    expect(new URL(search.target).host).toBe('duckduckgo.com')
    expect(new URL(search.target).searchParams.get('q')).toBe('error message text')
  })

  it('searches rather than navigates for a lone word or a bare page name, which is not a host', () => {
    expect(new URL(routeFor('koloft', 'address').target).host).toBe('duckduckgo.com')
    expect(new URL(routeFor('design.html', 'address').target).host).toBe('duckduckgo.com')
    expect(new URL(routeFor('index.htm', 'address').target).host).toBe('duckduckgo.com')
  })

  it('opens an absolute path typed in the address bar as the local file: a page as file://, another viewable file in the preview', () => {
    expect(routeFor('/w/docs/page.html', 'address')).toEqual({
      dest: 'browser',
      target: 'file:///w/docs/page.html'
    })
    expect(routeFor('/w/notes.md', 'address')).toEqual({ dest: 'preview', target: '/w/notes.md' })
    expect(routeFor('/w/app.bin', 'address').dest).toBe('drop')
  })

  it('drops empty and whitespace-only targets', () => {
    for (const source of ['agent', 'user', 'address'] as const) {
      expect(routeFor('   ', source)).toEqual({
        dest: 'drop',
        target: '',
        reason: 'unsupported-target'
      })
    }
  })
})

describe("folderFileOf — an address-bar entry read as a file in the session's folder", () => {
  it('resolves a relative entry inside a local folder and a remote one, keeping ?… and #… aside', () => {
    expect(folderFileOf('index.html', '/w/wt')).toEqual({ path: '/w/wt/index.html', suffix: '' })
    expect(folderFileOf('docs/a.html', '/w/wt')).toEqual({ path: '/w/wt/docs/a.html', suffix: '' })
    expect(folderFileOf('./x.md', '/w/wt')).toEqual({ path: '/w/wt/x.md', suffix: '' })
    expect(folderFileOf('index.html?x=1#a', '/w/wt')).toEqual({
      path: '/w/wt/index.html',
      suffix: '?x=1#a'
    })
    expect(folderFileOf('docs/a.html', 'ssh://box/srv/app')).toEqual({
      path: 'ssh://box/srv/app/docs/a.html',
      suffix: ''
    })
  })

  it('refuses a path that climbs out of the folder, on this Mac and on a remote machine', () => {
    expect(folderFileOf('../x.md', '/w/wt')).toBeNull()
    expect(folderFileOf('a/../../x', '/w/wt')).toBeNull()
    expect(folderFileOf('../../../etc/passwd', 'ssh://box/srv/app')).toBeNull()
    expect(folderFileOf('.', '/w/wt')).toBeNull()
  })

  it('leaves a URL, an absolute or home path, a search with a space, an empty entry and a missing folder to the usual routing', () => {
    for (const entry of ['https://x', 'localhost:5173', '/abs', '~/x', 'react hooks', '  ']) {
      expect(folderFileOf(entry, '/w/wt')).toBeNull()
    }
    expect(folderFileOf('index.html', null)).toBeNull()
  })
})

describe("loopbackPortOf and onMacPort — a remote tab's localhost goes through a forward", () => {
  it('reads the machine port of every loopback name and scheme a page can reach, and nothing else', () => {
    expect(loopbackPortOf('http://localhost:5173/a')).toBe(5173)
    expect(loopbackPortOf('ws://127.0.0.1:24678/')).toBe(24678)
    expect(loopbackPortOf('http://[::1]:3000/')).toBe(3000)
    expect(loopbackPortOf('https://localhost/')).toBe(443)
    expect(loopbackPortOf('http://localhost/')).toBe(80)
    expect(loopbackPortOf('http://example.com:5173/')).toBeNull()
    expect(loopbackPortOf('file:///tmp/a.html')).toBeNull()
  })

  it('moves a page to its Mac port, and leaves it as it is when the Mac port is the same', () => {
    expect(onMacPort('http://localhost:5173/a?b=1', 61000)).toBe('http://localhost:61000/a?b=1')
    expect(onMacPort('ws://[::1]:5173/', 5173)).toBe('ws://[::1]:5173/')
  })
})

describe('canOpenExternally — the OS hand-off whitelist (SEC-4)', () => {
  it('admits http/https/mailto/tel and nothing else', () => {
    expect(canOpenExternally('http://localhost:5173/app')).toBe(true)
    expect(canOpenExternally('https://example.com')).toBe(true)
    expect(canOpenExternally('mailto:x@y.z')).toBe(true)
    expect(canOpenExternally('tel:+123')).toBe(true)
    for (const target of [
      'file:///Applications/Evil.app',
      'vscode://file/x',
      'zoommtg://example',
      'javascript:alert(1)',
      'koloft-file://localhost/etc/hosts',
      'data:text/html,x',
      '/w/docs/page.html',
      ''
    ]) {
      expect(canOpenExternally(target)).toBe(false)
    }
  })
})

describe('dedupKey — same origin+path+query is the same tab (D4③)', () => {
  it('ignores the hash', () => {
    expect(dedupKey('http://h/p#one')).toBe(dedupKey('http://h/p#two'))
    expect(dedupKey('http://h/p')).toBe(dedupKey('http://h/p#'))
  })

  it('normalizes trailing slash, default port, host case and query order (BB-C58)', () => {
    expect(dedupKey('http://LOCALHOST/p/?b=2&a=1')).toBe(dedupKey('http://localhost:80/p?a=1&b=2'))
    expect(dedupKey('https://Example.COM:443/x/')).toBe(dedupKey('https://example.com/x'))
  })

  it('keeps the root path distinguishable from a named path', () => {
    expect(dedupKey('http://h/')).toBe(dedupKey('http://h'))
    expect(dedupKey('http://h/')).not.toBe(dedupKey('http://h/p'))
  })

  it('keeps scheme, non-default port, path case and query values significant', () => {
    expect(dedupKey('http://h/p')).not.toBe(dedupKey('https://h/p'))
    expect(dedupKey('http://h:8080/p')).not.toBe(dedupKey('http://h/p'))
    expect(dedupKey('http://h/P')).not.toBe(dedupKey('http://h/p'))
    expect(dedupKey('http://h/p?a=1')).not.toBe(dedupKey('http://h/p?a=2'))
    expect(dedupKey('http://h/p?a=1')).not.toBe(dedupKey('http://h/p'))
  })

  it('treats an encoded space and a literal one as the same query', () => {
    expect(dedupKey('http://h/p?q=a%20b')).toBe(dedupKey('http://h/p?q=a+b'))
  })

  it('keys file:// URLs by their path', () => {
    expect(dedupKey('file:///w/docs/page.html#top')).toBe(dedupKey('file:///w/docs/page.html'))
    expect(dedupKey('file:///w/a.html')).not.toBe(dedupKey('file:///w/b.html'))
  })

  it('falls back to the trimmed input when the target is not parseable as a URL', () => {
    expect(dedupKey('  not a url  ')).toBe('not a url')
  })
})

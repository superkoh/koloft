import { describe, it, expect } from 'vitest'
import { routeFor, dedupKey, canOpenExternally } from '@shared/browserRoute'

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

  it('searches rather than navigates for a lone word or a path-looking entry', () => {
    expect(new URL(routeFor('koloft', 'address').target).host).toBe('duckduckgo.com')
    expect(new URL(routeFor('/w/docs/page.html', 'address').target).host).toBe('duckduckgo.com')
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

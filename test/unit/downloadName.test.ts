import { describe, it, expect } from 'vitest'
import { safeDownloadName, suggestedDownloadName, uniqueDownloadName } from '@shared/downloadName'

const NUL = String.fromCharCode(0)
const LF = String.fromCharCode(10)

describe('safeDownloadName — SEC-9', () => {
  it('keeps a plain name as it is', () => {
    expect(safeDownloadName('report.pdf')).toBe('report.pdf')
    expect(safeDownloadName('my report (final).tar.gz')).toBe('my report (final).tar.gz')
    expect(safeDownloadName('.zshrc')).toBe('.zshrc')
  })

  it('reduces a traversal attempt to its basename', () => {
    expect(safeDownloadName('../../evil.sh')).toBe('evil.sh')
    expect(safeDownloadName('/etc/passwd')).toBe('passwd')
    expect(safeDownloadName('..\\..\\evil.sh')).toBe('evil.sh')
    expect(safeDownloadName('a/../../b/evil.sh')).toBe('evil.sh')
  })

  it('falls back for names that would not be a file at all', () => {
    expect(safeDownloadName('')).toBe('download')
    expect(safeDownloadName('   ')).toBe('download')
    expect(safeDownloadName('..')).toBe('download')
    expect(safeDownloadName('.')).toBe('download')
    expect(safeDownloadName('../../')).toBe('download')
    expect(safeDownloadName('/')).toBe('download')
  })

  it('strips control characters and NULs', () => {
    expect(safeDownloadName(`rep${NUL}ort${LF}.pdf`)).toBe('report.pdf')
    expect(safeDownloadName(`${LF}${NUL}`)).toBe('download')
  })
})

describe('suggestedDownloadName — SEC-9: the name as the site wrote it', () => {
  it('falls back to Chromium’s name when the header carries none', () => {
    expect(suggestedDownloadName('', 'report.pdf')).toBe('report.pdf')
    expect(suggestedDownloadName('attachment', 'report.pdf')).toBe('report.pdf')
    expect(suggestedDownloadName('attachment; filename=""', 'report.pdf')).toBe('report.pdf')
  })

  it('reads the filename parameter, quoted or bare', () => {
    expect(suggestedDownloadName('attachment; filename="report.pdf"', 'x')).toBe('report.pdf')
    expect(suggestedDownloadName('attachment; filename=report.pdf', 'x')).toBe('report.pdf')
    expect(suggestedDownloadName('attachment; filename="my \\"final\\".pdf"', 'x')).toBe(
      'my "final".pdf'
    )
  })

  // PLATFORM§13
  it('keeps a traversal attempt intact for safeDownloadName to reduce', () => {
    expect(suggestedDownloadName('attachment; filename="../../evil.sh"', '_.._evil.sh')).toBe(
      '../../evil.sh'
    )
    expect(
      safeDownloadName(suggestedDownloadName('attachment; filename="../../evil.sh"', 'x'))
    ).toBe('evil.sh')
  })

  it('prefers the RFC 5987 extended parameter and decodes it', () => {
    expect(suggestedDownloadName("attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.txt", 'x')).toBe(
      '中文.txt'
    )
    expect(
      suggestedDownloadName('attachment; filename="ascii.txt"; filename*=UTF-8\'\'real.txt', 'x')
    ).toBe('real.txt')
  })

  it('falls through a malformed extended parameter', () => {
    expect(
      suggestedDownloadName('attachment; filename*=UTF-8\'\'%E4%A8, filename="a.txt"', 'x')
    ).toBe('x')
    expect(suggestedDownloadName('attachment; filename="a.txt"; filename*=UTF-8\'\'%ZZ', 'x')).toBe(
      'a.txt'
    )
  })
})

describe('uniqueDownloadName — never silently overwrite', () => {
  it('returns the name untouched when nothing is in the way', () => {
    expect(uniqueDownloadName('report.pdf', () => false)).toBe('report.pdf')
  })

  it('counts up until a free name, keeping the extension last', () => {
    const taken = new Set(['report.pdf', 'report (1).pdf'])
    expect(uniqueDownloadName('report.pdf', (n) => taken.has(n))).toBe('report (2).pdf')
  })

  it('appends to the whole name when there is no extension', () => {
    const taken = new Set(['LICENSE'])
    expect(uniqueDownloadName('LICENSE', (n) => taken.has(n))).toBe('LICENSE (1)')
  })

  it('treats a dotfile as a name, not as an extension', () => {
    const taken = new Set(['.zshrc'])
    expect(uniqueDownloadName('.zshrc', (n) => taken.has(n))).toBe('.zshrc (1)')
  })

  it('splits on the last dot only', () => {
    const taken = new Set(['archive.tar.gz'])
    expect(uniqueDownloadName('archive.tar.gz', (n) => taken.has(n))).toBe('archive.tar (1).gz')
  })
})

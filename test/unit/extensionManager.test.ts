import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// extensionManager reads app.getPath('userData') at call time; nothing in the pure
// install layer touches Electron beyond that, so a stub is all it takes to import it.
vi.mock('electron', () => ({
  app: { getPath: () => '/nowhere' },
  session: { fromPartition: () => ({}) }
}))

import {
  parseInstallDirs,
  seamStageDir,
  stageSeamExtension,
  installedRoot,
  installAsk,
  disabledStatePath,
  readDisabledState,
  writeDisabledState,
  sameTabTarget,
  type ManagedExtension
} from '../../src/main/extensionManager'

/**
 * The install layer behind the §07 probe seam (KOLOFT_EXT_INSTALL_DIRS) and the D8
 * registry it feeds. Everything here is decided before Electron is involved: which
 * dirs the seam accepts, where a dir is staged so the install survives the source
 * going away, and which directory an uninstall may remove.
 */

describe('parseInstallDirs (the seam is env text: absolute dirs, colon separated)', () => {
  it('is empty for an unset or blank variable', () => {
    expect(parseInstallDirs(undefined)).toEqual([])
    expect(parseInstallDirs('')).toEqual([])
    expect(parseInstallDirs('  :  ')).toEqual([])
  })

  it('splits on colons and trims each entry', () => {
    expect(parseInstallDirs('/a/one: /a/two ')).toEqual(['/a/one', '/a/two'])
  })

  it('drops a relative path — a dir this process cannot resolve is not an install', () => {
    expect(parseInstallDirs('ext/probe:/a/one:./rel')).toEqual(['/a/one'])
  })

  it('collapses the spellings of one dir into a single install', () => {
    expect(parseInstallDirs('/a/one:/a/one/:/a/./one:/a/two/../one')).toEqual(['/a/one'])
  })

  it('keeps the order the variable gave', () => {
    expect(parseInstallDirs('/a/three:/a/one:/a/two')).toEqual(['/a/three', '/a/one', '/a/two'])
  })
})

describe('seamStageDir (idempotency key: one source dir, one staged copy)', () => {
  const store = '/data/Extensions'

  it('gives one source dir the same staged path every time', () => {
    expect(seamStageDir(store, '/tmp/probe-a')).toBe(seamStageDir(store, '/tmp/probe-a'))
  })

  it('gives two source dirs two staged paths — copies of one probe are two extensions', () => {
    expect(seamStageDir(store, '/tmp/probe-a')).not.toBe(seamStageDir(store, '/tmp/probe-b'))
  })

  it('stages directly under the extensions store, one level down', () => {
    const staged = seamStageDir(store, '/tmp/probe-a')
    expect(path.dirname(staged)).toBe(store)
    // the loader searches two levels for a manifest.json and reads a store install as
    // <store>/<extension id>/<version>/ — a staged dir must not look like an id
    expect(path.basename(staged)).not.toMatch(/^[a-p]{32}$/)
  })
})

describe('stageSeamExtension (the copy that makes an install outlive its source dir)', () => {
  let root: string
  let store: string
  let source: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ext-stage-')))
    store = path.join(root, 'Extensions')
    source = path.join(root, 'probe')
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(source, 'manifest.json'), '{"name":"probe","version":"1.0.0"}')
    fs.writeFileSync(path.join(source, 'nested', 'probe.js'), 'mark()\n')
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('copies the whole tree into the store, so the source may vanish', () => {
    const staged = stageSeamExtension(store, source)
    expect(staged).toBe(seamStageDir(store, source))
    fs.rmSync(source, { recursive: true, force: true })
    expect(fs.readFileSync(path.join(staged!, 'manifest.json'), 'utf8')).toContain('probe')
    expect(fs.readFileSync(path.join(staged!, 'nested', 'probe.js'), 'utf8')).toBe('mark()\n')
  })

  it('is idempotent: a second run leaves the already-staged copy alone', () => {
    const staged = stageSeamExtension(store, source)!
    // what a re-copy would destroy: the loaded extension's own on-disk state
    fs.writeFileSync(path.join(staged, 'state.txt'), 'kept')
    fs.writeFileSync(path.join(source, 'manifest.json'), '{"name":"changed","version":"2.0.0"}')

    expect(stageSeamExtension(store, source)).toBe(staged)
    expect(fs.existsSync(path.join(staged, 'state.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')).toContain('probe')
  })

  it('refuses a dir that is not there', () => {
    expect(stageSeamExtension(store, path.join(root, 'gone'))).toBeNull()
    expect(fs.existsSync(store)).toBe(false)
  })

  it('refuses a dir with no manifest — a folder is not an extension', () => {
    const empty = path.join(root, 'empty')
    fs.mkdirSync(empty)
    expect(stageSeamExtension(store, empty)).toBeNull()
  })

  it('refuses a file handed in where a dir was meant', () => {
    const file = path.join(root, 'probe.zip')
    fs.writeFileSync(file, 'x')
    expect(stageSeamExtension(store, file)).toBeNull()
  })

  it('leaves no half-copied dir behind when the copy dies mid-way', () => {
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed')
    })
    try {
      expect(stageSeamExtension(store, source)).toBeNull()
    } finally {
      spy.mockRestore()
    }
    // nothing under the store may masquerade as an installed extension
    const left = fs.existsSync(store) ? fs.readdirSync(store) : []
    expect(left).toEqual([])
  })
})

describe('installedRoot (what an uninstall may delete)', () => {
  const store = '/data/Extensions'

  it('is the staged dir itself for an unpacked install', () => {
    expect(installedRoot(store, '/data/Extensions/unpacked-abc')).toBe(
      '/data/Extensions/unpacked-abc'
    )
  })

  it('is the id dir, not the version dir, for a web-store install', () => {
    expect(installedRoot(store, '/data/Extensions/aeblfdkhhhdcdjpifhhbdiojplfjncoa/8.12.0')).toBe(
      '/data/Extensions/aeblfdkhhhdcdjpifhhbdiojplfjncoa'
    )
  })

  it('is null for an extension loaded from outside the store — never delete a user dir', () => {
    expect(installedRoot(store, '/Users/me/dev/my-extension')).toBeNull()
    expect(installedRoot(store, '/data/Extensions')).toBeNull()
    expect(installedRoot(store, '/data/Extensions-other/thing')).toBeNull()
  })
})

describe('the disabled set on disk (an extension switched off stays off across a relaunch)', () => {
  let store: string
  let extDir: string
  let off: ManagedExtension

  beforeEach(() => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ext-off-')))
    store = path.join(root, 'Extensions')
    extDir = path.join(store, 'unpacked-abc')
    fs.mkdirSync(extDir, { recursive: true })
    off = {
      id: 'aaaabbbbccccddddeeeeffffgggghhhh',
      name: 'probe',
      version: '1.0.0',
      path: extDir,
      enabled: false
    }
  })

  afterEach(() => fs.rmSync(path.dirname(store), { recursive: true, force: true }))

  it('reads back exactly what was written', () => {
    writeDisabledState(store, [off])
    expect(readDisabledState(store)).toEqual([off])
  })

  it('is empty before anything has ever been switched off', () => {
    expect(readDisabledState(store)).toEqual([])
  })

  it('forgets an entry whose directory is gone — the extension is no longer installed', () => {
    const other = { ...off, id: 'zzzz', path: path.join(store, 'unpacked-gone') }
    writeDisabledState(store, [off, other])
    expect(readDisabledState(store)).toEqual([off])
  })

  it('switching the last one back on leaves nothing behind', () => {
    writeDisabledState(store, [off])
    writeDisabledState(store, [])
    expect(readDisabledState(store)).toEqual([])
  })

  it('writes into a store directory that does not exist yet', () => {
    const fresh = path.join(path.dirname(store), 'Fresh')
    writeDisabledState(fresh, [])
    expect(fs.existsSync(disabledStatePath(fresh))).toBe(true)
  })

  it('reads a file that is not JSON as nothing — anything may have written it', () => {
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(disabledStatePath(store), 'not json at all')
    expect(readDisabledState(store)).toEqual([])
  })

  it('drops a row that names no extension, keeping the rows that do', () => {
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(
      disabledStatePath(store),
      JSON.stringify([{ name: 'no id' }, off, 'nonsense', null])
    )
    expect(readDisabledState(store)).toEqual([off])
  })

  it('reads JSON that is not a list as nothing', () => {
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(disabledStatePath(store), JSON.stringify({ id: 'x' }))
    expect(readDisabledState(store)).toEqual([])
  })
})

describe('sameTabTarget (which waiting chrome.tabs.create the strip just reported for)', () => {
  it('matches the url Koloft opened the tab on', () => {
    expect(sameTabTarget('http://127.0.0.1:8080/m10', 'http://127.0.0.1:8080/m10')).toBe(true)
    expect(
      sameTabTarget('chrome-extension://abc/page.html', 'chrome-extension://abc/page.html')
    ).toBe(true)
  })

  it('matches a bare origin however the trailing slash fell', () => {
    expect(
      sameTabTarget('https://chromewebstore.google.com/', 'https://chromewebstore.google.com')
    ).toBe(true)
    expect(
      sameTabTarget('https://chromewebstore.google.com', 'https://chromewebstore.google.com/')
    ).toBe(true)
  })

  it('matches a page that has already moved on to somewhere under it', () => {
    expect(
      sameTabTarget(
        'https://chromewebstore.google.com/',
        'https://chromewebstore.google.com/category/ext'
      )
    ).toBe(true)
    expect(sameTabTarget('http://h/p', 'http://h/p?q=1')).toBe(true)
    expect(sameTabTarget('http://h/p', 'http://h/p#top')).toBe(true)
  })

  it('refuses another tab — binding the wrong guest is the bug this predicate exists for', () => {
    expect(sameTabTarget('http://127.0.0.1:8080/a', 'http://127.0.0.1:8080/b')).toBe(false)
    expect(sameTabTarget('http://h/m10', 'http://h/m10-target')).toBe(false)
    expect(sameTabTarget('https://a.example/', 'https://b.example/')).toBe(false)
  })

  it('refuses a blank tab on either side — it is nobody’s new tab', () => {
    expect(sameTabTarget('', 'http://h/p')).toBe(false)
    expect(sameTabTarget('http://h/p', '')).toBe(false)
    expect(sameTabTarget('', '')).toBe(false)
  })
})

describe('installAsk (§04 figure 4: what the install confirmation says, from the manifest alone)', () => {
  it('summarises an MV3 manifest as its permissions followed by its hosts', () => {
    expect(
      installAsk('ask-1', '1Password – Password Manager', {
        version: '8.12.32.33',
        permissions: ['nativeMessaging', 'storage'],
        host_permissions: ['<all_urls>']
      })
    ).toEqual({
      kind: 'install',
      id: 'ask-1',
      name: '1Password – Password Manager',
      version: '8.12.32.33',
      permissions: ['nativeMessaging', 'storage'],
      origins: ['<all_urls>']
    })
  })

  it('asks for an extension that declares neither list, and one that spells no version', () => {
    expect(installAsk('ask-2', 'Bare', {})).toEqual({
      kind: 'install',
      id: 'ask-2',
      name: 'Bare',
      version: '',
      permissions: [],
      origins: []
    })
  })

  it('drops whatever is not a permission string — the manifest arrives off the network', () => {
    const ask = installAsk('ask-3', 'Odd', {
      version: 7,
      permissions: ['storage', 42, null, { origin: 'x' }],
      host_permissions: 'https://example.com/*'
    })
    expect(ask.permissions).toEqual(['storage'])
    expect(ask.origins).toEqual([])
    expect(ask.version).toBe('')
  })
})

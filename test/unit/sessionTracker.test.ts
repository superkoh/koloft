import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { EventEmitter } from 'events'
import type { ClaudeSessionInfo as SessionInfo } from '@shared/types'

// The tracker computes PROJECTS_ROOT = $HOME/.claude/projects at *module load*, and
// os.homedir() follows $HOME on POSIX. So point HOME at a throwaway dir, then import
// the module — every jsonl the tracker tails now lives under our sandbox, never the
// developer's real ~/.claude. Import is dynamic so HOME is set before the const runs.
let SessionTracker: typeof import('../../src/main/sessionTracker').SessionTracker
// the production cwd→dir encoding (not a copy), so an encoding change can't leave this
// test writing jsonl where the tracker no longer looks. Pulled from the same dynamic
// import so it isn't loaded before HOME is set.
let encodeCwd: typeof import('../../src/main/sessionTracker').encodeCwd
let scratchpadDirFor: typeof import('../../src/main/sessionTracker').scratchpadDirFor
let classifyUserPrompt: typeof import('../../src/main/sessionTracker').classifyUserPrompt
let home: string
let projectsRoot: string

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-tracker-home-'))
  process.env.HOME = home
  // R8: the window a burst of worktree moves collapses into, stretched from the
  // shipped 1.2s so that "the second move arrived inside it" is not a race against the
  // 500ms file poll. Read at module load, like HOME.
  process.env.KOLOFT_RELOCATE_SETTLE_MS = '2000'
  projectsRoot = path.join(home, '.claude', 'projects')
  ;({ SessionTracker, encodeCwd, scratchpadDirFor, classifyUserPrompt } =
    await import('../../src/main/sessionTracker'))
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const trackers: InstanceType<typeof SessionTracker>[] = []
afterEach(() => {
  // untrack everything so fs.watchFile listeners are torn down (they'd keep vitest alive)
  for (const t of trackers) for (const s of t.list()) t.untrack(s.tabId)
  trackers.length = 0
})

function newTracker(): InstanceType<typeof SessionTracker> {
  const t = new SessionTracker()
  trackers.push(t)
  return t
}

/** A workspace dir with real files the jsonl can reference (canonFile stat-filters
 *  non-existent paths, so referenced files must exist on disk). */
function makeWorkspace(files: Record<string, string>): string {
  const cwd = fs.mkdtempSync(path.join(home, 'ws-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(cwd, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return fs.realpathSync(cwd)
}

/** Write a session jsonl at the exact path the tracker predicts for (cwd, sessionId). */
function writeJsonl(cwd: string, sessionId: string, lines: unknown[]): string {
  const dir = path.join(projectsRoot, encodeCwd(cwd))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, sessionId + '.jsonl')
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

/** Write a subagent transcript under `<projectDir>/<sessionId>/subagents/<name>` —
 *  the real layout the tracker globs for Task-subagent spend. */
function writeSubagentJsonl(
  cwd: string,
  sessionId: string,
  name: string,
  lines: unknown[]
): string {
  const dir = path.join(projectsRoot, encodeCwd(cwd), sessionId, 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

/** Resolve once a session snapshot matching `pred` is emitted (or already present).
 *  The default budget is generous because the tracker reaches the snapshot through
 *  `fs.watchFile` polling: it is here to fail a genuine hang, not to measure latency,
 *  and 8s was tight enough that a loaded CI runner tripped it. */
function waitFor(
  tracker: EventEmitter,
  pred: (s: SessionInfo) => boolean,
  timeoutMs = 15000
): Promise<SessionInfo> {
  return new Promise((resolve, reject) => {
    const done = (s: SessionInfo): void => {
      clearTimeout(to)
      tracker.off('update', onUpdate)
      resolve(s)
    }
    const onUpdate = (list: SessionInfo[]): void => {
      const m = list.find(pred)
      if (m) done(m)
    }
    const to = setTimeout(() => {
      tracker.off('update', onUpdate)
      reject(new Error('timed out waiting for session update'))
    }, timeoutMs)
    tracker.on('update', onUpdate)
    const cur = (tracker as unknown as { list(): SessionInfo[] }).list().find(pred)
    if (cur) done(cur)
  })
}

/** A repo with a linked worktree under it, spelled the way claude spells them: a `.git`
 *  DIRECTORY at the repo, and in the worktree a `.git` FILE pointing into
 *  `<repo>/.git/worktrees/<name>` — the only shape projectInfoFor reads as a worktree. */
function repoWithWorktree(name: string): { repo: string; wt: string } {
  const repo = makeWorkspace({})
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', name), { recursive: true })
  const wt = path.join(repo, '.claude', 'worktrees', name)
  fs.mkdirSync(wt, { recursive: true })
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', name)}\n`)
  return { repo, wt }
}

const SID = '11111111-1111-4111-8111-111111111111'

describe('SessionTracker — file extraction from tool_use', () => {
  it('tags writes vs reads, sums line deltas, and tracks last-touched/last-written', async () => {
    const cwd = makeWorkspace({
      'hello.js': 'function hi(){}\n',
      'README.md': '# readme\n'
    })
    const tracker = newTracker()
    tracker.track('tabA', cwd)
    const file = writeJsonl(cwd, SID, [
      { type: 'user', message: { role: 'user', content: 'Add a hello function' }, cwd },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'ok' },
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: 'hello.js', content: 'a\nb\nc\n' }
            }
          ]
        },
        cwd
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }]
        },
        cwd
      }
    ])
    tracker.bindSession('tabA', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabA' && x.files.length >= 2)
    const wrote = s.files.find((f) => f.label === 'hello.js')
    const read = s.files.find((f) => f.label === 'README.md')
    expect(wrote?.access).toBe('wrote')
    expect(wrote?.added).toBe(3)
    expect(read?.access).toBe('read')
    expect(s.lastWritten).toMatch(/hello\.js$/)
    expect(s.lastTouched).toMatch(/README\.md$/) // Read came after the Write
    // the Write above is replayed history (no timestamp, parsed by the catch-up): it
    // moved lastWritten but is not a write Claude did just now
    expect(s.liveWrites ?? 0).toBe(0)

    // a write appended after the bind is live, and counts
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: 'hello.js', content: 'd\n' } }
          ]
        },
        timestamp: new Date().toISOString(),
        cwd
      }) + '\n'
    )
    const s2 = await waitFor(tracker, (x) => x.tabId === 'tabA' && (x.liveWrites ?? 0) > 0)
    expect(s2.liveWrites).toBe(1)

    // a shell command that writes a file counts too — Claude Code records nothing else
    // about it — while one that only redirects to /dev/null does not
    const bash = (command: string): string =>
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'b' + command.length, name: 'Bash', input: { command } }
          ]
        },
        timestamp: new Date().toISOString(),
        cwd
      }) + '\n'
    fs.appendFileSync(file, bash('npm test > /dev/null 2>&1') + bash("printf 'hi\\n' >> hello.js"))
    const s3 = await waitFor(tracker, (x) => x.tabId === 'tabA' && (x.liveWrites ?? 0) > 1)
    expect(s3.liveWrites).toBe(2)
    expect(s3.lastWritten).toMatch(/hello\.js$/)
  })

  it('Edit / MultiEdit line deltas and read-never-downgrades-write', async () => {
    const cwd = makeWorkspace({ 'a.ts': 'x\n' })
    const tracker = newTracker()
    tracker.track('tabE', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: {
                file_path: 'a.ts',
                old_string: 'one\ntwo',
                new_string: 'one\ntwo\nthree\nfour'
              }
            }
          ]
        },
        cwd
      },
      // a later Read of the same file must NOT downgrade its 'wrote' access
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
        cwd
      }
    ])
    tracker.bindSession('tabE', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabE' && x.files.length >= 1)
    const f = s.files.find((x) => x.label === 'a.ts')
    expect(f?.access).toBe('wrote')
    // Edit is not diffed: the whole new_string counts as added, the whole old_string
    // as removed (see editDelta). new_string has 4 lines, old_string has 2.
    expect(f?.added).toBe(4)
    expect(f?.removed).toBe(2)
  })
})

describe('SessionTracker — title resolution priority', () => {
  it('falls back to the first user prompt when no ai-title / sidecar', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT1', cwd)
    const file = writeJsonl(cwd, SID, [
      { type: 'user', message: { content: 'Fix the parser bug' }, cwd }
    ])
    tracker.bindSession('tabT1', file, SID, cwd)
    const s = await waitFor(tracker, (x) => x.tabId === 'tabT1' && x.title === 'Fix the parser bug')
    expect(s.title).toBe('Fix the parser bug')
  })

  it('ai-title beats the first prompt; sidecar <id>.title beats ai-title', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT2', cwd)
    const file = writeJsonl(cwd, SID, [
      { type: 'user', message: { content: 'first prompt text' }, cwd },
      { type: 'ai-title', aiTitle: 'AI generated title' }
    ])
    tracker.bindSession('tabT2', file, SID, cwd)
    await waitFor(tracker, (x) => x.tabId === 'tabT2' && x.title === 'AI generated title')

    // now the external title sidecar appears — it must win
    fs.writeFileSync(file.replace(/\.jsonl$/, '.title'), 'Sidecar Name\n')
    const s = await waitFor(tracker, (x) => x.tabId === 'tabT2' && x.title === 'Sidecar Name')
    expect(s.title).toBe('Sidecar Name')
  })

  it('slash-command prompts use <command-args>; isMeta lines are skipped for the title', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT3', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        isMeta: true,
        message: { content: 'Base directory for this skill ...' },
        cwd
      },
      {
        type: 'user',
        message: {
          content: '<command-name>/review</command-name>\n<command-args>the PR diff</command-args>'
        },
        cwd
      }
    ])
    tracker.bindSession('tabT3', file, SID, cwd)
    const s = await waitFor(tracker, (x) => x.tabId === 'tabT3' && x.title === 'the PR diff')
    expect(s.title).toBe('the PR diff')
  })

  it('the message-first command wrapper (newer claude) still titles by <command-args>', async () => {
    // Newer claude versions reorder the wrapper tags: <command-message> comes BEFORE
    // <command-name>. A session launched straight into a skill/command must still be
    // titled by its args — never by the raw wrapper XML.
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT8', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        message: {
          content:
            '<command-message>deep-research</command-message>\n<command-name>/deep-research</command-name>\n<command-args>research the best ghostty config</command-args>'
        },
        cwd
      }
    ])
    tracker.bindSession('tabT8', file, SID, cwd)
    const s = await waitFor(
      tracker,
      (x) => x.tabId === 'tabT8' && x.title === 'research the best ghostty config'
    )
    expect(s.title).not.toContain('<command-')
  })

  it('an argless command session is titled by the command name, never the wrapper XML', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT9', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        message: {
          content:
            '<command-message>release-dmg</command-message>\n<command-name>/release-dmg</command-name>'
        },
        cwd
      }
    ])
    tracker.bindSession('tabT9', file, SID, cwd)
    const s = await waitFor(tracker, (x) => x.tabId === 'tabT9' && x.title === '/release-dmg')
    expect(s.title).toBe('/release-dmg')
  })

  it('an argless command never blocks the real first prompt from titling the session', async () => {
    // /model, /status etc. typed before the real work must not pin the title: the
    // command name is only the LOWEST-priority fallback, below the first prompt.
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT10', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        message: {
          content: '<command-message>model</command-message>\n<command-name>/model</command-name>'
        },
        cwd
      },
      { type: 'user', message: { content: 'fix the login crash' }, cwd }
    ])
    tracker.bindSession('tabT10', file, SID, cwd)
    const s = await waitFor(
      tracker,
      (x) => x.tabId === 'tabT10' && x.title === 'fix the login crash'
    )
    expect(s.title).toBe('fix the login crash')
  })

  it('a command WITH args must not pin the title either: the real first prompt takes over', async () => {
    // `/model opus` typed first: "opus" is a parameter, not the session's intent.
    // Command args are a MID-priority fallback (above the bare command name, below
    // any plain prompt), so the user's actual first message re-titles the session.
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT10b', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        message: {
          content:
            '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'
        },
        cwd
      },
      { type: 'user', message: { content: 'fix the login crash' }, cwd }
    ])
    tracker.bindSession('tabT10b', file, SID, cwd)
    const s = await waitFor(
      tracker,
      (x) => x.tabId === 'tabT10b' && x.title === 'fix the login crash'
    )
    expect(s.title).toBe('fix the login crash')
  })

  it('classifyUserPrompt routes wrapper args / plain text / argless name to distinct slots', () => {
    // Three sources, three priorities: plain text is `title`, wrapper args are
    // `commandArgs` (a later plain prompt must beat them), an argless command's
    // name is `commandName` (lowest).
    expect(
      classifyUserPrompt('<command-name>/model</command-name>\n<command-args>opus</command-args>')
    ).toEqual({ genuine: true, title: null, commandArgs: 'opus', commandName: null })
    expect(
      classifyUserPrompt(
        '<command-message>model</command-message>\n<command-name>/model</command-name>'
      )
    ).toEqual({ genuine: false, title: null, commandArgs: null, commandName: '/model' })
    expect(classifyUserPrompt('fix the login crash')).toEqual({
      genuine: true,
      title: 'fix the login crash',
      commandArgs: null,
      commandName: null
    })
  })

  it('a genuine prompt that merely starts with a <command-…> token is not a wrapper', async () => {
    // Only the KNOWN wrapper tags mark a slash-command message; pasted XML/doc text
    // like '<command-line> …' is a real prompt and must title the session (and count
    // as activity), not be swallowed as argless plumbing.
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT11', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        message: { content: '<command-line> parsing in bash is broken, please fix' },
        cwd
      }
    ])
    tracker.bindSession('tabT11', file, SID, cwd)
    const s = await waitFor(tracker, (x) => x.tabId === 'tabT11' && x.title !== 'Claude session')
    expect(s.title).toBe('<command-line> parsing in bash is broken, please fix')
  })

  it('a skill/command invoked with an image-only argument is not titled `[Image #1]`', async () => {
    // The reported bug: `/goal <pasted image>` records command-args as the TUI's
    // `[Image #1]` placeholder — that must be skipped so the next real prompt titles it.
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT4', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        message: {
          content: '<command-name>/goal</command-name>\n<command-args>[Image #1]</command-args>'
        },
        cwd
      },
      { type: 'user', message: { content: 'why is the event list wrong' }, cwd }
    ])
    tracker.bindSession('tabT4', file, SID, cwd)
    const s = await waitFor(
      tracker,
      (x) => x.tabId === 'tabT4' && x.title === 'why is the event list wrong'
    )
    expect(s.title).toBe('why is the event list wrong')
    expect(s.title).not.toContain('[Image')
  })

  it('strips inline image placeholders, keeping the real prompt text as the title', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT5', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: '[Image #1] [Image #2] why do stale events still show' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } }
          ]
        },
        cwd
      }
    ])
    tracker.bindSession('tabT5', file, SID, cwd)
    const s = await waitFor(
      tracker,
      (x) => x.tabId === 'tabT5' && x.title === 'why do stale events still show'
    )
    expect(s.title).toBe('why do stale events still show')
  })

  it('a pasted-image-only prompt is skipped so the next genuine prompt titles the session', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT6', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: '[Image #1]' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } }
          ]
        },
        cwd
      },
      { type: 'user', message: { content: 'debug the docker containers' }, cwd }
    ])
    tracker.bindSession('tabT6', file, SID, cwd)
    const s = await waitFor(
      tracker,
      (x) => x.tabId === 'tabT6' && x.title === 'debug the docker containers'
    )
    expect(s.title).toBe('debug the docker containers')
    expect(s.title).not.toContain('[Image')
  })

  it('an image pasted mid-text does not inject a spurious space into the title', async () => {
    // CJK is the project's focus: `你好<image>世界` must not become `你好 世界`.
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT7', cwd)
    const file = writeJsonl(cwd, SID, [
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: '你好[Image #1]世界' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } }
          ]
        },
        cwd
      }
    ])
    tracker.bindSession('tabT7', file, SID, cwd)
    const s = await waitFor(tracker, (x) => x.tabId === 'tabT7' && x.title === '你好世界')
    expect(s.title).toBe('你好世界')
  })
})

describe('SessionTracker — binding', () => {
  it('never guesses: a jsonl already sitting in the cwd’s project dir stays unbound until the hook reports', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    const file = writeJsonl(cwd, SID, [{ type: 'user', message: { content: 'hi' }, cwd }])
    tracker.track('tabF', cwd)
    await new Promise((r) => setTimeout(r, 300)) // ample time for any inference to fire
    expect(tracker.list().find((x) => x.tabId === 'tabF')!.jsonlPath).toBeNull()
    // the SessionStart hook is the only binding path
    tracker.bindSession('tabF', file, SID, cwd)
    const s = await waitFor(tracker, (x) => x.tabId === 'tabF' && x.jsonlPath === file)
    expect(s.sessionId).toBe(SID)
    expect(path.dirname(file)).toBe(path.join(projectsRoot, encodeCwd(cwd)))
  })

  it('adopts the hook-reported worktree cwd over the launch cwd', async () => {
    const launchCwd = makeWorkspace({})
    const worktreeCwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabW', launchCwd)
    const file = writeJsonl(worktreeCwd, SID, [
      { type: 'user', message: { content: 'x' }, cwd: worktreeCwd }
    ])
    tracker.bindSession('tabW', file, SID, worktreeCwd)
    const s = await waitFor(tracker, (x) => x.tabId === 'tabW' && x.cwd === worktreeCwd)
    expect(s.cwd).toBe(worktreeCwd)
  })

  // The file panel roots at `treeRoot` — the checkout the session was established
  // in — NOT at the live cwd: the Claude TUI cd'ing around mid-session moves `cwd`
  // (display, relative-path resolution) but must never re-root the tree.
  describe('treeRoot pinning (file panel root)', () => {
    /** A main-checkout fixture: a workspace dir with a real `.git` DIRECTORY. */
    function makeRepo(): string {
      const repo = makeWorkspace({})
      fs.mkdirSync(path.join(repo, '.git'))
      return repo
    }

    it('keeps treeRoot at the bind-time root while jsonl cwd drift moves cwd', async () => {
      const ws = makeWorkspace({})
      const driftWs = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabTR1', ws)
      const file = writeJsonl(ws, SID, [{ type: 'user', message: { content: 'hi' }, cwd: ws }])
      tracker.bindSession('tabTR1', file, SID, ws)
      await waitFor(tracker, (x) => x.tabId === 'tabTR1' && x.jsonlPath === file)
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant', cwd: driftWs }) + '\n')
      const s = await waitFor(tracker, (x) => x.tabId === 'tabTR1' && x.cwd === driftWs)
      expect(s.treeRoot).toBe(ws)
    })

    it('pins the bound cwd VERBATIM — a subdir workspace keeps its subdir root (D5, no walk-up)', async () => {
      const repo = makeRepo()
      const sub = path.join(repo, 'src')
      fs.mkdirSync(sub)
      const tracker = newTracker()
      tracker.track('tabTR2', sub)
      const file = writeJsonl(sub, SID, [{ type: 'user', message: { content: 'x' }, cwd: sub }])
      tracker.bindSession('tabTR2', file, SID, sub)
      const s = await waitFor(tracker, (x) => x.tabId === 'tabTR2' && x.jsonlPath === file)
      expect(s.cwd).toBe(sub)
      expect(s.treeRoot).toBe(sub)
    })

    it('a -w launch: provisional repo root, re-pinned to the hook-reported worktree, immune to drifting back', async () => {
      const { repo, wt } = repoWithWorktree('feat')
      const tracker = newTracker()
      tracker.track('tabTR3', repo)
      // pre-bind, the launch cwd's checkout root stands in (what the panel shows today)
      expect(tracker.list().find((x) => x.tabId === 'tabTR3')!.treeRoot).toBe(repo)
      const file = writeJsonl(wt, SID, [{ type: 'user', message: { content: 'x' }, cwd: wt }])
      tracker.bindSession('tabTR3', file, SID, wt)
      const s1 = await waitFor(tracker, (x) => x.tabId === 'tabTR3' && x.cwd === wt)
      expect(s1.treeRoot).toBe(wt)
      // the TUI wandering back into the main checkout must not re-root the worktree session
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant', cwd: repo }) + '\n')
      const s2 = await waitFor(tracker, (x) => x.tabId === 'tabTR3' && x.cwd === repo)
      expect(s2.treeRoot).toBe(wt)
    })

    it('hook without a cwd: the first jsonl-logged cwd finalizes the pin, later drift does not', async () => {
      const launchCwd = makeWorkspace({})
      const realWs = makeWorkspace({})
      const driftWs = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabTR4', launchCwd)
      const file = writeJsonl(realWs, SID, [
        { type: 'user', message: { content: 'x' }, cwd: realWs }
      ])
      tracker.bindSession('tabTR4', file, SID)
      const s1 = await waitFor(tracker, (x) => x.tabId === 'tabTR4' && x.cwd === realWs)
      expect(s1.treeRoot).toBe(realWs)
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant', cwd: driftWs }) + '\n')
      const s2 = await waitFor(tracker, (x) => x.tabId === 'tabTR4' && x.cwd === driftWs)
      expect(s2.treeRoot).toBe(realWs)
    })

    it('hook without a cwd, first jsonl cwd equal to launch: still finalized there, drift ignored', async () => {
      const ws = makeWorkspace({})
      const driftWs = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabTR5', ws)
      const file = writeJsonl(ws, SID, [{ type: 'user', message: { content: 'x' }, cwd: ws }])
      tracker.bindSession('tabTR5', file, SID)
      // wait on a PARSE-derived signal (the seeded prompt titling the row), not just
      // jsonlPath: launch cwd equals ws here, so cwd can't tell "line 1 consumed"
      // apart from "not started", and appending the drift record before the first
      // parse tick let one batch pin the root at driftWs under load (flake)
      await waitFor(tracker, (x) => x.tabId === 'tabTR5' && x.title === 'x')
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant', cwd: driftWs }) + '\n')
      const s = await waitFor(tracker, (x) => x.tabId === 'tabTR5' && x.cwd === driftWs)
      expect(s.treeRoot).toBe(ws)
    })

    it('a /clear rebind re-pins to the hook cwd — a session restarted elsewhere is not chained to the old root', async () => {
      const wsA = makeWorkspace({})
      const wsB = makeWorkspace({})
      const SID2 = '22222222-2222-4222-8222-222222222222'
      const tracker = newTracker()
      tracker.track('tabTR6', wsA)
      const fileA = writeJsonl(wsA, SID, [{ type: 'user', message: { content: 'x' }, cwd: wsA }])
      tracker.bindSession('tabTR6', fileA, SID, wsA, '', '', 'startup')
      await waitFor(tracker, (x) => x.tabId === 'tabTR6' && x.jsonlPath === fileA)
      // the TUI cd'ed to wsB, then the user typed /clear: SessionStart fires again
      const fileB = writeJsonl(wsB, SID2, [{ type: 'user', message: { content: 'y' }, cwd: wsB }])
      tracker.bindSession('tabTR6', fileB, SID2, wsB, '', '', 'clear')
      const s = await waitFor(tracker, (x) => x.tabId === 'tabTR6' && x.sessionId === SID2)
      expect(s.treeRoot).toBe(wsB)
    })

    it('a compact SessionStart fires MID-TURN and must never re-pin (its cwd may be drift)', async () => {
      const wsA = makeWorkspace({})
      const wsB = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabTR7', wsA)
      const file = writeJsonl(wsA, SID, [{ type: 'user', message: { content: 'x' }, cwd: wsA }])
      tracker.bindSession('tabTR7', file, SID, wsA, '', '', 'startup')
      await waitFor(tracker, (x) => x.tabId === 'tabTR7' && x.jsonlPath === file)
      tracker.bindSession('tabTR7', file, SID, wsB, '', '', 'compact')
      const s = await waitFor(tracker, (x) => x.tabId === 'tabTR7' && x.cwd === wsB)
      expect(s.treeRoot).toBe(wsA)
    })

    it('hook without a cwd pins the NEWEST replayed cwd, not the transcript’s oldest history', async () => {
      const launchCwd = makeWorkspace({})
      const oldWs = makeWorkspace({})
      const newWs = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabTR8', launchCwd)
      const file = writeJsonl(oldWs, SID, [
        { type: 'user', message: { content: 'x' }, cwd: oldWs },
        { type: 'assistant', cwd: newWs }
      ])
      tracker.bindSession('tabTR8', file, SID)
      const s = await waitFor(tracker, (x) => x.tabId === 'tabTR8' && x.cwd === newWs)
      expect(s.treeRoot).toBe(newWs)
    })

    it('re-homes the pin when the pinned dir no longer exists (worktree removed under a live session)', async () => {
      const wsA = makeWorkspace({})
      const wsB = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabTR9', wsA)
      const file = writeJsonl(wsA, SID, [{ type: 'user', message: { content: 'x' }, cwd: wsA }])
      tracker.bindSession('tabTR9', file, SID, wsA)
      await waitFor(tracker, (x) => x.tabId === 'tabTR9' && x.jsonlPath === file)
      fs.rmSync(wsA, { recursive: true, force: true })
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant', cwd: wsB }) + '\n')
      const s = await waitFor(tracker, (x) => x.tabId === 'tabTR9' && x.cwd === wsB)
      expect(s.treeRoot).toBe(wsB)
    })
  })

  // F7 force-close: the renderer that asks has lost its tabs, so main must resolve the
  // session id → pty itself. What it resolves is what gets killed — an id that resolves
  // to nothing (a claude running outside Koloft keeps its transcript fresh) must kill
  // nothing at all.
  describe('aliveTabFor', () => {
    it('resolves a bound session id to its live tab', async () => {
      const cwd = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabAT1', cwd)
      const file = writeJsonl(cwd, SID, [{ type: 'user', message: { content: 'hi' }, cwd }])
      tracker.bindSession('tabAT1', file, SID, cwd)
      await waitFor(tracker, (x) => x.tabId === 'tabAT1' && x.sessionId === SID)
      expect(tracker.aliveTabFor(SID)).toBe('tabAT1')
    })

    it('stops resolving once the tab is no longer alive', async () => {
      const cwd = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabAT2', cwd)
      const file = writeJsonl(cwd, SID, [{ type: 'user', message: { content: 'hi' }, cwd }])
      tracker.bindSession('tabAT2', file, SID, cwd)
      await waitFor(tracker, (x) => x.tabId === 'tabAT2' && x.sessionId === SID)
      tracker.setAlive('tabAT2', false)
      expect(tracker.aliveTabFor(SID)).toBeNull()
    })

    it('returns null for a session nothing is bound to', () => {
      const cwd = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabAT3', cwd)
      expect(tracker.aliveTabFor(SID)).toBeNull()
    })

    it('never resolves the empty id — an unbound tab carries sessionId ""', () => {
      const cwd = makeWorkspace({})
      const tracker = newTracker()
      tracker.track('tabAT4', cwd)
      expect(tracker.list().find((x) => x.tabId === 'tabAT4')!.sessionId).toBe('')
      expect(tracker.aliveTabFor('')).toBeNull()
    })
  })
})

describe('SessionTracker — run-state', () => {
  it('bindSession seeds waiting; setStatus transitions are reflected + emitted', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabS', cwd)
    const file = writeJsonl(cwd, SID, [{ type: 'user', message: { content: 'go' }, cwd }])
    tracker.bindSession('tabS', file, SID, cwd)
    await waitFor(tracker, (x) => x.tabId === 'tabS' && x.status === 'waiting')

    tracker.setStatus('tabS', 'working')
    await waitFor(tracker, (x) => x.tabId === 'tabS' && x.status === 'working')

    tracker.setStatus('tabS', 'approval')
    const s = await waitFor(tracker, (x) => x.tabId === 'tabS' && x.status === 'approval')
    expect(s.status).toBe('approval')
  })

  it('setStatus emits a prev→next transition event (the attention layer feeds on it)', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabT', cwd)
    const file = writeJsonl(cwd, SID, [{ type: 'user', message: { content: 'go' }, cwd }])
    const transitions: { tabId: string; prev?: string; next: string }[] = []
    tracker.on('status', (t: { tabId: string; prev?: string; next: string }) => transitions.push(t))
    tracker.bindSession('tabT', file, SID, cwd)
    await waitFor(tracker, (x) => x.tabId === 'tabT' && x.status === 'waiting')

    tracker.setStatus('tabT', 'working')
    tracker.setStatus('tabT', 'working') // no change — must NOT re-emit
    tracker.setStatus('tabT', 'waiting')
    const relevant = transitions.filter((t) => t.tabId === 'tabT')
    expect(relevant.at(-2)).toMatchObject({ prev: 'waiting', next: 'working' })
    expect(relevant.at(-1)).toMatchObject({ prev: 'working', next: 'waiting' })
    // exactly one working emission despite the duplicate set
    expect(relevant.filter((t) => t.next === 'working').length).toBe(1)
  })

  it('an image-only prompt still signals user activity and resumes a stale run-state dot', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabS2', cwd)
    // a completed prior turn, so the tab is caught up and its dot sits on a stale 'waiting'
    const file = writeJsonl(cwd, SID, [
      { type: 'user', message: { content: 'initial prompt' }, cwd },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] }, cwd }
    ])
    tracker.bindSession('tabS2', file, SID, cwd) // seeds 'waiting'
    // The seeded status precedes the historical parse; its title confirms catch-up.
    await waitFor(
      tracker,
      (x) => x.tabId === 'tabS2' && x.status === 'waiting' && x.title === 'initial prompt'
    )

    // user pastes ONLY an image (the text block is just the placeholder): a genuine new
    // turn that yields no title text but must still resume the dot to 'working'
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: '[Image #1]' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } }
          ]
        },
        cwd
      }) + '\n'
    )
    const s = await waitFor(tracker, (x) => x.tabId === 'tabS2' && x.status === 'working')
    expect(s.status).toBe('working')
  })
})

// claude can move a live session into another git checkout (EnterWorktree) and
// out again (ExitWorktree). It does that by RENAMING the transcript into another project
// bucket, and it fires no hook at all, so the only signal is the file itself: the inode
// it had is suddenly somewhere else. Everything here drives that real shape.
describe('SessionTracker — a session that moved', () => {
  /** what EnterWorktree / ExitWorktree do on disk: the SAME file, moved to the bucket of
   *  another directory. A rename keeps the inode — that is the whole trigger. */
  function moveTranscript(from: string, toCwd: string): string {
    const dir = path.join(projectsRoot, encodeCwd(toCwd))
    fs.mkdirSync(dir, { recursive: true })
    const to = path.join(dir, path.basename(from))
    fs.renameSync(from, to)
    return to
  }

  const relocated = (dir: string): Record<string, unknown> => ({
    type: 'relocated',
    sessionId: SID,
    relocatedCwd: dir
  })
  const wtState = (wt: string | null): Record<string, unknown> => ({
    type: 'worktree-state',
    sessionId: SID,
    worktreeSession: wt
      ? { originalCwd: 'x', worktreePath: wt, worktreeName: path.basename(wt) }
      : null
  })
  /** a usage record with NO id of any kind: those are always counted (there is nothing to
   *  dedup by), so re-reading the file from the top would count it twice. That is what
   *  makes the cost assertion below a test of the read cursor and not of the dedup set. */
  const spend = (inTok: number): Record<string, unknown> => ({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: inTok, output_tokens: 0 }
    }
  })
  const append = (file: string, lines: Record<string, unknown>[]): void =>
    fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  it('follows the transcript into the worktree, keeping the cursor, the spend and the scratchpad', async () => {
    const { repo, wt } = repoWithWorktree('feat')
    const tracker = newTracker()
    tracker.track('tabM1', repo)
    const file = writeJsonl(repo, SID, [
      { type: 'user', message: { content: 'hi' }, cwd: repo },
      spend(100)
    ])
    tracker.bindSession('tabM1', file, SID, repo)
    const before = await waitFor(tracker, (x) => x.tabId === 'tabM1' && x.usage?.inTok === 100)
    expect(before.treeRoot).toBe(repo)
    const scratchpad = before.scratchpadDir

    const moved = moveTranscript(file, wt)
    append(moved, [relocated(wt), wtState(wt), spend(5)])

    const after = await waitFor(tracker, (x) => x.tabId === 'tabM1' && x.treeRoot === wt)
    expect(after.jsonlPath).toBe(moved)
    // R5: the worktree itself — not the repo above it, not a directory under it
    expect(after.treeRoot).toBe(wt)
    expect(after.worktree).toBe('feat')
    // R3: 105, not 205 — the bytes already read are not read again
    expect(after.usage!.inTok).toBe(105)
    // R6: claude leaves the scratchpad in the bucket the session started in
    expect(after.scratchpadDir).toBe(scratchpad)
    expect(scratchpadDirFor(moved)).not.toBe(scratchpad) // i.e. re-deriving it WOULD move it
  })

  it('follows it back out, where no line ever carries a directory again (R4)', async () => {
    const { repo, wt } = repoWithWorktree('back')
    const tracker = newTracker()
    tracker.track('tabM2', wt)
    const file = writeJsonl(wt, SID, [{ type: 'user', message: { content: 'hi' }, cwd: wt }])
    tracker.bindSession('tabM2', file, SID, wt)
    const before = await waitFor(tracker, (x) => x.tabId === 'tabM2' && x.treeRoot === wt)
    expect(before.worktree).toBe('back')

    // ExitWorktree: the two records say where it landed, and nothing after them has a cwd
    const moved = moveTranscript(file, repo)
    append(moved, [relocated(repo), wtState(null)])

    const after = await waitFor(tracker, (x) => x.tabId === 'tabM2' && x.treeRoot === repo)
    expect(after.worktree).toBeUndefined() // back on the main checkout
    expect(after.cwd).toBe(wt) // the transcript never said otherwise, and that is fine
  })

  it('coalesces a burst of moves: one landing, one notice (R8)', async () => {
    const { repo, wt } = repoWithWorktree('burst')
    const other = repoWithWorktree('burst2')
    const tracker = newTracker()
    const events: { tabId: string; dir: string }[] = []
    tracker.on('relocated', (e: { tabId: string; dir: string }) => events.push(e))
    tracker.track('tabM3', repo)
    const file = writeJsonl(repo, SID, [{ type: 'user', message: { content: 'hi' }, cwd: repo }])
    tracker.bindSession('tabM3', file, SID, repo)
    await waitFor(tracker, (x) => x.tabId === 'tabM3' && x.jsonlPath === file)

    // in, then straight into another one — real transcripts do this 100ms apart. The
    // wait is for the FIRST move to have been seen (otherwise one poll would find only
    // the end state and there would be nothing to coalesce); it is still well inside the
    // settle window, so only the second one may land.
    const first = moveTranscript(file, wt)
    append(first, [relocated(wt), wtState(wt)])
    await waitFor(tracker, (x) => x.tabId === 'tabM3' && x.jsonlPath === first)
    expect(events).toEqual([]) // nothing said yet — the burst has not settled
    const second = moveTranscript(first, other.wt)
    append(second, [relocated(other.wt), wtState(other.wt)])

    const after = await waitFor(tracker, (x) => x.tabId === 'tabM3' && x.treeRoot === other.wt)
    expect(after.jsonlPath).toBe(second)
    expect(events).toEqual([{ tabId: 'tabM3', dir: other.wt }])
  })

  it('a deleted transcript is not answered with a same-id copy in another bucket (R2)', async () => {
    const { repo, wt } = repoWithWorktree('stray')
    const tracker = newTracker()
    tracker.track('tabM4', repo)
    const file = writeJsonl(repo, SID, [{ type: 'user', message: { content: 'mine' }, cwd: repo }])
    tracker.bindSession('tabM4', file, SID, repo)
    await waitFor(tracker, (x) => x.tabId === 'tabM4' && x.title === 'mine')

    // a COPY, not a move: same name, same content, its own inode — and then ours is gone
    const dir = path.join(projectsRoot, encodeCwd(wt))
    fs.mkdirSync(dir, { recursive: true })
    const stray = path.join(dir, SID + '.jsonl')
    fs.copyFileSync(file, stray)
    fs.appendFileSync(stray, JSON.stringify({ type: 'ai-title', aiTitle: 'not mine' }) + '\n')
    fs.rmSync(file)

    await new Promise((r) => setTimeout(r, 2500))
    const s = tracker.list().find((x) => x.tabId === 'tabM4')!
    expect(s.jsonlPath).toBe(file)
    expect(s.title).toBe('mine')
    expect(s.treeRoot).toBe(repo)
  })

  it('a plain cd into another checkout moves nothing: the file never moved (R1)', async () => {
    const { repo, wt } = repoWithWorktree('cdonly')
    const tracker = newTracker()
    tracker.track('tabM5', repo)
    const file = writeJsonl(repo, SID, [{ type: 'user', message: { content: 'hi' }, cwd: repo }])
    tracker.bindSession('tabM5', file, SID, repo)
    await waitFor(tracker, (x) => x.tabId === 'tabM5' && x.jsonlPath === file)

    append(file, [{ type: 'assistant', cwd: wt }])
    const s = await waitFor(tracker, (x) => x.tabId === 'tabM5' && x.cwd === wt)
    expect(s.treeRoot).toBe(repo)
    expect(s.worktree).toBeUndefined()
  })

  it('re-reads from the top when the file is smaller than the cursor (R3)', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabM6', cwd)
    const file = writeJsonl(cwd, SID, [
      { type: 'ai-title', aiTitle: 'the long one' },
      { type: 'user', message: { content: 'x' }, cwd },
      spend(100)
    ])
    tracker.bindSession('tabM6', file, SID, cwd)
    await waitFor(tracker, (x) => x.tabId === 'tabM6' && x.title === 'the long one')

    // the stub claude sometimes leaves at the old path: same file, far shorter
    fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'the stub' }) + '\n')
    const s = await waitFor(tracker, (x) => x.tabId === 'tabM6' && x.title === 'the stub')
    expect(s.usage).toBeUndefined() // the spend was in the bytes that are gone
  })

  it('a relative path keeps meaning the file under the directory it was read in (R12)', async () => {
    const a = makeWorkspace({ 'notes.md': 'A\n' })
    const b = makeWorkspace({ 'notes.md': 'B\n' })
    const tracker = newTracker()
    tracker.track('tabM7', a)
    const file = writeJsonl(a, SID, [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'notes.md' } }]
        },
        cwd: a
      }
    ])
    tracker.bindSession('tabM7', file, SID, a)
    await waitFor(tracker, (x) => x.tabId === 'tabM7' && x.files.length === 1)

    // the session walks on; the file it read back there is still that one
    append(file, [{ type: 'assistant', cwd: b }])
    const s = await waitFor(tracker, (x) => x.tabId === 'tabM7' && x.cwd === b)
    expect(s.files.map((f) => f.src)).toEqual([path.join(a, 'notes.md')])
    expect(s.lastTouched).toBe(path.join(a, 'notes.md'))
  })
})

describe('SessionTracker — per-session usage', () => {
  /** One assistant record carrying token usage, in the real jsonl shape. */
  const asst = (o: {
    id: string
    req: string
    model: string
    in: number
    out: number
    cw: number
    cr: number
    ts?: string
    cwd: string
  }): Record<string, unknown> => ({
    type: 'assistant',
    requestId: o.req,
    timestamp: o.ts ?? new Date().toISOString(),
    message: {
      role: 'assistant',
      id: o.id,
      model: o.model,
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: o.in,
        output_tokens: o.out,
        cache_creation_input_tokens: o.cw,
        cache_read_input_tokens: o.cr
      }
    },
    cwd: o.cwd
  })

  it('dedups a usage record repeated by streaming (same id+requestId) — counts it once', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabU1', cwd)
    // the identical record appears 3× — exactly what streaming writes to the jsonl
    const rec = asst({
      id: 'msg_a',
      req: 'req_a',
      model: 'claude-opus-4-8',
      in: 100,
      out: 200,
      cw: 1000,
      cr: 5000,
      cwd
    })
    const file = writeJsonl(cwd, SID, [rec, rec, rec])
    tracker.bindSession('tabU1', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabU1' && !!x.usage)
    // tokens counted once, not 3×
    expect(s.usage!.inTok).toBe(100)
    expect(s.usage!.outTok).toBe(200)
    expect(s.usage!.cacheWriteTok).toBe(1000)
    expect(s.usage!.cacheReadTok).toBe(5000)
    // opus-4-8 = $5/$25/$6.25/$0.5 per Mtok → single-record cost, not tripled
    const expected = (100 * 5 + 200 * 25 + 1000 * 6.25 + 5000 * 0.5) / 1_000_000
    expect(s.usage!.costUsd).toBeCloseTo(expected, 10)
  })

  it('captures the CLI version and the hook-reported account (info-card metadata)', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabUM', cwd)
    const rec = asst({
      id: 'mv',
      req: 'rv',
      model: 'claude-opus-4-8',
      in: 1,
      out: 1,
      cw: 0,
      cr: 0,
      cwd
    })
    rec.version = '2.0.0-test' // every real Claude Code record stamps its CLI version
    const file = writeJsonl(cwd, SID, [rec])
    tracker.bindSession('tabUM', file, SID, cwd, 'acct-x', '3.9.9')

    const s = await waitFor(tracker, (x) => x.tabId === 'tabUM' && !!x.usage)
    expect(s.usage!.ccVersion).toBe('2.0.0-test') // what the transcript was written by
    expect(s.ccVersion).toBe('3.9.9') // what is RUNNING now (outranks in the card)
    expect(s.account).toBe('acct-x')
  })

  it('unknown model → tokens present but NO cost (design D6: never a wrong $)', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabU2', cwd)
    const file = writeJsonl(cwd, SID, [
      asst({
        id: 'm1',
        req: 'r1',
        model: 'totally-made-up-model',
        in: 10,
        out: 20,
        cw: 0,
        cr: 0,
        cwd
      })
    ])
    tracker.bindSession('tabU2', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabU2' && !!x.usage)
    expect(s.usage!.inTok).toBe(10)
    expect(s.usage!.outTok).toBe(20)
    expect(s.usage!.costUsd).toBeUndefined()
    expect(s.usage!.todayCostUsd).toBeUndefined()
    expect(s.usage!.ctxPct).toBeUndefined() // no known window either
  })

  it('context uses the LATEST record, not the first or the sum', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabU3', cwd)
    const file = writeJsonl(cwd, SID, [
      asst({
        id: 'm1',
        req: 'r1',
        model: 'claude-opus-4-8',
        in: 10,
        out: 5,
        cw: 0,
        cr: 90_000,
        cwd
      }),
      asst({
        id: 'm2',
        req: 'r2',
        model: 'claude-opus-4-8',
        in: 10,
        out: 5,
        cw: 0,
        cr: 150_000,
        cwd
      })
    ])
    tracker.bindSession('tabU3', file, SID, cwd)

    // wait until the SECOND record has been folded in (ctxTokens reflects the latest)
    const s = await waitFor(tracker, (x) => x.tabId === 'tabU3' && x.usage?.ctxTokens === 150_010)
    expect(s.usage!.ctxTokens).toBe(150_010) // 10 + 0 + 150000 (latest), not 90010 or the sum
    // opus-4-8 has a real 1M window (finding #7) — ctxPct measures against that
    expect(s.usage!.ctxPct).toBeCloseTo(150_010 / 1_000_000, 6)
  })

  it('skips <synthetic> records but still counts the real one', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabU4', cwd)
    const file = writeJsonl(cwd, SID, [
      asst({
        id: 'syn',
        req: 'rs',
        model: '<synthetic>',
        in: 999,
        out: 999,
        cw: 999,
        cr: 999,
        cwd
      }),
      asst({ id: 'm1', req: 'r1', model: 'claude-opus-4-8', in: 7, out: 8, cw: 0, cr: 0, cwd })
    ])
    tracker.bindSession('tabU4', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabU4' && !!x.usage)
    // the synthetic record's 999s must not leak into any accumulator
    expect(s.usage!.inTok).toBe(7)
    expect(s.usage!.outTok).toBe(8)
    expect(s.usage!.model).toBe('claude-opus-4-8')
  })

  it("today's cost tracks only records on the current local calendar day", async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabU5', cwd)
    const file = writeJsonl(cwd, SID, [
      // a record dated well in the past must NOT count toward "today"
      asst({
        id: 'old',
        req: 'ro',
        model: 'claude-opus-4-8',
        in: 100,
        out: 100,
        cw: 0,
        cr: 0,
        ts: '2020-01-01T00:00:00.000Z',
        cwd
      }),
      // ...but a record dated now must
      asst({ id: 'now', req: 'rn', model: 'claude-opus-4-8', in: 100, out: 100, cw: 0, cr: 0, cwd })
    ])
    tracker.bindSession('tabU5', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabU5' && x.usage?.todayCostUsd != null)
    const oneRec = (100 * 5 + 100 * 25) / 1_000_000
    // session cost = both records; today = only the current-day record
    expect(s.usage!.costUsd).toBeCloseTo(oneRec * 2, 10)
    expect(s.usage!.todayCostUsd).toBeCloseTo(oneRec, 10)
  })

  it('rebinding to a DIFFERENT session resets the accumulators', async () => {
    const cwd = makeWorkspace({})
    const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const tracker = newTracker()
    tracker.track('tabU6', cwd)
    const fileA = writeJsonl(cwd, SID_A, [
      asst({ id: 'ma', req: 'ra', model: 'claude-opus-4-8', in: 500, out: 500, cw: 0, cr: 0, cwd })
    ])
    tracker.bindSession('tabU6', fileA, SID_A, cwd)
    await waitFor(tracker, (x) => x.tabId === 'tabU6' && x.usage?.inTok === 500)

    // hook rebinds the SAME tab to a new session (e.g. in-TUI /clear or /resume)
    const fileB = writeJsonl(cwd, SID_B, [
      asst({ id: 'mb', req: 'rb', model: 'claude-opus-4-8', in: 7, out: 7, cw: 0, cr: 0, cwd })
    ])
    tracker.bindSession('tabU6', fileB, SID_B, cwd)

    const s = await waitFor(
      tracker,
      (x) => x.tabId === 'tabU6' && x.sessionId === SID_B && x.usage?.inTok === 7
    )
    // session B's accumulators start fresh — session A's 500 must be gone
    expect(s.usage!.inTok).toBe(7)
    expect(s.usage!.outTok).toBe(7)
  })

  it('folds subagent-transcript spend into the session totals but not its context (#1)', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabSA', cwd)
    // main record: ctx = 10 + 40000 + 0 = 40010
    const file = writeJsonl(cwd, SID, [
      asst({
        id: 'main',
        req: 'rmain',
        model: 'claude-opus-4-8',
        in: 10,
        out: 20,
        cw: 0,
        cr: 40_000,
        cwd
      })
    ])
    // subagent transcript (real cost — up to ~78% of a session's spend lives here)
    writeSubagentJsonl(cwd, SID, 'agent-x.jsonl', [
      asst({
        id: 'sub',
        req: 'rsub',
        model: 'claude-opus-4-8',
        in: 4632,
        out: 1,
        cw: 10_478,
        cr: 0,
        cwd
      })
    ])
    tracker.bindSession('tabSA', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabSA' && x.usage?.inTok === 4642)
    // subagent tokens + cost fold into the totals...
    expect(s.usage!.inTok).toBe(4642) // 10 (main) + 4632 (subagent)
    const mainCost = (10 * 5 + 20 * 25 + 40_000 * 0.5) / 1_000_000
    const subCost = (4632 * 5 + 1 * 25 + 10_478 * 6.25) / 1_000_000
    expect(s.usage!.costUsd).toBeCloseTo(mainCost + subCost, 9)
    // ...but the subagent's context is NOT the parent session's — ctx stays the main record's
    expect(s.usage!.ctxTokens).toBe(40_010)
  })

  it('counts id-less records every time — no false dedupe collapse', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabIL', cwd)
    // two records with NEITHER message.id NOR requestId: unkeyable, so each must count
    const rec = {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      },
      cwd
    }
    const file = writeJsonl(cwd, SID, [rec, rec])
    tracker.bindSession('tabIL', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabIL' && !!x.usage)
    expect(s.usage!.inTok).toBe(200) // both counted, not collapsed to a single 100
  })

  it('folds subagent spend when ONLY the subagent transcript grows (idle main jsonl)', async () => {
    // A background Task subagent burns tokens while the session idles at the prompt;
    // its result reaches the main transcript only at the next user interaction. The
    // poll timer must fold that spend without any main-jsonl write — otherwise the
    // status-bar cost freezes at the pre-subagent value indefinitely.
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabSP', cwd)
    const file = writeJsonl(cwd, SID, [
      asst({ id: 'main', req: 'rm', model: 'claude-opus-4-8', in: 10, out: 5, cw: 0, cr: 0, cwd })
    ])
    tracker.bindSession('tabSP', file, SID, cwd)
    await waitFor(tracker, (x) => x.tabId === 'tabSP' && x.usage?.inTok === 10)

    // now ONLY a subagent transcript appears — the main jsonl never changes again
    writeSubagentJsonl(cwd, SID, 'agent-late.jsonl', [
      asst({ id: 'late', req: 'rl', model: 'claude-opus-4-8', in: 777, out: 1, cw: 0, cr: 0, cwd })
    ])
    const s = await waitFor(tracker, (x) => x.tabId === 'tabSP' && x.usage?.inTok === 787, 15_000)
    expect(s.usage!.inTok).toBe(787) // 10 (main) + 777 (subagent-only growth)
  }, 20_000)

  it('a sidechain record in the MAIN jsonl adds cost but not context/model', async () => {
    // Some CC versions interleave Task-subagent turns into the main transcript as
    // isSidechain records — same rule as the subagents/-dir channel: their spend is
    // the session's, their context window is not.
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabSC', cwd)
    const main = asst({
      id: 'm1',
      req: 'r1',
      model: 'claude-opus-4-8',
      in: 10,
      out: 5,
      cw: 0,
      cr: 40_000,
      cwd
    })
    const side = asst({
      id: 's1',
      req: 'rs1',
      model: 'claude-haiku-4-5',
      in: 4000,
      out: 2,
      cw: 0,
      cr: 0,
      cwd
    })
    ;(side as Record<string, unknown>).isSidechain = true
    const file = writeJsonl(cwd, SID, [main, side])
    tracker.bindSession('tabSC', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabSC' && x.usage?.inTok === 4010)
    expect(s.usage!.model).toBe('claude-opus-4-8') // the sidechain's model must not win
    expect(s.usage!.ctxTokens).toBe(40_010) // main record's context, not the sidechain's ~4k
    const mainCost = (10 * 5 + 5 * 25 + 40_000 * 0.5) / 1_000_000
    const sideCost = (4000 * 1 + 2 * 5) / 1_000_000
    expect(s.usage!.costUsd).toBeCloseTo(mainCost + sideCost, 10)
  })

  it('an out-of-order OLDER-dated record does not wipe today (#4)', async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabOO', cwd)
    // today's record FIRST, then an older-dated one; the older must neither reset nor add
    const file = writeJsonl(cwd, SID, [
      asst({
        id: 'now',
        req: 'rn',
        model: 'claude-opus-4-8',
        in: 100,
        out: 100,
        cw: 0,
        cr: 0,
        cwd
      }),
      asst({
        id: 'old',
        req: 'ro',
        model: 'claude-opus-4-8',
        in: 100,
        out: 100,
        cw: 0,
        cr: 0,
        ts: '2020-01-01T00:00:00.000Z',
        cwd
      })
    ])
    tracker.bindSession('tabOO', file, SID, cwd)

    const s = await waitFor(tracker, (x) => x.tabId === 'tabOO' && x.usage?.todayCostUsd != null)
    const oneRec = (100 * 5 + 100 * 25) / 1_000_000
    expect(s.usage!.todayCostUsd).toBeCloseTo(oneRec, 10) // today's record only; older didn't wipe it
    expect(s.usage!.costUsd).toBeCloseTo(oneRec * 2, 10) // both still in the session total
    expect(s.usage!.todayDayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/) // carries its day for the renderer gate
  })
})

describe('SessionTracker — compact SessionStart (auto-compaction fires mid-turn)', () => {
  it("source='compact' does not reseed waiting — no phantom working→waiting edge", async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    tracker.track('tabCP', cwd)
    const file = writeJsonl(cwd, SID, [{ type: 'user', message: { content: 'go' }, cwd }])
    tracker.bindSession('tabCP', file, SID, cwd, '', '', 'startup')
    await waitFor(tracker, (x) => x.tabId === 'tabCP' && x.status === 'waiting')
    tracker.setStatus('tabCP', 'working') // mid-turn when auto-compaction kicks in
    await waitFor(tracker, (x) => x.tabId === 'tabCP' && x.status === 'working')

    const transitions: { prev?: string; next: string }[] = []
    tracker.on('status', (t: { prev?: string; next: string }) => transitions.push(t))
    // Claude Code re-fires SessionStart with source 'compact' (same session, same
    // transcript) — the dot must stay 'working': a working→waiting flicker here
    // becomes a false "turn done — your move" banner in the attention layer
    tracker.bindSession('tabCP', file, SID, cwd, '', '', 'compact')
    expect(tracker.list().find((s) => s.tabId === 'tabCP')!.status).toBe('working')
    expect(transitions).toEqual([])

    // a REAL restart (in-TUI /clear → source 'clear') still seeds waiting
    tracker.bindSession('tabCP', file, SID, cwd, '', '', 'clear')
    expect(tracker.list().find((s) => s.tabId === 'tabCP')!.status).toBe('waiting')
  })
})

describe('scratchpadDirFor — Claude Code per-session scratchpad', () => {
  // Contract: claude writes the scratchpad at <base>/<projectSlug>/<sessionId>/scratchpad,
  // where <base> is /tmp/claude-<uid> and <projectSlug>/<sessionId>.jsonl is where the
  // transcript itself lives — so slug and id are read back off jsonlPath, never re-slugged.
  afterEach(() => {
    delete process.env.KOLOFT_SCRATCHPAD_BASE
  })

  it('composes <base>/<slug>/<sessionId>/scratchpad from the transcript path', () => {
    process.env.KOLOFT_SCRATCHPAD_BASE = '/tmp/koloft-test-claude-uid'
    expect(
      scratchpadDirFor('/somewhere/.claude/projects/-Users-me-Projects-proj/abc-123.jsonl')
    ).toBe('/tmp/koloft-test-claude-uid/-Users-me-Projects-proj/abc-123/scratchpad')
  })

  // claude hardcodes /tmp (it ignores TMPDIR), and the base is spelled as the RESOLVED
  // /tmp — on macOS that is /private/tmp, which is also how canonFile spells the session
  // files it realpath's, so the same file can never reach the tree under two spellings.
  it('defaults the base to the resolved /tmp/claude-<uid>', () => {
    expect(scratchpadDirFor('/h/.claude/projects/-p/sid.jsonl')).toBe(
      `${fs.realpathSync('/tmp')}/claude-${process.getuid!()}/-p/sid/scratchpad`
    )
  })

  it('has no scratchpad before a transcript is bound', () => {
    expect(scratchpadDirFor(null)).toBe(null)
  })

  it('has no scratchpad for a path that is not a .jsonl transcript', () => {
    expect(scratchpadDirFor('/h/.claude/projects/-p/sid')).toBe(null)
  })
})

describe('SessionTracker — scratchpad dir on the emitted session', () => {
  // The slug must come off the TRANSCRIPT's own dir, not from re-encoding cwd. Those two
  // diverge for real: a `-w` session's jsonl stays in the LAUNCH cwd's slug while its cwd
  // is the worktree (the lifecycle contract §6). So bind a transcript that deliberately sits under a
  // slug dir cwd would never produce — re-slugging cwd is then a visibly wrong answer.
  it('reports the scratchpad dir off the transcript slug, not off cwd', async () => {
    const base = fs.mkdtempSync(path.join(home, 'spbase-'))
    process.env.KOLOFT_SCRATCHPAD_BASE = base
    try {
      const cwd = makeWorkspace({ 'a.txt': 'a\n' })
      const otherSlug = encodeCwd(cwd) + '-elsewhere'
      const dir = path.join(projectsRoot, otherSlug)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, SID + '.jsonl')
      fs.writeFileSync(
        file,
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, cwd }) + '\n'
      )

      const tracker = newTracker()
      tracker.track('tabSP', cwd)
      tracker.bindSession('tabSP', file, SID, cwd)
      const s = await waitFor(tracker, (x) => x.tabId === 'tabSP' && !!x.jsonlPath)
      expect(s.scratchpadDir).toBe(path.join(base, otherSlug, SID, 'scratchpad'))
    } finally {
      delete process.env.KOLOFT_SCRATCHPAD_BASE
    }
  })
})

// the ⇧⌘R gate's probe. Claude Code creates a session's jsonl LAZILY, at
// the first user message, while the SessionStart hook reports its path immediately: a
// bound session's `jsonlPath` is a PREDICTION, not proof of a file. The probe answers
// the one question a restart needs before it kills anything — is there a conversation on
// disk to resume — and every branch of that answer is invisible from the outside (the UI
// shows one toast either way), so it is pinned here.
describe('SessionTracker.transcriptExists — the pre-kill disk truth', () => {
  it('answers true for a bound session whose transcript is on disk', () => {
    const cwd = makeWorkspace({ 'a.txt': 'a\n' })
    const file = writeJsonl(cwd, SID, [
      { type: 'user', message: { role: 'user', content: 'hi' }, cwd }
    ])
    const tracker = newTracker()
    tracker.track('tabTE1', cwd)
    tracker.bindSession('tabTE1', file, SID, cwd)

    expect(tracker.transcriptExists(SID)).toBe(true)
  })

  // the issue itself: SessionStart fired, the tracker holds the path, the file does not
  // exist yet. `claude --resume` on this id finds nothing and dies.
  it('answers false for a bound session that was never conversed with', () => {
    const cwd = makeWorkspace({ 'a.txt': 'a\n' })
    const predicted = path.join(projectsRoot, encodeCwd(cwd), SID + '.jsonl')
    fs.mkdirSync(path.dirname(predicted), { recursive: true })
    const tracker = newTracker()
    tracker.track('tabTE2', cwd)
    tracker.bindSession('tabTE2', predicted, SID, cwd)

    expect(tracker.transcriptExists(SID)).toBe(false)
  })

  // A tracker HIT is answered by that entry's own file and nothing else. Falling back to
  // the storage sweep here would let a same-id file in another bucket re-open the gate on
  // a conversation the user just deleted — the false 'true' Edge #6 forbids.
  it('answers false when the bound transcript was deleted, without falling back to the sweep', () => {
    const cwd = makeWorkspace({ 'a.txt': 'a\n' })
    const file = writeJsonl(cwd, SID, [
      { type: 'user', message: { role: 'user', content: 'hi' }, cwd }
    ])
    const tracker = newTracker()
    tracker.track('tabTE3', cwd)
    tracker.bindSession('tabTE3', file, SID, cwd)
    fs.rmSync(file)
    // a stray copy of the same id in another bucket — visible to the sweep, irrelevant here
    const other = path.join(projectsRoot, encodeCwd(cwd) + '-other')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, SID + '.jsonl'), '{}\n')

    expect(tracker.transcriptExists(SID)).toBe(false)
  })

  // A tab is tracked from registration, before any hook: sessionId '' and no path — so
  // the empty id is a state the app really produces, and it must resolve to nothing.
  // Both branches have to refuse it: the sweep would otherwise concatenate to a bare
  // `<bucket>/.jsonl`, which a dotfile in Claude storage makes a real match.
  it('answers false for the empty session id', () => {
    const cwd = makeWorkspace({ 'a.txt': 'a\n' })
    const bucket = path.join(projectsRoot, encodeCwd(cwd))
    fs.mkdirSync(bucket, { recursive: true })
    fs.writeFileSync(path.join(bucket, '.jsonl'), '{}\n')
    const tracker = newTracker()

    expect(tracker.transcriptExists('')).toBe(false) // no entry: unguarded, the dotfile would match
    tracker.track('tabTE4', cwd)
    expect(tracker.transcriptExists('')).toBe(false) // registered-unbound entry: still refused up front
  })

  // The dead-tab anchor path (FR-07): the pty is gone and the tracker entry with it, so
  // the id reaches the probe with no table entry at all. The file is still there, and
  // resuming it is exactly what ⇧⌘R must still do — the answer comes from Claude storage.
  it('finds an untracked session by sweeping Claude storage', () => {
    const cwd = makeWorkspace({ 'a.txt': 'a\n' })
    const gone = '22222222-2222-4222-8222-222222222222'
    writeJsonl(cwd, gone, [{ type: 'user', message: { role: 'user', content: 'hi' }, cwd }])
    const tracker = newTracker()

    expect(tracker.transcriptExists(gone)).toBe(true)
  })

  it('answers false for an id no bucket in Claude storage holds', () => {
    const tracker = newTracker()

    expect(tracker.transcriptExists('33333333-3333-4333-8333-333333333333')).toBe(false)
  })

  // The sweep is by FILE NAME across every bucket, never by re-deriving the session's
  // slug from a cwd: a `-w` session's jsonl lives under the LAUNCH cwd's slug, so a
  // cwd-derived lookup would answer false for a real, resumable conversation.
  it('finds a session filed under a bucket its cwd would never produce', () => {
    const cwd = makeWorkspace({ 'a.txt': 'a\n' })
    const elsewhere = '44444444-4444-4444-8444-444444444444'
    const foreign = path.join(projectsRoot, encodeCwd(cwd) + '-launch-bucket')
    fs.mkdirSync(foreign, { recursive: true })
    fs.writeFileSync(path.join(foreign, elsewhere + '.jsonl'), '{}\n')
    const tracker = newTracker()

    expect(tracker.transcriptExists(elsewhere)).toBe(true)
  })

  // Never throw at the probe. The renderer treats a rejected probe as "do not restart",
  // but that fail-safe must be reached by contract, not by an unreadable storage root
  // accidentally landing there — a machine with no Claude storage yet simply has no
  // conversation to resume, which is a plain false.
  it('answers false instead of throwing when Claude storage does not exist', () => {
    const stashed = projectsRoot + '.stashed'
    fs.renameSync(projectsRoot, stashed)
    try {
      const tracker = newTracker()
      expect(tracker.transcriptExists(SID)).toBe(false)
    } finally {
      fs.rmSync(projectsRoot, { recursive: true, force: true })
      fs.renameSync(stashed, projectsRoot)
    }
  })
})

// ---- remote tabs -----------------------------------------------------------
// A remote tab's claude runs on another machine: its transcript arrives in a mirror
// under userData, and nothing here may walk this Mac's disk on its behalf.
describe('a tab whose claude runs on another machine', () => {
  const RCWD = '/home/koh/api'
  const RSID = 'remote-session-1'

  function mirrorRoot(): string {
    return path.join(home, 'remote', 'devbox', 'projects')
  }

  function remoteTracker(): InstanceType<typeof SessionTracker> {
    const tracker = newTracker()
    tracker.track('tabR', RCWD, {
      host: 'devbox',
      projectsRoot: mirrorRoot(),
      tmuxName: `k-${RSID}`
    })
    return tracker
  }

  // U-TRK-1
  it('predicts the transcript inside the machine mirror, not local storage', () => {
    const tracker = remoteTracker()
    // the hook ran over there, so its path is the machine's — only the slug carries over
    tracker.bindSession(
      'tabR',
      `/home/koh/.claude/projects/-home-koh-api/${RSID}.jsonl`,
      RSID,
      RCWD
    )
    const info = tracker.list().find((s) => s.tabId === 'tabR')
    expect(info?.jsonlPath).toBe(path.join(mirrorRoot(), '-home-koh-api', RSID + '.jsonl'))
    expect(info?.remote).toEqual({ host: 'devbox' })
    expect(info?.cwd).toBe(RCWD)
  })

  it('falls back to the encoded machine path when the hook reported no transcript', () => {
    const tracker = remoteTracker()
    tracker.bindSession('tabR', '', RSID, RCWD)
    expect(tracker.list().find((s) => s.tabId === 'tabR')?.jsonlPath).toBe(
      path.join(mirrorRoot(), encodeCwd(RCWD), RSID + '.jsonl')
    )
  })

  // U-TRK-2
  it('follows the tmux name when an in-TUI /clear mints a new session id', () => {
    const tracker = remoteTracker()
    tracker.bindSession('tabR', '', RSID, RCWD)
    tracker.bindSession('tabR', '', 'session-after-clear', RCWD, '', '', 'clear')
    // the hook renames the tmux session over there to match the new id, and main tells
    // the tracker: liveness, the kill and the restart all key off this name, so a name
    // left pointing at the old id would read the live session as cold
    tracker.setRemoteTmuxName('tabR', 'k-session-after-clear')
    expect(tracker.remoteOf('tabR')?.tmuxName).toBe('k-session-after-clear')
    expect(tracker.list().find((s) => s.tabId === 'tabR')?.sessionId).toBe('session-after-clear')
  })

  // U-TRK-3
  it('answers ⇧⌘R from the mirror, exactly like a local session from its own file', () => {
    const tracker = remoteTracker()
    tracker.bindSession('tabR', '', RSID, RCWD)
    const file = path.join(mirrorRoot(), encodeCwd(RCWD), RSID + '.jsonl')
    // nothing mirrored yet: killing the live claude to resume a conversation that does
    // not exist would lose it for good
    expect(tracker.transcriptExists(RSID)).toBe(false)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}\n')
    expect(tracker.transcriptExists(RSID)).toBe(true)
  })
})

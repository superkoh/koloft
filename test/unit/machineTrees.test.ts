import { describe, expect, it } from 'vitest'
import { parseTaggedTable, toolsOf, treesByTab } from '../../src/main/machineTrees'

const AT = 'Thu Nov 12 00:51:03 2026    '
const KOLOFT = 100
const PS = [
  `  100     1  200000 ${AT} /Applications/Koloft.app/Contents/MacOS/Koloft`,
  `  200   100  300000 ${AT} /Users/me/.local/bin/claude --settings x KOLOFT_TAB_ID=pty-1 HOME=/Users/me`,
  `  201   200   50000 ${AT} node vitest KOLOFT_TAB_ID=pty-1 PATH=/bin`,
  `  202   201  900000 ${AT} /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless`,
  `  203   200  100000 ${AT} /Users/me/.local/bin/claude -p KOLOFT_TAB_ID=pty-1`,
  `  300   100  250000 ${AT} /Users/me/.local/bin/codex --remote ws://x KOLOFT_TAB_ID=pty-2`,
  `  400     1   40000 Mon Nov  9 04:15:47 2026     node daemon.js KOLOFT_TAB_ID=pty-1`,
  `  600   201   10000 ${AT} node child KOLOFT_TAB_ID=pty-9`,
  `  700     1  200000 ${AT} /opt/homebrew/bin/node /opt/homebrew/bin/claude --settings y KOLOFT_TAB_ID=pty-3`,
  `  800   100  150000 ${AT} /Users/me/.local/bin/codex app-server --stdio KOLOFT_TAB_ID=pty-4`,
  `  801   800   90000 ${AT} /bin/zsh -lc npm test`,
  `  900   100  120000 ${AT} /Users/me/.local/share/muse/muse-bin-1.4.11 KOLOFT_TAB_ID=pty-5`,
  `  901   900   30000 ${AT} node srv.mjs`,
  `  950   100   20000 ${AT} /bin/zsh -l KOLOFT_TAB_ID=pty-6`,
  `  951   950   20000 ${AT} /bin/sh /Users/me/rc-helper`
].join('\n')

describe('which processes belong to which session tab', () => {
  const rows = parseTaggedTable(PS)
  const trees = treesByTab(rows)
  const pids = (tab: string): number[] =>
    (trees.get(tab) ?? []).map((p) => p.pid).sort((a, b) => a - b)

  it('a tab owns the processes carrying its tab id and everything under them, its browser too', () => {
    expect(pids('pty-1')).toEqual([200, 201, 202, 203, 400])
    expect(pids('pty-2')).toEqual([300])
  })

  it('a process tagged for another tab belongs to that tab even when it runs under this one', () => {
    expect(pids('pty-9')).toEqual([600])
  })

  it('a Codex tab owns what its app-server runs, though the app-server is not under its terminal', () => {
    expect(pids('pty-4')).toEqual([800, 801])
  })

  it('reads memory in bytes, and when each process started with single spaces', () => {
    const chrome = rows.find((r) => r.pid === 202)!
    expect(chrome.rssBytes).toBe(900000 * 1024)
    expect(chrome.started).toBe('Thu Nov 12 00:51:03 2026')
    expect(rows.find((r) => r.pid === 400)!.started).toBe('Mon Nov 9 04:15:47 2026')
  })
})

describe('which of a tab’s processes are tools that may give way', () => {
  const trees = treesByTab(parseTaggedTable(PS))
  const tools = (tab: string): number[] =>
    toolsOf(trees.get(tab) ?? [], KOLOFT)
      .map((p) => p.pid)
      .sort((a, b) => a - b)

  it('everything under the agent, and never the agent or a claude -p it started', () => {
    expect(tools('pty-1')).toEqual([201, 202, 400])
  })

  it('never the Codex app-server Koloft started, only what it runs', () => {
    expect(tools('pty-4')).toEqual([801])
  })

  it('never the process Koloft started for the tab, whatever its command line says', () => {
    expect(tools('pty-5')).toEqual([901])
    expect(tools('pty-6')).toEqual([951])
  })
})

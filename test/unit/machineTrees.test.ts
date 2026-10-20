import { describe, expect, it } from 'vitest'
import { parseTaggedTable, treesByTab } from '../../src/main/machineTrees'

const PS = [
  '  100     1  200000   2.0 /Applications/Koloft.app/Contents/MacOS/Koloft',
  '  200   100  300000   1.0 /Users/me/.local/bin/claude --settings x KOLOFT_TAB_ID=pty-1 HOME=/Users/me',
  '  201   200   50000  90.0 node vitest KOLOFT_TAB_ID=pty-1 PATH=/bin',
  '  202   201  900000  40.0 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless',
  '  300   100  250000   0.5 /Users/me/.local/bin/codex --remote ws://x KOLOFT_TAB_ID=pty-2',
  '  400     1   40000  10.0 node daemon.js KOLOFT_TAB_ID=pty-1',
  '  500     1 1400000   0.3 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine',
  '  600   201   10000   0.0 node child KOLOFT_TAB_ID=pty-9',
  '  700     1  200000   1.0 /opt/homebrew/bin/node /opt/homebrew/bin/claude --settings y KOLOFT_TAB_ID=pty-3',
  '  800   100  150000   5.0 /Users/me/.local/bin/codex app-server --stdio KOLOFT_HOLD_TAB=pty-4',
  '  801   800   90000  80.0 /bin/zsh -lc npm test'
].join('\n')

describe('which processes belong to which session tab', () => {
  const rows = parseTaggedTable(PS)
  const trees = treesByTab(rows)
  const pids = (tab: string): number[] =>
    (trees.members.get(tab) ?? []).map((p) => p.pid).sort((a, b) => a - b)

  it('a tab owns the processes carrying its tab id and everything under them, its browser too', () => {
    expect(pids('pty-1')).toEqual([200, 201, 202, 400])
    expect(pids('pty-2')).toEqual([300])
  })

  it('a process tagged for another tab belongs to that tab even when it runs under this one', () => {
    expect(pids('pty-9')).toEqual([600])
  })

  it('tells the agent program itself from the tools it runs, an npm-installed one run by node too', () => {
    const agents = rows.filter((r) => r.agent).map((r) => r.pid)
    expect(agents).toEqual([200, 300, 700, 800])
  })

  it('a background Codex tab owns what its app-server runs, though the app-server is not under its terminal', () => {
    expect(pids('pty-4')).toEqual([800, 801])
  })

  it('reads memory in bytes and cpu in percent', () => {
    const chrome = rows.find((r) => r.pid === 202)!
    expect(chrome.rssBytes).toBe(900000 * 1024)
    expect(chrome.cpuPercent).toBe(40)
  })

  it('counts the shared docker VM apart, since no session can be named for it', () => {
    expect(trees.sharedVmBytes).toBe(1400000 * 1024)
  })
})

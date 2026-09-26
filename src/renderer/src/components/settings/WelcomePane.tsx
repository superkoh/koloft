import type { JSX } from 'react'
import {
  LuBell,
  LuClock,
  LuFolder,
  LuGitBranchPlus,
  LuGlobe,
  LuNotebookPen,
  LuPanelRight,
  LuUsers
} from 'react-icons/lu'
import { useSettingsUpdate } from './useSettingsUpdate'

const CARDS: { Icon: typeof LuFolder; title: string; body: string; where: string }[] = [
  {
    Icon: LuFolder,
    title: 'Claude and Codex sessions',
    body: 'Pin a folder, start with your default CLI or choose another, or restore a session from history. Codex runs locally.',
    where: '⇧⌘O · sidebar'
  },
  {
    Icon: LuGitBranchPlus,
    title: 'Worktree sessions',
    body: 'Run Claude and Codex sessions in separate worktrees so they do not share working files.',
    where: '⇧⌘N'
  },
  {
    Icon: LuPanelRight,
    title: 'Workbench per session',
    body: 'Changed files with diffs, a file browser, a real browser, a shell.',
    where: '⇧⌘B · ⌃`'
  },
  {
    Icon: LuGlobe,
    title: 'Claude drives your browser',
    body: "Playwright tools use Koloft's tabs, with your logins. One switch turns it off.",
    where: 'Settings ▸ Extensions'
  },
  {
    Icon: LuUsers,
    title: 'Several accounts, one pool',
    body: 'Each session starts on the account with the most room left.',
    where: 'Settings ▸ Accounts'
  },
  {
    Icon: LuBell,
    title: 'Lights and notifications',
    body: "A light per running session: working, needs your OK, turn done. Pings when you're away.",
    where: 'Settings ▸ Notifications'
  },
  {
    Icon: LuClock,
    title: 'Scheduled jobs',
    body: 'Run a Claude or Codex task on a timer, in its own worktree when the folder is a git repo, with a run history.',
    where: 'workspace menu ▸ Scheduled jobs…'
  },
  {
    Icon: LuNotebookPen,
    title: 'A note per workspace',
    body: 'Plain text that stays with the folder, under its sessions.',
    where: '⌥⌘N'
  }
]

const DIFFS: [string, string, string][] = [
  ['Real Claude Code and Codex terminals', 'yes', 'yes'],
  ['Session list and history per folder', 'no', 'yes'],
  ['Working / needs your OK / done, at a glance', 'no', 'for sessions Koloft started'],
  ['Files changed, with diff, beside the chat', 'git diff by hand', 'yes'],
  ['Several accounts, auto-balanced', 'no', 'yes'],
  ["Claude drives a browser you're logged into", 'no', 'yes, Playwright tools'],
  ['Keep using a plain terminal any time', 'yes', 'yes']
]

export function WelcomePane(): JSX.Element {
  const update = useSettingsUpdate()

  return (
    <>
      <div className="set-ph">
        <h3>Welcome</h3>
        <p>What Koloft can do, and how it differs from a plain terminal.</p>
      </div>

      <h4 className="set-grp">What Koloft does</h4>
      <div className="wp-cards">
        {CARDS.map((c) => (
          <div className="wp-card" key={c.title}>
            <c.Icon size={15} className="wp-ico" />
            <div className="wp-body">
              <b>{c.title}</b>
              <small>{c.body}</small>
              <span className="wp-where">{c.where}</span>
            </div>
          </div>
        ))}
      </div>

      <h4 className="set-grp">How it differs</h4>
      <table className="wp-diff">
        <thead>
          <tr>
            <th />
            <th>Plain terminal</th>
            <th>Koloft</th>
          </tr>
        </thead>
        <tbody>
          {DIFFS.map(([what, terminal, koloft]) => (
            <tr key={what}>
              <th scope="row">{what}</th>
              <td>{terminal}</td>
              <td>{koloft}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="set-row">
        <div>
          <button className="mini" onClick={() => update({ onboardingSeen: false })}>
            Show welcome again
          </button>
          <div className="field-hint">Shows the next time no workspace is pinned.</div>
        </div>
        <button className="mini" onClick={() => update({ hintsSeen: [], hintsOff: false })}>
          Reset tips
        </button>
      </div>
    </>
  )
}

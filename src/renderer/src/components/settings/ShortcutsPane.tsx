import type { JSX } from 'react'

interface Shortcut {
  keys: string[]
  name: string
  uses: { where?: string; what: string }[]
}

const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: 'Sessions & workspaces',
    items: [
      {
        keys: ['⌘N'],
        name: 'New session',
        uses: [
          { what: 'Starts a session in your workspace with the default method.' },
          {
            where: 'Several workspaces',
            what: 'Asks which one. Enter uses the default method, ⇧⏎ the other one.'
          },
          { where: 'No workspace yet', what: 'Shows a notice instead.' }
        ]
      },
      {
        keys: ['⇧⌘N'],
        name: 'New worktree session',
        uses: [
          { what: 'Same as ⌘N, but in a fresh git worktree.' },
          { where: 'No git workspace', what: 'Shows a notice instead.' }
        ]
      },
      {
        keys: ['⇧⌘O'],
        name: 'Add workspace',
        uses: [{ what: 'Pins a folder; its sessions show in the sidebar.' }]
      },
      {
        keys: ['⇧⌘R'],
        name: 'Restart session',
        uses: [{ what: 'Kills the active session and resumes it in place.' }]
      },
      {
        keys: ['⌘W'],
        name: 'Close',
        uses: [
          {
            where: 'Conversation',
            what: 'Closes the session tab. Asks first while the session is working or waiting on a permission, or when a file is unsaved.'
          },
          { where: 'Workbench', what: 'Closes the active panel tab. The Files tab stays.' },
          { where: 'Note', what: 'Nothing.' }
        ]
      },
      {
        keys: ['⇧⌘W'],
        name: 'Close window',
        uses: [{ what: 'Sessions keep running; reopen the window from the Dock.' }]
      },
      {
        keys: ['⌥⌘N'],
        name: 'Note',
        uses: [
          { what: "Puts the caret in the workspace's note, unfolding it first." },
          { where: 'Note', what: 'Sends the caret back to where it was.' },
          { where: 'No workspace', what: 'Nothing.' }
        ]
      }
    ]
  },
  {
    title: 'Workbench panel (Claude sessions)',
    items: [
      {
        keys: ['⇧⌘B'],
        name: 'Toggle Workbench',
        uses: [
          { what: 'Shows or hides the panel, and moves the caret with it.' },
          { where: 'Full width', what: 'Hides the panel in one step.' },
          { where: 'Codex session', what: 'Tells you Codex sessions have no Workbench yet.' },
          { where: 'No session', what: 'Nothing.' }
        ]
      },
      {
        keys: ['⌘⏎'],
        name: 'Focus mode',
        uses: [
          { where: 'Panel shown', what: 'Flips between side-by-side and full width.' },
          { where: 'Panel hidden', what: 'Nothing.' }
        ]
      },
      {
        keys: ['⌃`'],
        name: 'New terminal tab',
        uses: [
          { what: 'Opens a shell in the panel and puts the caret there.' },
          { where: 'Codex session', what: 'Tells you Codex sessions have no Workbench yet.' },
          { where: 'Session not running', what: 'Nothing.' }
        ]
      },
      {
        keys: ['⌘T'],
        name: 'New tab',
        uses: [
          { where: 'Workbench', what: 'Opens a tab of the same kind as the active one.' },
          { where: 'Files tab', what: 'Nothing.' },
          { where: 'Elsewhere', what: 'Nothing.' }
        ]
      },
      {
        keys: ['⌥⌘←', '⌥⌘→'],
        name: 'Previous / next tab',
        uses: [
          { where: 'Workbench', what: 'Cycles the panel tabs, wrapping at both ends.' },
          { where: 'Elsewhere', what: 'Nothing.' }
        ]
      },
      {
        keys: ['⇧⌘F'],
        name: 'Search files',
        uses: [
          { what: 'Opens the panel on the Files tab with the caret in search.' },
          { where: 'Search open', what: 'Closes search and clears it.' },
          { where: 'No session', what: 'Nothing.' }
        ]
      },
      {
        keys: ['⌘F'],
        name: 'Find',
        uses: [
          { where: 'Workbench', what: 'Finds in the active tab: file, file list or web page.' },
          { where: 'Terminal tab', what: 'Nothing.' },
          { where: 'Editing a file', what: 'Off.' },
          { where: 'Conversation', what: 'Goes to Claude.' }
        ]
      },
      {
        keys: ['⌘S'],
        name: 'Save',
        uses: [
          {
            where: 'Workbench',
            what: 'Saves the file being edited. Nothing when it is unchanged.'
          },
          { where: 'Note', what: 'Saves the note.' },
          { where: 'Conversation', what: 'Goes to Claude.' }
        ]
      },
      {
        keys: ['Esc'],
        name: 'Step back',
        uses: [
          {
            where: 'Workbench',
            what: 'Closes the first thing open, in this order: image zoom, find bar, menu, then full width back to side-by-side.'
          },
          { where: 'Terminal tab', what: 'Goes to the shell.' },
          { where: 'Conversation', what: 'Goes to Claude (interrupt).' },
          { where: 'Note', what: 'Sends the caret back to where it was.' },
          { where: 'Dialog', what: 'Closes it.' }
        ]
      }
    ]
  },
  {
    title: 'Web page (panel focused, web tab active)',
    items: [
      {
        keys: ['⌘L'],
        name: 'Address bar',
        uses: [
          { where: 'Web page', what: 'Puts the caret in the address bar.' },
          { where: 'Elsewhere', what: 'Nothing.' }
        ]
      },
      {
        keys: ['⌘[', '⌘]'],
        name: 'Back / forward',
        uses: [
          { where: 'Web page', what: 'Moves through the page history.' },
          { where: 'Elsewhere', what: 'Nothing.' }
        ]
      },
      {
        keys: ['⌘R'],
        name: 'Reload',
        uses: [
          { where: 'Web page', what: 'Reloads the page.' },
          { where: 'Elsewhere', what: 'Nothing. It never reloads Koloft itself.' }
        ]
      },
      {
        keys: ['⌘0', '⌘+', '⌘-'],
        name: 'Zoom',
        uses: [
          { where: 'Web page', what: 'Zooms the page.' },
          { where: 'Elsewhere', what: 'Zooms the whole Koloft window.' }
        ]
      },
      {
        keys: ['⌥⌘I'],
        name: 'Developer tools',
        uses: [
          { where: 'Web page', what: "Opens the page's developer tools." },
          { where: 'Elsewhere', what: "Opens Koloft's own." }
        ]
      }
    ]
  },
  {
    title: 'Conversation',
    items: [
      {
        keys: ['⇧⏎'],
        name: 'New line',
        uses: [{ what: "Adds a line in Claude's input box without sending." }]
      }
    ]
  },
  {
    title: 'App',
    items: [
      {
        keys: ['⌘,'],
        name: 'Settings',
        uses: [{ what: 'Opens Settings.' }]
      }
    ]
  }
]

export function ShortcutsPane(): JSX.Element {
  return (
    <>
      <div className="set-ph">
        <h3>Shortcuts</h3>
        <p>
          A key acts on the island that is lit: the conversation, the Workbench panel or the note.
          The same key can mean different things in each.
        </p>
      </div>

      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="set-grp">{g.title}</div>
          {g.items.map((s) => (
            <div className="set-row set-key-row" key={s.name}>
              <div className="set-keys">
                {s.keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </div>
              <div className="set-lab">
                <b>{s.name}</b>
                {s.uses.map((u, i) => (
                  <small key={i}>
                    {u.where && <b className="set-where">{u.where} · </b>}
                    {u.what}
                  </small>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

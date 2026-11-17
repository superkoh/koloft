import type { TextBlock } from '@core/plugin'

export const TEXT: readonly TextBlock[] = [
  {
    slot: 'koloft-skill-workbench',
    text: 'show a file, web page or git diff in the Workbench, read or add to the note, '
  },
  {
    slot: 'koloft-help-rule-open',
    text: `
2. Use "open" and "diff" only when the owner wants to look at something, or when you hand a result to the owner. Do not open every file you write.`
  },
  {
    slot: 'koloft-help-rule-note',
    text: `
4. Only use "note append" for things later sessions will really need.`
  },
  {
    slot: 'koloft-help-workbench',
    text: `

WORKBENCH AND NOTE

The Workbench is this session's side panel in Koloft. The note is one plain-text note that every session in this workspace shares.

{{koloft-help-command}}koloft open <file or web address>
    Show a file or a web page in this session's Workbench. In a session on another machine, localhost there means that machine (see WEB PAGES).{{koloft-help-open}}
    Example: koloft open docs/plan.md

koloft diff <file>
    Show the file's git changes (what changed since the last commit) in the Workbench.{{koloft-help-diff}}
    Example: koloft diff src/app.ts

koloft note
    Print the note.

koloft note append <text>
    Add text to the end of the note.
    Example: koloft note append "Run npm run rebuild after changing the Electron version."`
  },
  {
    slot: 'koloft-help-remote-web-tabs',
    text: `
In a web tab of a session on another machine, only localhost, 127.0.0.1 and [::1] mean the machine, not the owner's Mac (0.0.0.0 does not, nor a name set in the machine's own hosts file): a web server you start there opens at that address, and Koloft brings its port over the ssh connection. If nothing answers on that port, or the machine's ssh server does not allow port forwarding, the page does not open and the owner sees why. If the owner's Mac already uses that port, the page opens on another port number, and what the page still sends to the old port, its websocket too, fails: then start the server on a port the Mac does not use.`
  }
]

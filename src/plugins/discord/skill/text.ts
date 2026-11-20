import type { TextBlock } from '@core/plugin'

export const TEXT: readonly TextBlock[] = [
  {
    slot: 'koloft-help-open',
    text: `
    When the owner is on Discord (away from the Mac, or you are answering a Discord message) and this session has a room there, Koloft also sends a copy there: a web page as pictures, a Markdown file as text with the file, any other file as itself. The reply says what was sent, or why nothing was: then say it in words. A copy still on its way when the reply comes tells the owner there itself if it cannot be sent.
    Shown while the owner is at the Mac, it is sent there later, just before your question, if you ask in the same turn and the question goes to Discord. So to ask about a screenshot, open it first, then ask.`
  },
  {
    slot: 'koloft-help-diff',
    text: ' On Discord, as with koloft open, the changes go as a picture, with the whole diff as a file when it is long.'
  },
  { slot: 'koloft-help-session-title', text: ' and Discord' },
  {
    slot: 'koloft-help-passwords-away',
    text: ', and also on a card in Discord when the owner is away from the Mac or talks to you from Discord'
  },
  {
    slot: 'koloft-help-sudo-away',
    text: ' The owner may be on a phone: run the command with a long timeout (10 minutes) or in the background.'
  },
  {
    slot: 'koloft-help-secret-page-away',
    text: ', or from Discord, where Koloft fills it in and submits the form'
  },
  {
    slot: 'koloft-help-secret-url-away',
    text: '; or the owner finishes it on a phone and pastes the address it ended on, and Koloft opens that address on the machine this session runs on, which finishes the sign-in'
  },
  {
    slot: 'koloft-help-page-tap-away',
    text: '; away from the Mac, Koloft sends the owner a picture of that part of the page with a grid on it, the owner names squares, and Koloft taps them, for as many rounds as it takes'
  },
  {
    slot: 'koloft-help-chat',
    text: `

DISCORD

koloft discord setup
    Print the steps to set up Discord for the owner (a bot, a server and the butler's channel), which use the commands below. Follow them in a session with a Workbench browser on this computer.

koloft discord status
koloft discord token --from-page
koloft discord reload
koloft discord invite
koloft discord bind --new-channel
    The steps of koloft discord setup: show what is done, save the bot token from this session's Workbench page without showing it to you, reload that page, print the address that invites the bot to a server, and make the butler's channel.`
  }
]

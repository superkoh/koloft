import type { TextBlock } from '@core/plugin'

export const TEXT: readonly TextBlock[] = [
  {
    slot: 'koloft-help-open',
    text: `
    When the owner is on Discord (away from the Mac, or you are answering a Discord message) and this session has a room there, or you are the butler or a helper in its folder, Koloft also sends a copy there: a web page as pictures, a Markdown file as text with the file, any other file as itself. The reply says what was sent, or why nothing was: then say it in words. A copy still on its way when the reply comes tells the owner there itself if it cannot be sent.
    Shown while the owner is at the Mac, it is sent there later, just before your question, if you ask in the same turn and the question goes to Discord. So to ask about a screenshot, open it first, then ask.`
  },
  {
    slot: 'koloft-help-diff',
    text: ' On Discord, as with koloft open, the changes go as a picture, with the whole diff as a file when it is long.'
  },
  { slot: 'koloft-help-butler-reached', text: ' or through Discord' },
  { slot: 'koloft-help-session-title', text: ' and Discord' },
  {
    slot: 'koloft-help-command-output',
    text: "; for the butler on Discord, it posts that in the butler's Discord channel instead. Either way"
  },
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
    slot: 'koloft-help-discord',
    text: `

DISCORD

koloft discord send <file>... [-- "<text>"]
    Only for the butler: send files, pictures or screenshots to the Discord channel the owner talks to you in, with an optional line of text. You run in a folder of your own, so give a workspace file its full path. At most 20 MB per file. Use it when the owner wants to see a file or a screenshot; a path you only mention in your reply is not sent. While the owner is at the Mac, Discord stays quiet: this and koloft discord shot are refused unless you are answering a Discord message, and your replies are not posted there either; show the file with koloft open instead.
    Example: koloft discord send shot.png -- "The login page now."

koloft discord shot <file or web address> [-- "<text>"]
    Only for the butler: Koloft opens the page out of sight (an HTML file, a localhost page or any web page), takes a picture of the whole page and sends it to the same channel, with an optional line of text. A page taller than one picture comes as several, top to bottom.
    Example: koloft discord shot /Users/me/plan/page.html -- "The plan page."
    Example: koloft discord shot http://localhost:5173 -- "The app as it runs now."

koloft discord thread open <session>
    Only for the butler: give a session in a project's workspace a room of its own on Discord (a thread under your channel), so the owner talks to it there from the phone, and print the room's link. Its replies and questions show in the room while the owner is away from the Mac. A closed session is resumed first. Run it only when the owner asked for it; a helper in your own folder gets no room. Give the owner the link exactly as printed: Discord shows it as a link to the room.
    Example: koloft discord thread open fix-login

koloft discord setup
    Print the steps to set up Discord for the owner (a bot, a server and the butler's channel), which use the commands below. Follow them in a session with a Workbench browser on this computer; the butler starts one for it.

koloft discord status
koloft discord token --from-page
koloft discord reload
koloft discord invite
koloft discord bind --new-channel
    The steps of koloft discord setup: show what is done, save the bot token from this session's Workbench page without showing it to you, reload that page, print the address that invites the bot to a server, and make the butler's channel.`
  }
]

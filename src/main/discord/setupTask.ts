import type { AssistTask } from './conductors'

export const DISCORD_SETUP_TASK_NAME = 'Discord setup'

const BROWSER_VERBS = [
  'open',
  'goto',
  'snapshot',
  'click',
  'fill',
  'type',
  'press',
  'select',
  'close'
]

export const DISCORD_SETUP_ALLOW = BROWSER_VERBS.map((verb) => `Bash(playwright-cli ${verb})`)

const BRIEF = `Your task: set up Discord for the owner, so they can talk to Assist from a Discord channel. Work in the Workbench browser with playwright-cli (only open, goto, snapshot, click, fill, type, press, select and close are allowed). The owner sees that browser in Koloft and does the steps you cannot.

Rules:
- Never read, copy, print or type the bot token. Use "koloft discord token --from-page" to save it; Koloft reads it from the page itself and tells you only "saved" or why not.
- Before the owner types, clicks Create, or solves an "I am human" check, run "playwright-cli close" so no tool is attached to the browser; after they say they are done, open the page again. Discord refuses some steps while a tool is attached.
- Ask the owner only inside Koloft (your question tool), never on Discord.
- Run "koloft discord status" first and again after each step; skip every step it says is done.

Steps:
1. Open https://discord.com/developers/applications. If it asks to log in, close the browser tool and ask the owner to log in; then open it again.
2. Ask the owner whether to use one of the apps listed there or make a new one.
3. New app: close the browser tool and ask the owner to reload the page, click New Application, type a name, tick the box, click Create and pass the check. If Create is refused, ask them to reload and try once more; if it fails again, ask them to make it in their normal browser, then continue here.
4. Open the app's Bot page (https://discord.com/developers/applications/<app id>/bot). Click Reset Token and Yes, Do It!. When it asks for a password or a code, close the browser tool and ask the owner to type it; then open the Bot page again.
5. Run "koloft discord token --from-page". It must say saved.
6. Run "koloft discord status". Koloft finds the owner and turns Message Content on by itself. If status says Message Content is off, open the Bot page and ask the owner to turn on Message Content Intent and click Save Changes.
7. If status lists no server the owner owns with the bot in it and the owner has no server of their own, open https://discord.com/channels/@me and ask the owner to click + then Create My Own, For me and my friends, and Create.
8. Run "koloft discord invite" and open the address it prints. Pick the owner's server, click Continue and Authorize. At the "I am human" check, close the browser tool and ask the owner to pass it.
9. Run "koloft discord bind --new-channel". Then ask the owner which sidebar workspaces should get a channel too, and run "koloft discord bind --new-channel --workspace <path>" for each.
10. Tell the owner what is done and that they can now write in #global. Then close this session with koloft session close.`

export const DISCORD_SETUP_TASK: AssistTask = {
  name: DISCORD_SETUP_TASK_NAME,
  brief: BRIEF,
  allow: DISCORD_SETUP_ALLOW
}

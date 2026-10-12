import { PLAYWRIGHT_CLI_RULE } from '../conductorGate'
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

const DISCORD_SETUP_ALLOW = BROWSER_VERBS.map((verb) => `${PLAYWRIGHT_CLI_RULE}${verb})`)

const BRIEF = `Your task: set up Discord for the owner, so they can talk to Assist from a Discord channel. Work in the Workbench browser with playwright-cli (only ${BROWSER_VERBS.join(', ')} are allowed). The owner sees that browser in Koloft and does the steps you cannot.

Rules:
- Never read, copy, print or type the bot token. Use "koloft discord token --from-page" to save it; Koloft reads it from the page itself, then reloads the page so the token is gone, and tells you only "saved" or why not. It refuses while you are attached.
- "Detach" means run "playwright-cli close", so no tool is attached to the browser; "re-attach" means open the page again with playwright-cli. Detach before every step the owner does by hand (signing in, typing a name or a password, clicking Create, any "I am human" check). Then ask the owner inside Koloft whether they are done, and re-attach only after they say yes, except where a step below says to stay detached.
- You cannot reload while detached: run "koloft discord reload" and Koloft reloads the Discord page for you. Never ask the owner to reload.
- Ask the owner only inside Koloft (your question tool), never on Discord, and ask one question at a time: wait for the answer before the next, and skip any question that answer has already settled.
- Run "koloft discord status" first and again after each step; skip every step it says is done, and every scope it lists under Bindings.

Steps:
1. Open https://discord.com/developers/applications. If it asks to sign in, detach, ask the owner to sign in, and re-attach once they are done.
2. Do every click and every bit of typing yourself; the owner only signs in, types passwords or codes, clicks the one button named below, and passes "I am human" checks. If the page lists apps already, ask the owner once whether one of them is the bot to use, and whether they still have its token (then they paste it into Settings ▸ Discord ▸ Bot token and you go to step 6 once status says the token is saved). With no app listed, make a new one without asking.
3. New app: click New Application, type the name (the one the owner gave, or else Koloft; if an app on the list already has that name, add the next free number, as in Koloft 2), tick the terms box. Discord refuses Create while a tool is attached, so then detach and ask the owner to click Create and pass the check. If Create is refused anyway, run "koloft discord reload" and ask them once more; if that fails too, ask them to make it in their normal browser. Re-attach once they are done.
4. Open the app's Bot page (https://discord.com/developers/applications/<app id>/bot). Before you click Reset Token, tell the owner that a new token stops this bot wherever else it runs with the old one, and ask whether to go on. Then click Reset Token. Before the confirm button (Yes, Do It!), detach and ask the owner to click it and type a password or code if Discord asks. Stay detached from then on: the new token is on the page.
5. Once the owner says they are done, still detached, run "koloft discord token --from-page". It must say saved. Only then re-attach.
6. Run "koloft discord status". Koloft finds the owner and turns Message Content on by itself. If status says Message Content is off, open the Bot page and ask the owner to turn on Message Content Intent and click Save Changes.
7. If status lists no server the owner owns with the bot in it and the owner has no server of their own, open https://discord.com/channels/@me and click + then Create My Own, For me and my friends, name it, and Create; if an "I am human" check comes up, detach and ask the owner to pass it.
8. Run "koloft discord invite" and open the address it prints. If the page offers to continue in the Discord app, click the choice to continue in the browser. Ask the owner which of their servers the bot should join, pick exactly that one in the list, and before you click Authorize ask the owner to confirm the server name shown on the page; never pick a server the owner did not name. At the "I am human" check, detach and ask the owner to pass it.
9. Run "koloft discord bind --new-channel" unless status already lists Global. If it says the bot is not allowed to make channels yet, go back to step 8 to invite the bot again, then run it again. Then ask the owner which sidebar workspaces should get a channel too, with "None" as its own choice to pick, and run "koloft discord bind --new-channel --workspace <path>" for each one not bound yet.
10. Ask the owner to write a line in #global themselves (a message the bot or you post does not reach Assist), wait until they say Assist answered there, then tell them what is done and close this session with koloft session close.`

export const DISCORD_SETUP_TASK: AssistTask = {
  name: DISCORD_SETUP_TASK_NAME,
  brief: BRIEF,
  allow: DISCORD_SETUP_ALLOW
}

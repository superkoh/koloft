const BOT_PAGE = /^https:\/\/discord\.com\/developers\/applications\/\d+\/bot\/?(?:[?#].*)?$/
const DISCORD_PAGE = /^https:\/\/discord\.com\//

const TOKEN_ON_PAGE = String.raw`(() => {
  const found = document.body.innerText.match(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/)
  return found ? found[0] : ''
})()`

export interface GuestPage {
  url(): string
  run(script: string): Promise<unknown>
  reload(): Promise<void>
}

export const STILL_ATTACHED =
  'koloft: run "playwright-cli close" first. Koloft reads the token only while no tool is attached to the browser, so the token never shows in a snapshot.'
export const NO_BOT_PAGE =
  'No Discord Bot page is open in your Workbench browser. Open https://discord.com/developers/applications/<app>/bot there, click Reset Token, then run this again.'
export const NO_TOKEN_ON_PAGE =
  'The Bot page showed no token; Koloft reloaded it. Reset the token again (the owner clicks Yes, Do It! while you stay detached), then run this again. If it still fails, tell the owner Koloft cannot read the token from the page, and stop.'
export const NOT_SAVED =
  'Koloft could not save the token in the Keychain; it reloaded the page. Tell the owner the Keychain refused it, and stop.'
export const SAVED =
  'Saved the bot token. Koloft reloaded the page, so the token is no longer on it, and is connecting; run koloft discord status in a few seconds.'
export const NO_DISCORD_PAGE = 'No discord.com page is open in your Workbench browser.'
export const RELOADED = 'Reloaded the Discord page. You may open it with playwright-cli again.'

// PLATFORM§39
export async function saveTokenFromPage(
  pages: GuestPage[],
  attached: boolean,
  save: (token: string) => Promise<boolean>
): Promise<string> {
  if (attached) return STILL_ATTACHED
  const page = pages.find((p) => BOT_PAGE.test(p.url()))
  if (!page) return NO_BOT_PAGE
  const token = await page.run(TOKEN_ON_PAGE).catch(() => '')
  const said =
    typeof token !== 'string' || !token ? NO_TOKEN_ON_PAGE : (await save(token)) ? SAVED : NOT_SAVED
  await page.reload()
  return said
}

// PLATFORM§39
export async function reloadDiscordPage(pages: GuestPage[], attached: boolean): Promise<string> {
  if (attached) return STILL_ATTACHED
  const discord = pages.filter((p) => DISCORD_PAGE.test(p.url()))
  if (!discord.length) return NO_DISCORD_PAGE
  await Promise.all(discord.map((p) => p.reload()))
  return RELOADED
}

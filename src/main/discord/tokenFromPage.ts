const BOT_PAGE = /^https:\/\/discord\.com\/developers\/applications\/\d+\/bot\/?(?:[?#].*)?$/

const TOKEN_ON_PAGE = String.raw`(() => {
  const found = document.body.innerText.match(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/)
  return found ? found[0] : ''
})()`

export interface GuestPage {
  url(): string
  run(script: string): Promise<unknown>
}

export const NO_BOT_PAGE =
  'No Discord Bot page is open in your Workbench browser. Open https://discord.com/developers/applications/<app>/bot there, click Reset Token, then run this again.'
export const NO_TOKEN_ON_PAGE =
  'The Bot page shows no token. Click Reset Token (and Yes, Do It!) first, then run this again. If it still fails, the owner can paste the token in Settings ▸ Discord.'

export function isBotPage(url: string): boolean {
  return BOT_PAGE.test(url)
}

// PLATFORM§39
export async function tokenFromPage(
  pages: GuestPage[]
): Promise<{ token: string } | { error: string }> {
  const page = pages.find((p) => isBotPage(p.url()))
  if (!page) return { error: NO_BOT_PAGE }
  const token = await page.run(TOKEN_ON_PAGE).catch(() => '')
  return typeof token === 'string' && token ? { token } : { error: NO_TOKEN_ON_PAGE }
}

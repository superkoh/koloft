import type { TextBlock } from '@core/plugin'
import type { BackendId } from '@shared/types'
import {
  SESSION_BACKENDS,
  capabilitiesFor,
  kindsOf,
  productList,
  whenAny
} from '@shared/sessionBackend'

export const reachesTheWorkbenchBrowserOverSsh = (b: BackendId): boolean =>
  capabilitiesFor(b, 'ssh').browserControl === true
const PRODUCTS_REACHING_THE_WORKBENCH_BROWSER_OVER_SSH = productList(
  SESSION_BACKENDS.filter(reachesTheWorkbenchBrowserOverSsh),
  'or'
)
const OTHER_SESSIONS_CANNOT_REACH_IT_OVER_SSH = SESSION_BACKENDS.every(
  reachesTheWorkbenchBrowserOverSsh
)
  ? ''
  : ' Other sessions on another machine cannot reach the Workbench browser.'

export const TEXT: readonly TextBlock[] = [
  {
    slot: 'koloft-skill-web-pages',
    text: ' Also says how to click, type in and read the Workbench web pages with the playwright-cli command.'
  },
  { slot: 'koloft-skill-web-pages-command', text: ' or playwright-cli' },
  {
    slot: 'koloft-help-web-pages',
    text: `

WEB PAGES

To use the web pages in this session's Workbench, drive them with the playwright-cli command (a tool that controls a browser), which Koloft puts in ${kindsOf(SESSION_BACKENDS, 'and')} sessions on this computer. Run it by that name, not through npx or a full path, so you get Koloft's copy. "playwright-cli --help" lists its commands.
    Example: playwright-cli open https://example.com
    Example: playwright-cli snapshot
When the owner allows browser control, it drives the Workbench browser, whose address is in $KOLOFT_BROWSER_CDP; otherwise it starts a hidden browser of its own. In the Workbench it works in tabs of its own, which the owner sees marked as driven by you; it cannot see the tabs the owner opened, so open the address you need yourself. The Workbench browser takes one tool at a time: if Playwright MCP tools also drive it in this session, the one that comes second is refused with "this endpoint already has a client", so use one of the two ("playwright-cli close" lets go of it).${whenAny(PRODUCTS_REACHING_THE_WORKBENCH_BROWSER_OVER_SSH, (products) => ` A ${products} session on another machine (over SSH) reaches the Workbench browser too, through Koloft's ssh connection: there playwright-cli reads the address each time it runs, so $KOLOFT_BROWSER_CDP is not set there and Playwright MCP tools cannot use the Workbench browser, and after Koloft restarts or the connection comes back, run "playwright-cli close" and open the page again. From there it cannot open file:// pages, upload files, or open a server of the owner's Mac (the Mac's own network addresses, its other 127.x addresses, names ending in .localhost, or a name that points at the Mac).`)}${OTHER_SESSIONS_CANNOT_REACH_IT_OVER_SSH}`
  }
]

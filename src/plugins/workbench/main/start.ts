import type { MainIpc } from '@core/ipc'
import type { PluginStart } from '@core/pluginStart'
import { pushOpenFile, registerChannels } from './channels'
import { PageDialogs } from './pageDialogs'
import { PageDownloads } from './pageDownloads'
import { PageRouting, type PageRoutingDeps } from './pageRouting'
import { registerPageChannels, type PageChannelDeps } from './pageChannels'
import { pagesInUse, type PagesInUseDeps } from './pagesInUse'
import { PageTools, type PageToolsDeps } from './pageTools'
import { pickDocsOfEachTurn } from './sessionHooks'
import { SitePermissions, type SitePermissionsDeps } from './sitePermissions'
import { WebPages, type WebPagesDeps } from './webPages'
import { registerWorkbenchCommands } from './workbenchVerbs'

export interface WorkbenchPagesDeps {
  webPages: WebPagesDeps
  sitePermissions: Pick<SitePermissionsDeps, 'openExternally' | 'allowFullscreen'>
  pageRouting: Omit<PageRoutingDeps, 'push' | 'pages' | 'openFile'>
  pageTools: Omit<PageToolsDeps, 'push' | 'pages'>
  pagesInUse: Pick<PagesInUseDeps, 'heldElsewhere' | 'ownerDriven' | 'drivenFromAnotherMachine'>
}

export interface WorkbenchStartDeps {
  pages: WorkbenchPagesDeps
  commands: Parameters<typeof registerWorkbenchCommands>[1]
  readerDocs: Parameters<typeof pickDocsOfEachTurn>[1]
  pageChannels: Pick<PageChannelDeps, 'openExternal'>
  channels: Parameters<typeof registerChannels>[1]
}

function buildPages(ipc: MainIpc, d: WorkbenchPagesDeps) {
  const sitePermissions = new SitePermissions({
    push: ipc.push,
    isOverlay: (page) => webPages.isOverlay(page),
    takeGesture: (page) => webPages.takeGesture(page),
    ...d.sitePermissions
  })
  const pageDialogs = new PageDialogs({
    push: ipc.push,
    isOverlay: (page) => webPages.isOverlay(page)
  })
  const webPages = new WebPages(d.webPages)
  webPages.start()
  const pageRouting = new PageRouting({
    push: ipc.push,
    pages: webPages,
    openFile: pushOpenFile(ipc),
    ...d.pageRouting
  })
  const pageTools = new PageTools({ push: ipc.push, pages: webPages, ...d.pageTools })
  const inUse: PagesInUseDeps = {
    pages: webPages,
    held: () => [...pageDownloads.pagesDownloading(), ...sitePermissions.pagesHeld()],
    modalPage: () => pageDialogs.modalPage(),
    signInWindowOpeners: () => pageRouting.signInWindowOpeners(),
    ...d.pagesInUse
  }
  const pageDownloads = new PageDownloads({ push: ipc.push })
  return {
    webPages,
    sitePermissions,
    pageDialogs,
    pageDownloads,
    pageRouting,
    pageTools,
    pagesInUse: () => pagesInUse(inUse)
  }
}

export type WorkbenchPages = ReturnType<typeof buildPages>

export const start: PluginStart<WorkbenchStartDeps, WorkbenchPages> = (
  { commands, moments, ipc },
  d
) => {
  const pages = buildPages(ipc, d.pages)
  registerWorkbenchCommands(commands, d.commands)
  pickDocsOfEachTurn(moments, d.readerDocs)
  registerPageChannels(ipc, { ...d.pageChannels, ...pages })
  registerChannels(ipc, d.channels)
  return pages
}

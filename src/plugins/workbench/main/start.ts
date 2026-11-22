import type { MainIpc } from '@core/ipc'
import type { BuildLater, PluginStart } from '@core/pluginStart'
import { setupBrowserPartition, type BrowserPartitionDeps } from './browserPartition'
import { pushOpenFile, registerChannels } from './channels'
import { onExtensionsChanged, setupExtensions, type ExtensionHost } from './extensionManager'
import { compositionDone } from './hostComposition'
import { PageDialogs } from './pageDialogs'
import { PageDownloads } from './pageDownloads'
import { PageRouting, type PageRoutingDeps } from './pageRouting'
import { pagePushes, registerPageChannels } from './pageChannels'
import { pagesInUse, type PagesInUseDeps } from './pagesInUse'
import { PageTools, type PageToolsDeps } from './pageTools'
import { ReaderDocs, type ReaderDocsDeps } from './readerDocs'
import { pickDocsOfEachTurn } from './sessionHooks'
import { SitePermissions, type SitePermissionsDeps } from './sitePermissions'
import { WebPages, type WebPagesDeps } from './webPages'
import { registerWorkbenchCommands } from './workbenchVerbs'

type BuiltHere =
  | 'push'
  | 'pages'
  | 'openFile'
  | 'isOverlay'
  | 'takeGesture'
  | 'held'
  | 'modalPage'
  | 'signInWindowOpeners'

export type WorkbenchPagesDeps = Omit<
  WebPagesDeps & SitePermissionsDeps & PageRoutingDeps & PageToolsDeps & PagesInUseDeps,
  BuiltHere
>

export interface WorkbenchStartDeps {
  pages: WorkbenchPagesDeps
  commands: Parameters<typeof registerWorkbenchCommands>[1]
  readerDocs: ReaderDocsDeps
  channels: Parameters<typeof registerChannels>[1]
}

function buildPages(ipc: MainIpc, d: WorkbenchPagesDeps) {
  const push = ipc.push
  const webPages = new WebPages(d)
  webPages.start()
  const sitePermissions = new SitePermissions({
    ...d,
    push,
    isOverlay: (page) => webPages.isOverlay(page),
    takeGesture: (page) => webPages.takeGesture(page)
  })
  const pageDialogs = new PageDialogs({ push, isOverlay: (page) => webPages.isOverlay(page) })
  const pushOpenRequest = pushOpenFile(ipc)
  const pageRouting = new PageRouting({ ...d, push, pages: webPages, openFile: pushOpenRequest })
  const pageTools = new PageTools({ ...d, push, pages: webPages })
  const pageDownloads = new PageDownloads({ push })
  const inUse: PagesInUseDeps = {
    ...d,
    pages: webPages,
    held: () => [...pageDownloads.pagesDownloading(), ...sitePermissions.pagesHeld()],
    modalPage: () => pageDialogs.modalPage(),
    signInWindowOpeners: () => pageRouting.signInWindowOpeners()
  }
  return {
    webPages,
    sitePermissions,
    pageDialogs,
    pageDownloads,
    pageRouting,
    pageTools,
    pagesInUse: () => pagesInUse(inUse),
    pushOpenRequest,
    pushToPages: pagePushes(ipc)
  }
}

export const start: PluginStart<
  WorkbenchStartDeps,
  ReturnType<typeof buildPages> & {
    readerDocs: ReaderDocs
    setUpBrowserPartition: BuildLater<Omit<BrowserPartitionDeps, 'permissions' | 'downloads'>>
    setUpExtensions: BuildLater<Pick<ExtensionHost, 'window'>>
    compositionDone: typeof compositionDone
  }
> = ({ commands, moments, ipc }, d) => {
  const pages = buildPages(ipc, d.pages)
  const readerDocs = new ReaderDocs(d.readerDocs)
  registerWorkbenchCommands(commands, d.commands)
  pickDocsOfEachTurn(moments, readerDocs)
  registerPageChannels(ipc, { ...pages, openExternal: d.pages.openExternally })
  registerChannels(ipc, d.channels)
  return {
    ...pages,
    readerDocs,
    setUpBrowserPartition: (later) =>
      setupBrowserPartition({
        ...later,
        permissions: pages.sitePermissions,
        downloads: pages.pageDownloads
      }),
    setUpExtensions: ({ window }) => {
      // PLATFORM§15
      setupExtensions({
        window,
        openTab: (url) => pages.pageRouting.openExtensionTab(url),
        ask: (request) => pages.pushToPages.extensionAsks(request)
      })
      onExtensionsChanged(() => pages.pushToPages.extensionsChanged())
    },
    compositionDone
  }
}

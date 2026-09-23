const noWindowThrowsWithoutBrowserNamespace = browser.windows.WINDOW_ID_NONE

if (noWindowThrowsWithoutBrowserNamespace === undefined)
  throw new Error('browser.windows.WINDOW_ID_NONE missing')

chrome.action.setBadgeText({ text: 'ok' })

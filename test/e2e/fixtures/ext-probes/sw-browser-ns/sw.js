// Top-level, unguarded on purpose: a missing `browser` namespace must take the worker
// down before it can badge itself.
const noWindow = browser.windows.WINDOW_ID_NONE

if (noWindow === undefined) throw new Error('browser.windows.WINDOW_ID_NONE missing')

chrome.action.setBadgeText({ text: 'ok' })

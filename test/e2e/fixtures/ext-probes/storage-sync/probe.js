// BB-C16 (per §06): in a content script, chrome.storage.sync must
// fail SOFT — the call errors via lastError instead of throwing, the script lives on,
// and chrome.storage.local still round-trips.
const VALUE = 'koloft-bb-local'

// document_start can run before <html> exists — retry until there is a root to mark.
function whenRoot(fn) {
  const root = document.documentElement
  if (!root) {
    requestAnimationFrame(() => whenRoot(fn))
    return
  }
  fn(root)
}

chrome.storage.sync.set({ bb: 'x' }, () => {
  const sync = chrome.runtime.lastError ? 'softfail' : 'ok'
  whenRoot((root) => root.setAttribute('data-koloft-bb-sync', sync))
  chrome.storage.local.set({ bbLocal: VALUE }, () => {
    if (chrome.runtime.lastError) return
    chrome.storage.local.get('bbLocal', (got) => {
      if (!chrome.runtime.lastError && got && got.bbLocal === VALUE) {
        whenRoot((root) => root.setAttribute('data-koloft-bb-sync-local', 'ok'))
      }
      whenRoot((root) => root.setAttribute('data-koloft-bb-sync-alive', '1'))
    })
  })
})

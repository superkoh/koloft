const VALUE = 'koloft-bb-local'

// PLATFORM§15
function whenRootExists(fn) {
  const root = document.documentElement
  if (!root) {
    requestAnimationFrame(() => whenRootExists(fn))
    return
  }
  fn(root)
}

chrome.storage.sync.set({ bb: 'x' }, () => {
  const sync = chrome.runtime.lastError ? 'softfail' : 'ok'
  whenRootExists((root) => root.setAttribute('data-koloft-bb-sync', sync))
  chrome.storage.local.set({ bbLocal: VALUE }, () => {
    if (chrome.runtime.lastError) return
    chrome.storage.local.get('bbLocal', (got) => {
      if (!chrome.runtime.lastError && got && got.bbLocal === VALUE) {
        whenRootExists((root) => root.setAttribute('data-koloft-bb-sync-local', 'ok'))
      }
      whenRootExists((root) => root.setAttribute('data-koloft-bb-sync-alive', '1'))
    })
  })
})

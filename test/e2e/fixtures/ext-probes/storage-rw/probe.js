const VALUE = 'koloft-bb-value'

// document_start can run before <html> exists — retry until there is a root to mark.
function whenRoot(fn) {
  const root = document.documentElement
  if (!root) {
    requestAnimationFrame(() => whenRoot(fn))
    return
  }
  fn(root)
}

if (location.hash === '#write') {
  chrome.storage.local.set({ bb: VALUE }, () => {
    whenRoot((root) => root.setAttribute('data-koloft-bb-storage-write', 'done'))
  })
} else if (location.hash === '#read') {
  chrome.storage.local.get('bb', (got) => {
    whenRoot((root) => root.setAttribute('data-koloft-bb-storage', String((got || {}).bb || '')))
  })
}

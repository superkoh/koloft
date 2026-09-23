const VALUE = 'koloft-bb-value'

// PLATFORM§15
function whenRootExists(fn) {
  const root = document.documentElement
  if (!root) {
    requestAnimationFrame(() => whenRootExists(fn))
    return
  }
  fn(root)
}

if (location.hash === '#write') {
  chrome.storage.local.set({ bb: VALUE }, () => {
    whenRootExists((root) => root.setAttribute('data-koloft-bb-storage-write', 'done'))
  })
} else if (location.hash === '#read') {
  chrome.storage.local.get('bb', (got) => {
    whenRootExists((root) =>
      root.setAttribute('data-koloft-bb-storage', String((got || {}).bb || ''))
    )
  })
}

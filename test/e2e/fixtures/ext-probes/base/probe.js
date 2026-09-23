// PLATFORM§15
function markOnceRootExists() {
  const root = document.documentElement
  if (!root) {
    requestAnimationFrame(markOnceRootExists)
    return
  }
  root.setAttribute('data-koloft-bb-probe', chrome.runtime.id)
}

markOnceRootExists()

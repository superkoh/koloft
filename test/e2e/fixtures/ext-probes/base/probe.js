// document_start can run before <html> exists — retry until there is a root to mark.
function mark() {
  const root = document.documentElement
  if (!root) {
    requestAnimationFrame(mark)
    return
  }
  root.setAttribute('data-koloft-bb-probe', chrome.runtime.id)
}

mark()

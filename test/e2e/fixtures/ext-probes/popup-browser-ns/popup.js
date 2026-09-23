// Top-level, unguarded on purpose: a missing `browser` namespace must take the whole
// popup script down, so the success marker below is never written.
const runtimeId = browser.runtime.id

document.documentElement.setAttribute('data-koloft-bb-popup', 'ok')
const ok = document.createElement('div')
ok.id = 'koloft-bb-popup-ok'
ok.textContent = runtimeId
document.body.appendChild(ok)

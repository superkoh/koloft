const runtimeIdThrowsWithoutBrowserNamespace = browser.runtime.id

document.documentElement.setAttribute('data-koloft-bb-popup', 'ok')
const ok = document.createElement('div')
ok.id = 'koloft-bb-popup-ok'
ok.textContent = runtimeIdThrowsWithoutBrowserNamespace
document.body.appendChild(ok)

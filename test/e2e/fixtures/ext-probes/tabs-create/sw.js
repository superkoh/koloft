importScripts('config.js')

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: self.KOLOFT_BB_CONFIG.target })
})

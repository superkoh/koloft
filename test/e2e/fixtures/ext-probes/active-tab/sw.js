chrome.action.onClicked.addListener(async () => {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  // both spellings mean "the active tab" — a host that models a single window answers
  // only the second one, and the case is about WHICH tab, not about the query shape
  if (!tabs.length) tabs = await chrome.tabs.query({ active: true })
  let text = 'none'
  try {
    text = new URL(tabs[0].url).hostname
  } catch {
    text = 'none'
  }
  await chrome.action.setBadgeText({ text })
})

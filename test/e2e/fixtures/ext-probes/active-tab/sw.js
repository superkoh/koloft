chrome.action.onClicked.addListener(async () => {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const singleWindowHostAnswersOnlyThisShape = { active: true }
  if (!tabs.length) tabs = await chrome.tabs.query(singleWindowHostAnswersOnlyThisShape)
  let text = 'none'
  try {
    text = new URL(tabs[0].url).hostname
  } catch {
    text = 'none'
  }
  await chrome.action.setBadgeText({ text })
})

chrome.action.onClicked.addListener(async () => {
  let granted = false
  try {
    granted = await chrome.permissions.request({ permissions: ['clipboardRead'] })
  } catch {
    granted = false
  }
  await chrome.action.setBadgeText({ text: granted ? 'y' : 'n' })
})

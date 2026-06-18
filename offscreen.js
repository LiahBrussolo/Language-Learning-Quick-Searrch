chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'READ_CLIPBOARD') return false;
  navigator.clipboard.readText()
    .then(text => sendResponse({ text: text.trim() }))
    .catch(() => sendResponse({ text: '' }));
  return true; // keep channel open for async response
});

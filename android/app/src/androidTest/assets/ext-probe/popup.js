// The popup exercises the page-context shim: tabs, storage, messaging and scripting.
var popupReport = { origin: location.origin, steps: {}, errors: [] }
window.__popupReport = popupReport
document.getElementById('origin').textContent = location.origin

function show(id, text) {
  document.getElementById(id).textContent = text
}
var pending = 4
function settle() {
  if (--pending === 0) {
    document.title = 'probe-popup-ready'
    document.body.setAttribute('data-ready', '1')
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  var tab = tabs && tabs[0]
  popupReport.steps.activeTab = tab ? { id: tab.id, url: tab.url, title: tab.title } : null
  show('tab', tab ? tab.id + ' ' + tab.url : 'none')
  settle()

  chrome.runtime.sendMessage({ t: 'exec', tabId: tab ? tab.id : -1 }, function (result) {
    popupReport.steps.executeScript = chrome.runtime.lastError
      ? 'error: ' + chrome.runtime.lastError.message
      : result
    show('exec', String(popupReport.steps.executeScript))
    settle()
  })
})

chrome.storage.local.get(['probeKey'], function (items) {
  popupReport.steps.storage = items ? items.probeKey || null : null
  show('storage', JSON.stringify(items))
  settle()
})

chrome.runtime.sendMessage({ t: 'bgReport' }, function (report) {
  popupReport.steps.background = report || null
  show(
    'bg',
    report
      ? 'installed=' + report.installed + ' alarm=' + report.alarm + ' tabs=' + report.tabs
      : 'no reply'
  )
  settle()
})

// The options page in the sheet: a form bound to chrome.storage.local, as extensions do it.
var optionsReport = { origin: location.origin, steps: {}, errors: [] }
window.__optionsReport = optionsReport
document.getElementById('origin').textContent = location.origin

var greeting = document.getElementById('greeting')
var dark = document.getElementById('dark')
var status = document.getElementById('status')

chrome.storage.local.get(['greeting', 'dark'], function (items) {
  items = items || {}
  optionsReport.steps.loaded = items
  greeting.value = items.greeting || ''
  dark.checked = items.dark === true
  status.textContent = 'Loaded from storage.local'
  document.title = 'probe-options-ready'
  document.body.setAttribute('data-ready', '1')
})

function save() {
  var values = { greeting: greeting.value, dark: dark.checked }
  chrome.storage.local.set(values, function () {
    optionsReport.steps.saved = chrome.runtime.lastError ? 'error: ' + chrome.runtime.lastError.message : values
    status.textContent = 'Saved ' + JSON.stringify(values)
    document.body.setAttribute('data-saved', '1')
  })
}
greeting.addEventListener('input', save)
dark.addEventListener('change', save)

// Extension pages have the full API: report the manifest and the tab list for the driver.
chrome.tabs.query({}, function (tabs) {
  optionsReport.steps.tabs = tabs ? tabs.length : -1
})
optionsReport.steps.manifestName = chrome.runtime.getManifest().name

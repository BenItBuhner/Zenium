// Runs at document_start. Records what the world looks like before the page's own scripts run,
// and plants the markers the page and the document_idle group look for.
var probeVar = 1
function probeFn() {
  return 'probe'
}
window.probeExpando = 'from-extension'
// Sloppy-mode implicit global: Chrome's isolated world keeps it private, the main world would not.
implicitLeak = 'sloppy'

var startReport = {
  readyState: document.readyState,
  documentElement: !!document.documentElement,
  head: !!document.head,
  body: !!document.body,
  nodes: document.documentElement ? document.documentElement.getElementsByTagName('*').length : 0,
  pageScriptsRan: typeof window.__page !== 'undefined' || typeof __page !== 'undefined',
  chromeType: typeof chrome,
  browserType: typeof browser,
  runtimeId: chrome && chrome.runtime ? chrome.runtime.id : null,
  getURL: chrome && chrome.runtime ? chrome.runtime.getURL('data.json') : null,
  manifestName: chrome && chrome.runtime ? chrome.runtime.getManifest().name : null,
  i18n: chrome && chrome.i18n ? chrome.i18n.getMessage('hello', ['probe']) : null,
  uiLanguage: chrome && chrome.i18n ? chrome.i18n.getUILanguage() : null,
  windowIsGlobal: window === globalThis && self === window,
  currentScript: document.currentScript === null ? 'null' : typeof document.currentScript,
  thisIsWindow: this === window
}
document.__zenProbeStart = startReport

// Storage change events reach every context of the extension, this one included.
var storageEvents = []
if (chrome && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(function (changes, area) {
    storageEvents.push(area + ':' + Object.keys(changes).join(','))
  })
}
document.__zenProbeStorageEvents = storageEvents

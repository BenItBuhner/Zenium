// MV3 service worker of the probe, run as a page on the extension origin by the emulation layer.
var report = {
  globals: {
    self: typeof self,
    window: typeof window,
    document: typeof document,
    ServiceWorkerGlobalScope: typeof ServiceWorkerGlobalScope,
    importScripts: typeof importScripts
  },
  manifestName: chrome.runtime.getManifest().name,
  installed: null,
  startup: false,
  alarm: null,
  storageChanges: [],
  navigation: [],
  tabUpdates: 0,
  tabs: null,
  dynamicRules: null,
  execResult: null,
  libLoaded: false,
  indexedDB: null,
  errors: []
}

try {
  var open = indexedDB.open('probe-db', 1)
  open.onupgradeneeded = function () {
    open.result.createObjectStore('kv')
  }
  open.onsuccess = function () {
    report.indexedDB = 'ok'
    open.result.close()
  }
  open.onerror = function () {
    report.indexedDB = 'error: ' + (open.error && open.error.message)
  }
} catch (e) {
  report.indexedDB = 'exception: ' + e.message
}

self.addEventListener('error', function (e) {
  report.errors.push('error: ' + (e.message || String(e)))
})
self.addEventListener('unhandledrejection', function (e) {
  report.errors.push(
    'unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))
  )
})

try {
  importScripts('lib.js')
  report.libLoaded = self.probeLibLoaded === true
} catch (e) {
  report.errors.push('importScripts: ' + e.message)
}

chrome.runtime.onInstalled.addListener(function (details) {
  report.installed = details.reason
})
chrome.runtime.onStartup.addListener(function () {
  report.startup = true
})

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.t === 'ping') {
    sendResponse({
      pong: true,
      tab: sender.tab ? sender.tab.id : null,
      url: sender.url || null,
      frameId: sender.frameId
    })
    return false
  }
  if (message && message.t === 'bgReport') {
    sendResponse(report)
    return false
  }
  if (message && message.t === 'exec') {
    chrome.scripting
      .executeScript({
        target: { tabId: message.tabId },
        func: function () {
          return document.title
        }
      })
      .then(function (results) {
        report.execResult = results && results[0] ? results[0].result : null
        sendResponse(report.execResult)
      })
      .catch(function (e) {
        report.errors.push('executeScript: ' + e.message)
        sendResponse(null)
      })
    return true
  }
  return false
})

chrome.runtime.onConnect.addListener(function (port) {
  port.onMessage.addListener(function (m) {
    port.postMessage({
      echo: m,
      name: port.name,
      fromTab: port.sender && port.sender.tab ? port.sender.tab.id : null
    })
  })
})

chrome.storage.onChanged.addListener(function (changes, area) {
  report.storageChanges.push(area + ':' + Object.keys(changes).join(','))
})

chrome.alarms.onAlarm.addListener(function (alarm) {
  report.alarm = alarm.name
})
chrome.alarms.create('probe-alarm', { delayInMinutes: 0.02 })

chrome.webNavigation.onCommitted.addListener(function (details) {
  report.navigation.push(details.url)
})
chrome.tabs.onUpdated.addListener(function () {
  report.tabUpdates++
})

chrome.action.setBadgeText({ text: 'P' })
chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' })

chrome.tabs
  .query({})
  .then(function (tabs) {
    report.tabs = tabs.length
  })
  .catch(function (e) {
    report.errors.push('tabs.query: ' + e.message)
  })

chrome.declarativeNetRequest
  .updateDynamicRules({
    removeRuleIds: [1000],
    addRules: [
      {
        id: 1000,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: 'dyn=1', resourceTypes: ['image'] }
      }
    ]
  })
  .then(function () {
    return chrome.declarativeNetRequest.getDynamicRules()
  })
  .then(function (rules) {
    report.dynamicRules = rules.length
  })
  .catch(function (e) {
    report.errors.push('declarativeNetRequest: ' + e.message)
  })

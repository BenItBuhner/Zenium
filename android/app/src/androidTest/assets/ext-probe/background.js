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
  // W2-2: every webNavigation event with its details, in arrival order (bounded).
  webNavigation: [],
  tabUpdates: 0,
  tabs: null,
  dynamicRules: null,
  execResult: null,
  libLoaded: false,
  indexedDB: null,
  frames: [],
  // W2-2: contextMenus (created ids, clicks), notifications (created ids, events), cookies.onChanged.
  menuItems: null,
  menuClicks: [],
  notifications: [],
  notificationEvents: [],
  cookieChanges: [],
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
  if (message && message.t === 'frameHello') {
    // The frame script of frames.html's inner frame: where Chrome says it runs.
    report.frames.push({ frameId: sender.frameId, url: sender.url || message.url || null })
    sendResponse(true)
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

// --- W2-2 stages, driven from the demo through `window.__w22(name, args)` -----------------------
// Each stage settles `window.__w22Result` with a JSON string; the driver polls it.

function settleW22(value) {
  window.__w22Result = JSON.stringify(value === undefined ? null : value)
}
function failW22(where, e) {
  settleW22({ error: where + ': ' + (e && e.message ? e.message : String(e)) })
}

var w22 = {
  // A cross-origin fetch from the extension origin to a permitted host: the runner's plain
  // http.server sends no CORS headers, so only the Kotlin proxy lets the response through. The
  // POST shows a non-simple request (body ticket) reaching the server too: http.server answers
  // 501 to it, which is readable only when the proxy re-served it with CORS headers.
  cors: function (args) {
    var out = { url: args.url }
    return fetch(args.url, { cache: 'no-store', headers: { 'X-Probe': 'w22' } })
      .then(function (r) {
        out.status = r.status
        out.ok = r.ok
        out.allowOrigin = r.headers.get('access-control-allow-origin')
        out.contentType = r.headers.get('content-type')
        return r.text()
      })
      .then(function (text) {
        out.body = text.slice(0, 200)
        return fetch(args.url, { method: 'POST', body: 'probe=1', headers: { 'Content-Type': 'text/plain' } })
      })
      .then(
        function (r) {
          out.postStatus = r.status
        },
        function (e) {
          out.postError = String(e && e.message ? e.message : e)
        }
      )
      .then(function () {
        var xhr = new XMLHttpRequest()
        return new Promise(function (resolve) {
          xhr.open('GET', args.url + '&xhr=1')
          xhr.onload = function () {
            out.xhrStatus = xhr.status
            out.xhrBody = xhr.responseText.slice(0, 100)
            resolve()
          }
          xhr.onerror = function () {
            out.xhrError = 'onerror'
            resolve()
          }
          xhr.send()
        })
      })
      .then(function () {
        return out
      })
  },
  // The cookie API against the probe page's origin: set, read back, list, remove, and what the
  // `onChanged` listener saw meanwhile.
  cookies: function (args) {
    var out = {}
    var before = report.cookieChanges.length
    return chrome.cookies
      .set({ url: args.url, name: 'zenProbe', value: 'w22-' + Date.now(), path: '/', expirationDate: Date.now() / 1000 + 3600 })
      .then(function (cookie) {
        out.set = cookie
        return chrome.cookies.get({ url: args.url, name: 'zenProbe' })
      })
      .then(function (cookie) {
        out.get = cookie
        return chrome.cookies.getAll({ url: args.url })
      })
      .then(function (list) {
        out.getAll = (list || []).map(function (c) {
          return c.name + '=' + c.value
        })
        return chrome.cookies.getAllCookieStores()
      })
      .then(function (stores) {
        out.stores = (stores || []).map(function (s) {
          return s.id
        })
        out.changes = report.cookieChanges.slice(before)
        return out
      })
  },
  cookieRemove: function (args) {
    var before = report.cookieChanges.length
    return chrome.cookies
      .remove({ url: args.url, name: 'zenProbe' })
      .then(function (details) {
        return chrome.cookies.get({ url: args.url, name: 'zenProbe' }).then(function (after) {
          return { removed: details, after: after, changes: report.cookieChanges.slice(before) }
        })
      })
  },
  // A picture of the active tab, decoded to check it is a real image.
  capture: function (args) {
    return chrome.tabs.captureVisibleTab(null, { format: args.format || 'png', quality: args.quality }).then(function (dataUrl) {
      return new Promise(function (resolve) {
        var out = { length: dataUrl ? dataUrl.length : 0, prefix: dataUrl ? dataUrl.slice(0, 22) : null }
        if (!dataUrl) return resolve(out)
        var img = new Image()
        img.onload = function () {
          out.width = img.naturalWidth
          out.height = img.naturalHeight
          out.dataUrl = dataUrl
          resolve(out)
        }
        img.onerror = function () {
          out.decodeError = true
          resolve(out)
        }
        img.src = dataUrl
      })
    })
  },
  // A basic notification with two buttons; the driver taps it in the shade (or clears it).
  notify: function (args) {
    return new Promise(function (resolve) {
      chrome.notifications.create(
        args.id || 'probe-note',
        {
          type: 'basic',
          iconUrl: 'icon.png',
          title: args.title || 'Zenium probe',
          message: args.message || 'A notification from the probe extension.',
          buttons: [{ title: 'First' }, { title: 'Second' }],
          priority: 1
        },
        function (id) {
          var out = { id: id, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null }
          report.notifications.push(out)
          chrome.notifications.getAll(function (all) {
            out.shown = Object.keys(all || {})
            chrome.notifications.getPermissionLevel(function (level) {
              out.permissionLevel = level
              resolve(out)
            })
          })
        }
      )
    })
  },
  notifyClear: function (args) {
    return new Promise(function (resolve) {
      chrome.notifications.clear(args.id || 'probe-note', function (wasCleared) {
        resolve({ wasCleared: wasCleared, events: report.notificationEvents.slice() })
      })
    })
  },
  // The identity sheet: the runner's auth page redirects to the extension's redirect URL.
  auth: function (args) {
    var redirect = chrome.identity.getRedirectURL('cb')
    var url = args.url + '?redirect=' + encodeURIComponent(redirect) + (args.auto ? '&auto=1' : '')
    var details = { url: url, interactive: args.interactive !== false }
    if (!details.interactive) {
      // The stand-in provider redirects shortly after its page has loaded: Chrome's option to
      // keep a silent flow alive past `load`, with a short timeout in case it never does.
      details.abortOnLoadForNonInteractive = false
      details.timeoutMsForNonInteractive = 15000
    }
    return chrome.identity
      .launchWebAuthFlow(details)
      .then(
        function (responseUrl) {
          return { redirect: redirect, responseUrl: responseUrl }
        },
        function (e) {
          return { redirect: redirect, error: String(e && e.message ? e.message : e) }
        }
      )
  },
  // The menu items the background registered, and the clicks it received so far.
  menus: function () {
    return Promise.resolve({ items: report.menuItems, clicks: report.menuClicks })
  },
  navigation: function () {
    return Promise.resolve({ list: report.webNavigation, count: report.webNavigation.length })
  },
  events: function () {
    return Promise.resolve({ notifications: report.notificationEvents, cookieChanges: report.cookieChanges, menuClicks: report.menuClicks })
  }
}

window.__w22 = function (name, args) {
  window.__w22Result = null
  var stage = w22[name]
  if (!stage) return settleW22({ error: 'no stage ' + name })
  try {
    Promise.resolve(stage(args || {})).then(settleW22, function (e) {
      failW22(name, e)
    })
  } catch (e) {
    failW22(name, e)
  }
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  report.menuClicks.push({
    menuItemId: info.menuItemId,
    parentMenuItemId: info.parentMenuItemId,
    linkUrl: info.linkUrl,
    srcUrl: info.srcUrl,
    pageUrl: info.pageUrl,
    frameId: info.frameId,
    tabId: tab ? tab.id : null,
    tabUrl: tab ? tab.url : null
  })
})
// Chrome keeps registered items across service-worker restarts; the probe re-creates its set on
// every start behind `removeAll` so both a fresh install and a restart end with the same items.
// One item per context: Chrome folds several matching items of one extension into a submenu
// named after it, and the demo taps the link item at the top level.
chrome.contextMenus.removeAll(function () {
  var created = []
  var pending = 3
  function done(id) {
    created.push({ id: id, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })
    if (--pending === 0) report.menuItems = created
  }
  chrome.contextMenus.create({ id: 'probe-link', title: 'Probe: report this link', contexts: ['link'] }, function () {
    done('probe-link')
  })
  chrome.contextMenus.create({ id: 'probe-image', title: 'Probe: report this image', contexts: ['image'] }, function () {
    done('probe-image')
  })
  chrome.contextMenus.create({ id: 'probe-page', title: 'Probe: report this page', contexts: ['page'] }, function () {
    done('probe-page')
  })
})

chrome.notifications.onClicked.addListener(function (id) {
  report.notificationEvents.push({ event: 'clicked', id: id })
})
chrome.notifications.onButtonClicked.addListener(function (id, index) {
  report.notificationEvents.push({ event: 'button', id: id, index: index })
})
chrome.notifications.onClosed.addListener(function (id, byUser) {
  report.notificationEvents.push({ event: 'closed', id: id, byUser: byUser })
})

chrome.cookies.onChanged.addListener(function (info) {
  report.cookieChanges.push({ removed: info.removed, cause: info.cause, name: info.cookie && info.cookie.name, domain: info.cookie && info.cookie.domain })
})

function recordNavigation(event) {
  return function (details) {
    if (report.webNavigation.length >= 200) return
    report.webNavigation.push({
      event: event,
      url: details.url,
      tabId: details.tabId,
      frameId: details.frameId,
      transitionType: details.transitionType,
      transitionQualifiers: details.transitionQualifiers,
      error: details.error,
      timeStamp: details.timeStamp
    })
  }
}
chrome.webNavigation.onBeforeNavigate.addListener(recordNavigation('onBeforeNavigate'))
chrome.webNavigation.onDOMContentLoaded.addListener(recordNavigation('onDOMContentLoaded'))
chrome.webNavigation.onCompleted.addListener(recordNavigation('onCompleted'))
chrome.webNavigation.onErrorOccurred.addListener(recordNavigation('onErrorOccurred'))
chrome.webNavigation.onReferenceFragmentUpdated.addListener(recordNavigation('onReferenceFragmentUpdated'))
chrome.webNavigation.onHistoryStateUpdated.addListener(recordNavigation('onHistoryStateUpdated'))
// A filtered listener: only the probe pages of the runner (`hostEquals`), for the filter path.
chrome.webNavigation.onCommitted.addListener(recordNavigation('onCommitted:filtered'), {
  url: [{ hostEquals: '10.0.2.2', pathSuffix: 'probe.html' }]
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
  recordNavigation('onCommitted')(details)
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

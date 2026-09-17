// Runs at document_idle: isolation checks against the page's globals and patches, then the round
// trips (messaging, ports, storage, fetch) whose results the instrumentation reads back from
// `document.__zenProbeIdle`.
;(function () {
  var t0 = performance.now()
  var report = {
    readyState: document.readyState,
    at: t0,
    // Leak-in: the page sets `pageGlobal = 42` in its first inline script.
    pageGlobalFree: typeof pageGlobal,
    pageGlobalOnWindow: typeof window.pageGlobal,
    // Sharing between this extension's groups (one isolated world in Chrome).
    probeVarFromStartGroup: typeof probeVar,
    probeExpandoFromStartGroup: typeof window.probeExpando,
    // Prototype patches by the page are visible to the main world.
    querySelectorPatched: document.querySelector.pagePatched === true,
    currentScript: document.currentScript === null ? 'null' : typeof document.currentScript,
    cssVariable: getComputedStyle(document.documentElement)
      .getPropertyValue('--zen-probe-css')
      .trim(),
    steps: {},
    errors: []
  }
  document.__zenProbeIdle = report

  function done(step, value) {
    report.steps[step] = value
  }
  function fail(step, error) {
    report.errors.push(step + ': ' + (error && error.message ? error.message : String(error)))
    report.steps[step] = 'error'
  }

  var pending = 0
  function begin() {
    pending++
  }
  function end() {
    pending--
    if (pending === 0) {
      report.totalMs = performance.now() - t0
      report.storageEvents = document.__zenProbeStorageEvents || []
      document.documentElement.setAttribute('data-zen-probe-done', '1')
    }
  }

  // 1. runtime.sendMessage round trip to the background.
  begin()
  var sent = performance.now()
  try {
    chrome.runtime.sendMessage({ t: 'ping' }, function (response) {
      if (chrome.runtime.lastError) fail('sendMessage', chrome.runtime.lastError)
      else done('sendMessage', { ms: Math.round(performance.now() - sent), response: response })
      end()
    })
  } catch (e) {
    fail('sendMessage', e)
    end()
  }

  // 2. A port: connect, send, expect the echo.
  begin()
  try {
    var port = chrome.runtime.connect({ name: 'probe' })
    var portTimer = setTimeout(function () {
      fail('port', 'no echo within 5 s')
      end()
    }, 5000)
    port.onMessage.addListener(function (m) {
      clearTimeout(portTimer)
      done('port', m)
      port.disconnect()
      end()
    })
    port.postMessage({ n: 1 })
  } catch (e) {
    fail('port', e)
    end()
  }

  // 3. storage.local set then get (callback form).
  begin()
  try {
    var value = 'v' + Date.now()
    chrome.storage.local.set({ probeKey: value }, function () {
      chrome.storage.local.get('probeKey', function (items) {
        if (chrome.runtime.lastError) fail('storage', chrome.runtime.lastError)
        else
          done(
            'storage',
            items && items.probeKey === value ? 'roundtrip-ok' : JSON.stringify(items)
          )
        end()
      })
    })
  } catch (e) {
    fail('storage', e)
    end()
  }

  // 4. storage.sync (mapped to local) promise form.
  begin()
  try {
    chrome.storage.sync
      .set({ syncKey: 1 })
      .then(function () {
        return chrome.storage.sync.get(['syncKey'])
      })
      .then(function (items) {
        done('storageSync', items.syncKey === 1 ? 'ok' : JSON.stringify(items))
        end()
      })
      .catch(function (e) {
        fail('storageSync', e)
        end()
      })
  } catch (e) {
    fail('storageSync', e)
    end()
  }

  // 5. fetch() of a web-accessible resource on the extension origin (page CSP applies in the main world).
  begin()
  fetch(chrome.runtime.getURL('data.json'))
    .then(function (r) {
      return r.json()
    })
    .then(function (j) {
      done('fetchExtensionResource', j.probe === 'web-accessible' ? 'ok' : JSON.stringify(j))
      end()
    })
    .catch(function (e) {
      fail('fetchExtensionResource', e)
      end()
    })

  // 6. A cross-origin fetch the page's connect-src may forbid.
  begin()
  fetch('https://example.com/', { mode: 'no-cors' })
    .then(function (r) {
      done('fetchCrossOrigin', r.type)
      end()
    })
    .catch(function (e) {
      fail('fetchCrossOrigin', e)
      end()
    })

  // 7. The background's own report (installed reason, alarms, tabs, navigation events).
  begin()
  setTimeout(function () {
    try {
      chrome.runtime.sendMessage({ t: 'bgReport' }, function (response) {
        if (chrome.runtime.lastError) fail('bgReport', chrome.runtime.lastError)
        else done('bgReport', response)
        end()
      })
    } catch (e) {
      fail('bgReport', e)
      end()
    }
  }, 2500)
})()

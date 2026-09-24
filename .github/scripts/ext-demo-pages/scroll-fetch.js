/*
 * The fetch-heavy twin of the frame budget's scroll fixture (ExtensionScrollBudget's
 * `ext-scroll-fetch-*` scenes). `scroll.html` loads this script on every visit and it does
 * nothing unless the page was opened as `scroll.html?fetch`: then, from the page's `load` event
 * on, the page fetches the server's JSON up to twenty times a second (a steady stream of small
 * same-origin `fetch` requests, each under a fresh query string) for a minute – longer than a
 * scene's motion – while it is scrolled. The twin is thus the very same document with its fetch
 * stream switched on by the query, whichever server serves the pages (the frame budget's plain
 * `http.server` included). A page-script observer of the page's own requests (the response
 * stage's observer path, compat round 15) has a report to make per response; the scene reads
 * whether that accounting shows in the scroll's frames against the same page scrolled with no
 * extension attached. `window.__fetches` counts the requests sent and the responses read, for
 * the driver's record.
 *
 * The stream waits for `load` and keeps at most six requests in flight (the engine's connections
 * to one host): the emulator's path to the fixture server completes about six requests a second
 * (round 15's AFTER run, both WebViews), and a stream sent regardless of the answers queued
 * hundreds of `fetch` requests ahead of the page's own images in the engine's connection pool –
 * the page under the response-stage probe on WebView 113 never reached `readyState complete`
 * inside the harness's 90 s. The rate on a real device with a real server stays what the path
 * allows, up to the twenty a second.
 */
;(function () {
  if (!/(^|[?&])fetch(=|&|$)/.test(location.search)) return
  var counts = { sent: 0, done: 0, failed: 0, inFlight: 0, startedAt: 0 }
  window.__fetches = counts
  var n = 0
  // A classic script in the body runs before the document's `load`: the stream waits for it.
  window.addEventListener('load', function () {
    counts.startedAt = Date.now()
    var timer = setInterval(function () {
      if (Date.now() - counts.startedAt > 60000) {
        clearInterval(timer)
        return
      }
      if (counts.inFlight >= 6) return
      n++
      counts.sent++
      counts.inFlight++
      fetch('/data.json?sf=' + n, { cache: 'no-store' })
        .then(function (r) {
          return r.arrayBuffer()
        })
        .then(function () {
          counts.done++
        })
        .catch(function () {
          counts.failed++
        })
        .then(function () {
          counts.inFlight--
        })
    }, 50)
  })
})()

/*
 * The fetch-heavy twin of the frame budget's scroll fixture (ExtensionScrollBudget's
 * `ext-scroll-fetch-*` scenes): the fixture server serves `scroll.html` as `/scroll-fetch.html`
 * with this script appended, and from load on the page fetches the server's JSON twenty times a
 * second (a steady stream of small same-origin `fetch` requests, each under a fresh query
 * string) for a minute – longer than a scene's motion – while it is scrolled. A page-script
 * observer of the page's own requests (the response stage's observer path, compat round 15) has
 * a report to make per response; the scene reads whether that accounting shows in the scroll's
 * frames against the same page scrolled with no extension attached. `window.__fetches` counts
 * the requests sent and the responses read, for the driver's record.
 */
;(function () {
  var counts = { sent: 0, done: 0, failed: 0, startedAt: Date.now() }
  window.__fetches = counts
  var n = 0
  var timer = setInterval(function () {
    if (Date.now() - counts.startedAt > 60000) {
      clearInterval(timer)
      return
    }
    n++
    counts.sent++
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
  }, 50)
})()

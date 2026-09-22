// The site behind the walkthrough's pop-up step (#142): one loopback HTTP server reached through
// two host names. The top page on 127.0.0.1 embeds an iframe from localhost – another origin and
// another site, so Chromium gives the frame a process of its own – and the frame holds a button
// whose click calls `window.open('<top origin>/popup.html', '_blank', 'width=500,height=600')`,
// the way "Sign in with Google" opens its pop-up from inside its accounts.google.com iframe. The
// pop-up keeps the frame as its opener and pings it through postMessage; every document records
// what it saw on its window (`window.__smoke`) for the harness to read.
//
// The same server carries the cookie pages of the clear-on-exit scenario (#310's on-exit run):
// `/cookie-set.html` answers with a persistent first-party `Set-Cookie` and a redirect to
// `/cookie.html`, which shows what `document.cookie` holds and sets nothing – so a tab restored
// on it at the next launch sets nothing either. Every request is logged with the `Cookie` header
// it carried: what the browser sent, read off the wire.
import http from 'node:http'

/** Where the frame sits in the top document (CSS pixels); its button fills the whole frame. */
export const FRAME_RECT = { left: 40, top: 60, width: 640, height: 400 }

/**
 * The cookie `/cookie-set.html` sets: persistent (a day, so the jar writes it to disk and a
 * plain quit keeps it), the whole site, sent on same-site requests.
 */
export const FIXTURE_COOKIE = { name: 'zenium_smoke', value: 'set-by-the-fixture', maxAge: 86400 }

/** The path that sets {@link FIXTURE_COOKIE} and lands on the page that reads it. */
export const COOKIE_SET_PATH = '/cookie-set.html'
/** The page that reads the cookie back and sets nothing. */
export const COOKIE_PATH = '/cookie.html'

/** The `Set-Cookie` header for {@link FIXTURE_COOKIE}. */
export function fixtureSetCookieHeader(cookie = FIXTURE_COOKIE) {
  return `${cookie.name}=${cookie.value}; Max-Age=${cookie.maxAge}; Path=/; SameSite=Lax`
}

const html = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="margin:0;font:16px sans-serif">${body}</body></html>`

/** The documents for a server reachable as `topOrigin` and `frameOrigin`. */
export function fixturePages({ topOrigin, frameOrigin }) {
  const { left, top, width, height } = FRAME_RECT
  const cookieName = FIXTURE_COOKIE.name
  return {
    '/': html(
      'Pop-up fixture',
      `<p style="margin:16px 40px">Pop-up fixture: the frame below is on ${frameOrigin}.</p>
<iframe id="frame" src="${frameOrigin}/frame.html" style="position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;border:0"></iframe>`
    ),
    '/frame.html': html(
      'Pop-up fixture frame',
      `<button id="open" type="button" style="position:absolute;inset:0;width:100%;height:100%;font:inherit">Open the pop-up</button>
<script>
window.__smoke = { origin: location.origin, clicks: 0, trusted: null, opened: null, pings: 0 }
addEventListener('message', (e) => {
  if (e.data && e.data.type === 'smoke-ping' && e.source) {
    window.__smoke.pings++
    e.source.postMessage({ type: 'smoke-pong', from: location.origin }, '*')
  }
})
document.getElementById('open').addEventListener('click', (e) => {
  window.__smoke.clicks++
  window.__smoke.trusted = e.isTrusted
  window.__popup = window.open('${topOrigin}/popup.html', '_blank', 'width=500,height=600')
  window.__smoke.opened = window.__popup !== null
})
</script>`
    ),
    '/popup.html': html(
      'Pop-up fixture pop-up',
      `<p style="margin:16px">The pop-up.</p>
<script>
window.__smoke = { origin: location.origin, opener: window.opener !== null, pong: null }
window.__roundTrip = new Promise((resolve) => {
  addEventListener('message', (e) => {
    if (e.data && e.data.type === 'smoke-pong') {
      window.__smoke.pong = e.data
      resolve(e.data)
    }
  })
})
if (window.opener) window.opener.postMessage({ type: 'smoke-ping', from: location.origin }, '*')
</script>`
    ),
    // The cookie page reads its cookie once, as the document loads, and shows what it found in
    // letters an OS-level screenshot can read; `window.__smoke` keeps the reading for the harness.
    [COOKIE_PATH]: html(
      'Cookie fixture',
      `<h1 id="cookie" style="margin:48px 40px 16px;font-size:44px;font-weight:600">Reading the cookie…</h1>
<p style="margin:0 40px;font-size:22px;color:#555">What document.cookie holds on ${topOrigin}: the fixture's <code>${cookieName}</code> cookie, or none.</p>
<script>
(() => {
  const pairs = document.cookie ? document.cookie.split('; ') : []
  const has = pairs.some((pair) => pair.split('=')[0] === '${cookieName}')
  window.__smoke = { origin: location.origin, cookie: document.cookie, has }
  const heading = document.getElementById('cookie')
  heading.textContent = has ? 'Cookie: ' + document.cookie : 'Cookie: none'
  heading.style.color = has ? '#1b6e3a' : '#8a1c1c'
})()
</script>`
    )
  }
}

/**
 * Starts the server on 127.0.0.1 and names the two origins: `topOrigin` (127.0.0.1) for the top
 * page, the pop-up and the cookie pages, `frameOrigin` (localhost, the same port) for the frame.
 * `requests` lists what was fetched – path, Host header, Sec-Fetch-Dest, the Cookie header – so
 * a run can show the frame really came in as an iframe through the other host name, and whether
 * the browser still sent the fixture's cookie. `close()` stops the server.
 */
export function startPopupFixture() {
  const requests = []
  let pages = null
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://fixture')
    requests.push({
      path: pathname,
      host: req.headers.host,
      dest: req.headers['sec-fetch-dest'],
      cookie: req.headers.cookie
    })
    res.setHeader('cache-control', 'no-store')
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    if (pathname === COOKIE_SET_PATH) {
      res.writeHead(302, { 'set-cookie': fixtureSetCookieHeader(), location: COOKIE_PATH })
      res.end()
      return
    }
    const page = pages && pages[pathname]
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const topOrigin = `http://127.0.0.1:${port}`
      const frameOrigin = `http://localhost:${port}`
      pages = fixturePages({ topOrigin, frameOrigin })
      resolve({
        port,
        topOrigin,
        frameOrigin,
        topUrl: `${topOrigin}/`,
        frameUrl: `${frameOrigin}/frame.html`,
        popupUrl: `${topOrigin}/popup.html`,
        cookieSetUrl: `${topOrigin}${COOKIE_SET_PATH}`,
        cookieUrl: `${topOrigin}${COOKIE_PATH}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}

/**
 * The screen point of the frame's button, for a tool that moves the real pointer: the tab view's
 * rectangle on the screen (`view`, DIPs), the iframe's rectangle in the top document (`frame`)
 * and the button's in the frame (`button`), both CSS pixels at the page's `zoom`, times the
 * display's `scale` to device pixels. `inside` tells whether the point lies within the view (a
 * frame scrolled out of sight cannot be clicked).
 */
export function buttonScreenPoint({ view, frame, button, zoom = 1, scale = 1 }) {
  const dx = (frame.left + button.left + button.width / 2) * zoom
  const dy = (frame.top + button.top + button.height / 2) * zoom
  return {
    x: Math.round((view.x + dx) * scale),
    y: Math.round((view.y + dy) * scale),
    inside: dx >= 0 && dy >= 0 && dx < view.width && dy < view.height
  }
}

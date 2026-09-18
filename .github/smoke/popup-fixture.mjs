// The site behind the walkthrough's pop-up step (#142): one loopback HTTP server reached through
// two host names. The top page on 127.0.0.1 embeds an iframe from localhost – another origin and
// another site, so Chromium gives the frame a process of its own – and the frame holds a button
// whose click calls `window.open('<top origin>/popup.html', '_blank', 'width=500,height=600')`,
// the way "Sign in with Google" opens its pop-up from inside its accounts.google.com iframe. The
// pop-up keeps the frame as its opener and pings it through postMessage; every document records
// what it saw on its window (`window.__smoke`) for the harness to read.
import http from 'node:http'

/** Where the frame sits in the top document (CSS pixels); its button fills the whole frame. */
export const FRAME_RECT = { left: 40, top: 60, width: 640, height: 400 }

const html = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="margin:0;font:16px sans-serif">${body}</body></html>`

/** The three documents for a server reachable as `topOrigin` and `frameOrigin`. */
export function fixturePages({ topOrigin, frameOrigin }) {
  const { left, top, width, height } = FRAME_RECT
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
    )
  }
}

/**
 * Starts the server on 127.0.0.1 and names the two origins: `topOrigin` (127.0.0.1) for the top
 * page and the pop-up, `frameOrigin` (localhost, the same port) for the frame. `requests` lists
 * what was fetched – path, Host header, Sec-Fetch-Dest – so a run can show the frame really came
 * in as an iframe through the other host name. `close()` stops the server.
 */
export function startPopupFixture() {
  const requests = []
  let pages = null
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://fixture')
    requests.push({ path: pathname, host: req.headers.host, dest: req.headers['sec-fetch-dest'] })
    res.setHeader('cache-control', 'no-store')
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
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

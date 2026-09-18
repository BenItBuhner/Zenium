// The pages ServicesHardeningDemo drives, served from the workflow runner (the emulator reaches
// it as 10.0.2.2:8787). Plain Node, no dependencies; started by the demo's caller workflow.
//
//   /popups      opens a pop-up on its own after a moment (blocked) and on a button press (allowed)
//   /popup       what the pop-up shows
//   /apps        tries a tel: launch on its own (blocked), then tel:, mailto: and intent:// links
//   /fallback    where an intent:// with browser_fallback_url lands when no app takes it
//   /protected   HTTP Basic (zenium / secret), realm "Zenium demo area"
//   /client.p12  a demo key pair for the system credential store (DEMO_P12 names the file), so
//                the KeyChain chooser has a certificate to list
import http from 'node:http'
import fs from 'node:fs'

const port = Number(process.env.DEMO_PORT ?? 8787)
const host = process.env.DEMO_HOST ?? `10.0.2.2:${port}`
const pkcs12 = process.env.DEMO_P12

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 28px 22px; font: 17px/1.5 system-ui, sans-serif; background: #f6f5f8; color: #1d1c22; }
  @media (prefers-color-scheme: dark) { body { background: #16161b; color: #ececf1; } }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.01em; }
  p { margin: 0 0 14px; opacity: 0.8; }
  .card { background: rgba(127,127,127,0.10); border-radius: 18px; padding: 18px 20px; margin: 18px 0; }
  a, button { display: block; margin: 12px 0; padding: 14px 18px; border-radius: 14px; border: 0; font: inherit; font-weight: 600;
    background: #4f6df5; color: white; text-decoration: none; text-align: center; }
  a.quiet { background: rgba(127,127,127,0.18); color: inherit; }
  code { font-size: 15px; }
</style></head><body>${body}</body></html>`

const routes = {
  '/': () =>
    page(
      'Zenium services-hardening demo',
      `<h1>Zenium services-hardening demo</h1><p>Pages for the recorded checks.</p>
      <a href="/popups">Pop-ups</a><a href="/apps">Links to other apps</a><a href="/protected">HTTP sign-in</a>`
    ),
  '/popups': () =>
    page(
      'Pop-up blocker',
      `<h1>Pop-up blocker</h1>
      <p>This page opens a pop-up on its own a moment after loading. Zenium blocks it and says so.</p>
      <div class="card"><p id="auto">Trying to open a pop-up without you asking...</p></div>
      <button id="open">Open a pop-up (with a tap)</button>
      <script>
        setTimeout(() => {
          const w = window.open('/popup?how=automatic')
          document.getElementById('auto').textContent = w ? 'The pop-up opened by itself.' : 'The automatic pop-up was blocked.'
        }, 1500)
        document.getElementById('open').addEventListener('click', () => window.open('/popup?how=tap'))
      </script>`
    ),
  '/popup': (url) =>
    page(
      'Pop-up',
      `<h1>${url.searchParams.get('how') === 'tap' ? 'Opened with a tap' : 'Opened deliberately'}</h1>
      <p>This is the pop-up page. It only appears because you asked for it.</p>`
    ),
  '/apps': () =>
    page(
      'Links to other apps',
      `<h1>Links to other apps</h1>
      <p>This page tries to launch the phone app on its own after a moment; Zenium refuses launches without a tap and lists them.</p>
      <a href="tel:+15550100">Call +1 555 0100</a>
      <a href="mailto:hello@zenium.example">Write to hello@zenium.example</a>
      <a href="intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;S.browser_fallback_url=http%3A%2F%2F${encodeURIComponent(host)}%2Ffallback;end">Scan a barcode (intent:// with a fallback)</a>
      <a class="quiet" href="/">Back</a>
      <script>setTimeout(() => { location.href = 'tel:+15550199' }, 1500)</script>`
    ),
  '/fallback': () =>
    page(
      'Fallback',
      `<h1>No app took the intent</h1>
      <p>The <code>intent://</code> link named an app that is not installed, so Zenium opened its <code>browser_fallback_url</code> instead of failing silently.</p>`
    ),
  '/protected': (_url, req, res) => {
    const auth = req.headers.authorization ?? ''
    const expected = 'Basic ' + Buffer.from('zenium:secret').toString('base64')
    if (auth !== expected) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Zenium demo area", charset="UTF-8"')
      res.statusCode = 401
      return page(
        'Sign-in required',
        `<h1>401</h1><p>This area needs a username and password (zenium / secret). Cancelling the sign-in shows this page.</p>`
      )
    }
    return page(
      'Signed in',
      `<h1>Signed in as zenium</h1><p>This page needed HTTP Basic authentication; Zenium asked once and passed the answer on.</p>`
    )
  }
}

const handler = (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
  if (url.pathname === '/client.p12' && pkcs12 && fs.existsSync(pkcs12)) {
    res.setHeader('Content-Type', 'application/x-pkcs12')
    res.setHeader('Cache-Control', 'no-store')
    res.end(fs.readFileSync(pkcs12))
    console.log(`${new Date().toISOString()} 200 ${req.method} ${url.pathname}`)
    return
  }
  const route = routes[url.pathname]
  if (!route) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  const body = route(url, req, res)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
  console.log(
    `${new Date().toISOString()} ${res.statusCode} ${req.method} ${url.pathname}${url.search}`
  )
}

http.createServer(handler).listen(port, () => console.log(`http demo server on ${port} as ${host}`))

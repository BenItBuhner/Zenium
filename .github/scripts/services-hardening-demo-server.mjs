// Temporary: the pages the services-hardening demos drive, served from the runner (the emulator
// reaches it as 10.0.2.2) or from localhost for the desktop recording. No dependencies.
//
//   /popups     opens a pop-up on its own after a moment (blocked) and on a button press (allowed)
//   /popup      what the pop-up shows
//   /apps       tries a tel: launch on its own (blocked), then tel:, mailto: and intent:// links
//   /fallback   where an intent:// with browser_fallback_url lands when no app takes it
//   /protected  HTTP Basic (zenium / secret), realm "Zenium demo area"
//   /whoami     over TLS with a client certificate requested: names the certificate that was sent
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'

const port = Number(process.env.DEMO_PORT ?? 8787)
const host = process.env.DEMO_HOST ?? `10.0.2.2:${port}`
const tls = process.env.DEMO_TLS_DIR

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
      <p>This page tries to launch the phone app on its own after a moment; Zenium never dials without asking (on desktop a launch without a tap is listed with the tab's blocked pop-ups).</p>
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
  },
  '/permissions': () =>
    page(
      'Permissions that used to be granted silently',
      `<h1>Permissions Zenium now asks about</h1>
      <p>Each button requests something the browser used to grant without a word.</p>
      <button id="idle">Detect when I step away (Idle Detection)</button>
      <button id="screens">See all my screens (Window Management)</button>
      <button id="save">Edit a text file (File System Access)</button>
      <div class="card"><p id="result">Nothing requested yet.</p></div>
      <p>Embedded from another origin:</p>
      <iframe src="http://127.0.0.1:${port}/embed" style="width:100%;height:150px;border:0;border-radius:14px;background:rgba(127,127,127,0.12)"></iframe>
      <script>
        const say = (t) => { document.getElementById('result').textContent = t }
        document.getElementById('idle').onclick = async () => {
          try { say('Idle detection: ' + await IdleDetector.requestPermission()) } catch (e) { say('Idle detection: ' + e.message) }
        }
        document.getElementById('screens').onclick = async () => {
          try { const d = await getScreenDetails(); say('Window management: allowed, ' + d.screens.length + ' screen(s)') } catch (e) { say('Window management: ' + e.message) }
        }
        document.getElementById('save').onclick = async () => {
          try {
            // Opening a file grants reading only; writing to it is what the browser must ask about.
            const [h] = await showOpenFilePicker({ types: [{ description: 'Text', accept: { 'text/plain': ['.txt'] } }] })
            const w = await h.createWritable()
            await w.write('Edited by the Zenium demo page.')
            await w.close()
            say('File saved: ' + h.name)
          } catch (e) { say('File System Access: ' + e.message) }
        }
      </script>`
    ),
  '/embed': () =>
    page(
      'Embedded frame',
      `<p style="margin:0 0 10px">This frame comes from 127.0.0.1 and wants its own cookies while embedded.</p>
      <button id="sa" style="margin:0">Use my cookies here (Storage Access)</button>
      <p id="r" style="margin:10px 0 0"></p>
      <script>
        document.getElementById('sa').onclick = async () => {
          try { await document.requestStorageAccess(); document.getElementById('r').textContent = 'Storage access granted.' }
          catch (e) { document.getElementById('r').textContent = 'Storage access: ' + e.message }
        }
      </script>`
    ),
  '/whoami': (_url, req) => {
    const cert = req.socket.getPeerCertificate?.()
    const subject = cert?.subject
      ? Object.entries(cert.subject)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
      : null
    return page(
      'Client certificate',
      subject
        ? `<h1>Hello, ${cert.subject.CN ?? 'certificate holder'}</h1><p>The server received your certificate: <code>${subject}</code></p>`
        : `<h1>No certificate</h1><p>The request arrived without a client certificate.</p>`
    )
  }
}

const handler = (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
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

if (tls) {
  https
    .createServer(
      {
        key: fs.readFileSync(`${tls}/server.key`),
        cert: fs.readFileSync(`${tls}/server.crt`),
        ca: fs.readFileSync(`${tls}/ca.crt`),
        requestCert: true,
        rejectUnauthorized: false
      },
      handler
    )
    .listen(port, () => console.log(`https demo server on ${port} (client certificates requested)`))
} else {
  http
    .createServer(handler)
    .listen(port, () => console.log(`http demo server on ${port} as ${host}`))
}

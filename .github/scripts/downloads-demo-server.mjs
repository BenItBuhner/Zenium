// Range-capable test server behind the DownloadsDemo instrumentation test (android/app/src/androidTest).
// Run it on the machine that hosts the emulator (`node .github/scripts/downloads-demo-server.mjs 18923`);
// the emulator reaches it at 10.0.2.2:18923. A caller of android-emulator-demo.yml starts it from
// `setup-script` with DEMO_CLASS=app.zen.chromium.DownloadsDemo. slow.bin is throttled so Pause and
// Resume have something to hold; flaky.bin drops every full response at 1 MiB so only a Range
// resume can finish it; the data: and blob: links are named from their anchors.
import http from 'node:http'
// Every payload byte comes from this formula; DownloadsDemo.expectedByte is the same one.
const byteAt = (i) => (i * 31 + (i >> 8)) & 0xff
const SLOW = 3 * 1024 * 1024
const FLAKY = 2 * 1024 * 1024
const CUT_AT = 1024 * 1024
const dataText = Buffer.from('Hello from a Zenium data: link\n').toString('base64')
const page = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zenium download test</title>
<style>
  body { font: 18px system-ui, sans-serif; margin: 0; padding: 24px; background: #f6f6f8; color: #111 }
  h1 { font-size: 22px; margin: 0 0 8px }
  p { margin: 0 0 20px; color: #555; font-size: 15px }
  a { display: block; margin: 14px 0; padding: 20px; border-radius: 16px; background: #4f6bed; color: #fff; text-decoration: none; font-weight: 600 }
</style>
<h1>Zenium download test</h1>
<p>Files served from the runner. slow.bin is throttled, flaky.bin loses its connection once.</p>
<a href="/slow.bin">Download slow.bin</a>
<a href="/flaky.bin">Download flaky.bin</a>
<a href="data:text/plain;base64,${dataText}" download="hello-data.txt">Download hello-data.txt</a>
<a id="blob" href="#" download="hello-blob.txt">Download hello-blob.txt</a>
<script>
  document.getElementById('blob').href =
    URL.createObjectURL(new Blob(['Hello from a Zenium blob: link\\n'], { type: 'text/plain' }))
</script>`

// A Range-capable file of `size` bytes with a strong ETag. `rate` (bytes/s) throttles it;
// `cutAt` drops every full (non-Range) response at that offset, so a resume with Range is the
// only way to finish the file.
function serve(req, res, name, size, { rate = 0, cutAt = Infinity, disposition = false }) {
  let start = 0
  let end = size - 1
  let status = 200
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  if (range) {
    start = Number(range[1])
    if (range[2]) end = Math.min(Number(range[2]), size - 1)
    if (start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    status = 206
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: `"zenium-${name}-${size}"`,
    'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
    'Content-Length': String(end - start + 1),
    'Cache-Control': 'no-store'
  }
  if (disposition) headers['Content-Disposition'] = `attachment; filename="${name}"`
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(status, headers)
  const cut = range ? Infinity : cutAt
  let pos = start
  const tick = () => {
    if (res.destroyed) return
    if (pos > end) return res.end()
    if (pos >= cut) {
      console.log(`${name}: cutting the connection at ${pos}`)
      return res.destroy()
    }
    const n = Math.min(64 * 1024, end - pos + 1, cut - pos)
    const buf = Buffer.allocUnsafe(n)
    for (let i = 0; i < n; i++) buf[i] = byteAt(pos + i)
    pos += n
    const delay = rate ? Math.round((n / rate) * 1000) : 0
    if (res.write(buf)) setTimeout(tick, delay)
    else res.once('drain', () => setTimeout(tick, delay))
  }
  tick()
}

http
  .createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    console.log(
      `${req.method} ${path} range=${req.headers.range || '-'} ua=${(req.headers['user-agent'] || '').slice(0, 40)}`
    )
    if (path === '/page.html' || path === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      return res.end(page)
    }
    if (path === '/slow.bin')
      return serve(req, res, 'slow.bin', SLOW, { rate: 350 * 1024, disposition: true })
    if (path === '/flaky.bin') return serve(req, res, 'flaky.bin', FLAKY, { cutAt: CUT_AT })
    res.writeHead(404)
    res.end()
  })
  .listen(Number(process.argv[2] || 18923), '0.0.0.0', () => console.log('download test server up'))

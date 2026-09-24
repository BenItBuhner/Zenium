#!/usr/bin/env node
// The startup scene's fixture page (android-startup-demo.sh, StartupDemo.kt), served from the
// runner: the emulator reaches the runner's loopback as 10.0.2.2, and a page served here is still
// there after the browser's process has been stopped and cold-started – which no page served from
// inside the instrumentation (the other demos' DemoServer) could be, since the instrumentation
// shares the process. One page, one colour: a teal body the recording tells from the splash's
// indigo, from a blank page slot and from the chrome, with the title near the top and a line
// near the bottom, the centre clear.
//
//   node android-startup-demo-server.mjs <port> <hold-file>
//
// GET /fixture answers the page at once – the seed act's serve, the one the tab's picture is
// taken of – unless the hold file exists: then the answer waits the milliseconds the file
// holds (the cold start's serve: the restored tab's picture has to stand alone under the chrome
// long enough to be seen and read), and the page carries the live mark, an amber disc at the
// centre the seed's serve did not have, so a frame in which the page itself has painted reads
// apart from one showing its picture. Every request is logged with its time and its hold.
// GET /health answers `ok`.
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'

const [portArg, holdFile] = process.argv.slice(2)
const port = Number(portArg)
if (!port || !holdFile) {
  console.error('usage: android-startup-demo-server.mjs <port> <hold-file>')
  process.exit(2)
}

const page = (live, heldMs) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SU|fixture</title>
<style>
html,body{margin:0;height:100%;background:#1f9d7a;color:#fff;font:600 22px/1.3 system-ui,sans-serif}
main{position:relative;height:100%;overflow:hidden}
h1{position:absolute;top:12%;left:0;right:0;margin:0;text-align:center;font-size:24px}
p{position:absolute;bottom:8%;left:0;right:0;margin:0;text-align:center;font-size:14px;opacity:.85}
.mark{position:absolute;left:50%;top:50%;width:220px;height:220px;margin:-110px 0 0 -110px;border-radius:50%;background:#ffb000}
</style></head>
<body><main><h1>Zenium startup fixture</h1>${live ? '<div class="mark"></div>' : ''}
<p>served ${new Date().toISOString()}${live ? ` after a hold of ${heldMs} ms (the live mark is up)` : ' at once'}</p>
</main></body></html>
`

const holdMs = () => {
  if (!existsSync(holdFile)) return 0
  const value = Number(readFileSync(holdFile, 'utf8').trim())
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

const stamp = () => new Date().toISOString()

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok\n')
    return
  }
  if (url.pathname !== '/fixture') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not here\n')
    return
  }
  const hold = holdMs()
  console.log(`${stamp()} GET /fixture${hold ? ` held ${hold} ms` : ''}`)
  const answer = () => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(page(hold > 0, hold))
    console.log(`${stamp()} answered /fixture${hold ? ' with the live mark' : ''}`)
  }
  if (hold > 0) setTimeout(answer, hold)
  else answer()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`${stamp()} fixture server on 127.0.0.1:${port} (10.0.2.2:${port} inside the emulator); hold file ${holdFile}`)
})

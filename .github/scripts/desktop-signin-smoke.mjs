#!/usr/bin/env node
/**
 * Sign-in fidelity smoke test for the packaged desktop build.
 *
 * Boots the unpacked Linux build (under Xvfb: the workflow wraps this in `xvfb-run`) with a
 * throwaway profile whose MCP server is on, points a tab at a local page and checks what a site
 * sees – the things identity providers key on and that Electron gets wrong out of the box:
 *
 *   - `navigator.webdriver` is false (no automation switch on the command line);
 *   - `window.chrome` carries Chrome's `app`, `csi` and `loadTimes` (Google's sign-in refuses a
 *     Chrome whose `chrome` object lacks `app` as an embedded browser);
 *   - the user agent is Chrome's reduced string, without Electron or Zenium tokens;
 *   - the document request carries the low-entropy client hints and Chrome's Accept-Language;
 *   - FedCM is not exposed (Electron cannot serve it; Google's button would take that path);
 *   - a `window.open` pop-up keeps its opener, its `postMessage` arrives, and the pop-up's
 *     document runs the page preload (its `chrome.app` is there too).
 *
 * Usage: node .github/scripts/desktop-signin-smoke.mjs [path/to/zenium]
 * Exit code 0 when every check passes, 1 otherwise; the checks are printed either way.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const binary = resolve(process.argv[2] ?? 'dist/linux-unpacked/zenium')
const AGENT_PORT = 41739
const failures = []
const passes = []
const check = (name, ok, detail = '') => {
  ;(ok ? passes : failures).push(`${name}${detail ? ` – ${detail}` : ''}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` – ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- the site --------------------------------------------------------------------------------

const requests = []
const site = createServer((req, res) => {
  requests.push({ url: req.url, headers: req.headers })
  res.setHeader('cache-control', 'no-store')
  if (req.url.startsWith('/popup')) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>popup</title><body><script>
      const report = { from: 'popup', opener: Boolean(window.opener), chromeApp: typeof (window.chrome && window.chrome.app) };
      if (window.opener) window.opener.postMessage(report, '*');
    </script></body>`)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>smoke</title><body><button id="open">open</button><script>
    window.__popupMessage = null;
    addEventListener('message', (e) => { window.__popupMessage = e.data });
    document.getElementById('open').addEventListener('click', () => { window.__popup = window.open('/popup', 'smoke', 'width=400,height=300') });
  </script></body>`)
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const siteUrl = `http://localhost:${site.address().port}/`

// --- the browser -----------------------------------------------------------------------------

const config = mkdtempSync(join(tmpdir(), 'zenium-smoke-'))
mkdirSync(join(config, 'Zenium', 'zen'), { recursive: true })
writeFileSync(
  join(config, 'Zenium', 'zen', 'state.json'),
  JSON.stringify({
    version: 3,
    settings: {
      onboardingDone: true,
      defaultBrowserPromptDismissed: 1,
      updates: { checkAutomatically: false },
      agents: {
        enabled: true,
        port: AGENT_PORT,
        lan: false,
        approveNewAgents: false,
        approvedNames: [],
        defaultMode: 'foreground',
        allowScripts: true,
        showCursor: false
      }
    }
  })
)
const app = spawn(binary, ['--no-sandbox'], {
  env: { ...process.env, XDG_CONFIG_HOME: config },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))
app.on('exit', (code) => console.log(`zenium exited with ${code}`))

const agentFile = join(config, 'Zenium', 'zen', 'agent.json')
let token = ''
for (let i = 0; i < 60 && !token; i++) {
  await sleep(1000)
  try {
    const agent = JSON.parse(readFileSync(agentFile, 'utf8'))
    if (agent.token) {
      const probe = await fetch(`http://127.0.0.1:${AGENT_PORT}/mcp`).catch(() => null)
      if (probe) token = agent.token
    }
  } catch {
    /* not written yet */
  }
}
if (!token) {
  console.error('MCP server did not come up\n' + appLog)
  app.kill('SIGKILL')
  process.exit(1)
}

let sessionId = ''
async function rpc(method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'user-agent': 'zenium-smoke'
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  sessionId = res.headers.get('mcp-session-id') ?? sessionId
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
async function tool(name, args = {}) {
  const reply = await rpc('tools/call', { name, arguments: args })
  if (!reply || reply.error) throw new Error(`${name}: ${JSON.stringify(reply?.error)}`)
  const out = (reply.result.content ?? []).map((c) => c.text ?? '').join('\n')
  if (reply.result.isError) throw new Error(`${name}: ${out}`)
  return out
}
async function evaluate(expression, tabId) {
  const out = await tool('browser_evaluate', tabId ? { expression, tabId } : { expression })
  return JSON.parse(out.slice(out.indexOf('\n') + 1))
}

let exitCode = 1
try {
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'zenium-smoke', version: '1' }
  })
  await tool('zen_mode', { mode: 'foreground' })
  await tool('browser_navigate', { url: siteUrl })
  await sleep(1500)

  const page = await evaluate(`({
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    chrome: typeof window.chrome,
    chromeApp: typeof (window.chrome && window.chrome.app),
    chromeCsi: typeof (window.chrome && window.chrome.csi),
    chromeLoadTimes: typeof (window.chrome && window.chrome.loadTimes),
    fedcm: 'IdentityCredential' in window,
    brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand) : null
  })`)
  check('navigator.webdriver is false', page.webdriver === false, String(page.webdriver))
  check(
    'window.chrome has app, csi and loadTimes',
    page.chromeApp === 'object' &&
      page.chromeCsi === 'function' &&
      page.chromeLoadTimes === 'function',
    `${page.chrome}: app=${page.chromeApp} csi=${page.chromeCsi} loadTimes=${page.chromeLoadTimes}`
  )
  check(
    'user agent is Chrome’s reduced string',
    / Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(page.ua) && !/Electron|Zenium/i.test(page.ua),
    page.ua
  )
  check('FedCM is not exposed', page.fedcm === false, `IdentityCredential in window: ${page.fedcm}`)
  check(
    'client hint brands name Chromium',
    Array.isArray(page.brands) && page.brands.includes('Chromium'),
    JSON.stringify(page.brands)
  )

  const document = requests.find((r) => r.url === '/' && r.headers['sec-fetch-dest'] === 'document')
  const h = document?.headers ?? {}
  check(
    'document request carries the low-entropy client hints',
    Boolean(h['sec-ch-ua'] && h['sec-ch-ua-mobile'] && h['sec-ch-ua-platform']),
    `sec-ch-ua=${h['sec-ch-ua']} mobile=${h['sec-ch-ua-mobile']} platform=${h['sec-ch-ua-platform']}`
  )
  check(
    'document request sends Chrome’s Accept-Language',
    /^[a-z]{2}(-[A-Za-z]{2})?,[a-z]{2}/.test(h['accept-language'] ?? '') &&
      /;q=/.test(h['accept-language'] ?? ''),
    h['accept-language']
  )
  check('document request user agent equals navigator.userAgent', h['user-agent'] === page.ua)

  await tool('browser_click', { target: 'text=open' })
  await sleep(2500)
  const popup = await evaluate(
    `({ message: window.__popupMessage, handle: Boolean(window.__popup), closed: window.__popup ? window.__popup.closed : null })`
  )
  check('window.open returned a handle', popup.handle === true && popup.closed === false)
  check(
    'pop-up kept its opener and its postMessage arrived',
    popup.message?.from === 'popup' && popup.message?.opener === true,
    JSON.stringify(popup.message)
  )
  check(
    'pop-up document runs the page preload (chrome.app present)',
    popup.message?.chromeApp === 'object',
    `chrome.app in popup: ${popup.message?.chromeApp}`
  )
  const jsErrors = appLog.split('\n').filter((l) => /Uncaught|TypeError|ReferenceError/.test(l))
  check('no JavaScript errors in the browser log', jsErrors.length === 0, jsErrors.join(' | '))
  exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  console.error('smoke test failed:', error)
  console.error(appLog)
} finally {
  app.kill('SIGTERM')
  await Promise.race([new Promise((r) => app.once('exit', r)), sleep(5000)])
  app.kill('SIGKILL')
  site.close()
  rmSync(config, { recursive: true, force: true })
}
console.log(`\n${passes.length} passed, ${failures.length} failed`)
process.exit(exitCode)

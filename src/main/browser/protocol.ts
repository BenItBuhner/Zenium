import { protocol, type Session } from 'electron'

/**
 * `zen://` internal pages. Zen has no new-tab page (the URL bar replaces it), so `zen://blank` is
 * an empty page that picks up the theme; `zen://error` renders navigation failures.
 */
export const ZEN_SCHEME = 'zen'

export function registerZenScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ZEN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
    }
  ])
}

const ERROR_MESSAGES: Record<number, string> = {
  [-105]: "We can't connect to the server at this address. Check the address for typing errors.",
  [-106]: 'You appear to be offline. Check your network connection and try again.',
  [-102]: 'The connection was refused. The server may be down or not accepting connections.',
  [-118]: 'The connection timed out. The server took too long to respond.',
  [-7]: 'The connection timed out. The server took too long to respond.',
  [-100]: 'The connection was closed unexpectedly.',
  [-101]: 'The connection was reset.',
  [-109]: 'The address could not be reached.',
  [-200]: 'The certificate for this site is not trusted.',
  [-201]: 'The certificate for this site has expired or is not yet valid.',
  [-202]: 'The certificate authority for this site is invalid.',
  [-501]: 'The site tried to use an insecure response.',
  [-300]: 'The address is invalid.',
  [-310]: 'Too many redirects. The page is stuck in a redirect loop.',
  [-324]: 'The server sent an empty response.',
  [-6]: 'The file could not be found.',
  [-20]: 'This request was blocked.',
  [-21]: 'Network access was blocked.',
  [-3]: ''
}

export function describeNetError(code: number, fallback: string): string {
  return ERROR_MESSAGES[code] ?? fallback
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

const BASE_STYLE = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { background: transparent; color: light-dark(#1e1e24, #f0f0f5); display: grid; place-items: center; }
  .card { max-width: 480px; padding: 32px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
  p { margin: 0 0 20px; line-height: 1.5; opacity: .8; }
  code { font-family: ui-monospace, monospace; font-size: 13px; opacity: .7; word-break: break-all; }
  button { font: inherit; padding: 8px 18px; border-radius: 999px; border: 1px solid light-dark(#0002, #fff3); background: light-dark(#fff8, #ffffff14); color: inherit; cursor: pointer; }
  button:hover { background: light-dark(#fff, #ffffff22); }
`

function blankPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>New Tab</title><style>${BASE_STYLE}</style></head><body></body></html>`
}

function errorPage(url: URL): string {
  const code = Number(url.searchParams.get('code') ?? 0)
  const description = url.searchParams.get('description') ?? ''
  const target = url.searchParams.get('url') ?? ''
  const message = describeNetError(code, 'The page could not be loaded.')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Problem loading page</title><style>${BASE_STYLE}</style></head>
<body><div class="card">
  <h1>Hmm. We're having trouble finding that site.</h1>
  <p>${escapeHtml(message)}</p>
  <p><code>${escapeHtml(target)}</code><br><code>${escapeHtml(description)} (${code})</code></p>
  <button onclick="location.replace(${JSON.stringify(target)})">Try Again</button>
</div></body></html>`
}

export function installZenProtocol(ses: Session): void {
  if (ses.protocol.isProtocolHandled(ZEN_SCHEME)) return
  ses.protocol.handle(ZEN_SCHEME, (request) => {
    const url = new URL(request.url)
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    switch (url.hostname) {
      case 'blank':
        return new Response(blankPage(), { headers })
      case 'error':
        return new Response(errorPage(url), { headers })
      default:
        return new Response(blankPage(), { headers })
    }
  })
}

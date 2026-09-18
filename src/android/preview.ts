import type { Rect } from '@shared/types'
import type { NativeBridge, NativeCall } from './bridge'
import type { BootInfo } from './platform'

interface HostGlobal {
  resolve(id: number, json: string | null): void
  reject(id: number, message: string): void
  viewEvent(tabId: string, name: string, json: string): void
  hostEvent(name: string, json: string): void
}

const STORAGE_PREFIX = 'zen-preview:'
/** How long a reload takes to begin in this stand-in host (see `view.reload`). */
const RELOAD_DELAY_MS = 3000
/** Where the dev server keeps the documents `view.loadHtml` shows (see `vite.android.config.ts`). */
const PAGE_ROUTE = '/__zen/page/'
/** Whether the preview "holds the browser role" (outside the file store: it is not profile data). */
const DEFAULT_BROWSER_KEY = 'zen-preview-default-browser'

/**
 * A stand-in for the Kotlin host so the Android chrome can run in an ordinary desktop browser
 * (`npm run dev:android`): tab views are `<iframe>`s stacked above the chrome, persistence goes
 * to `localStorage`, dialogs use `window.confirm`. Handy for developing the mobile layout with
 * DevTools' device emulation; not a browser you would want to use.
 */
export function createPreviewBridge(): NativeBridge {
  const host = (): HostGlobal => (window as unknown as { __zenHost: HostGlobal }).__zenHost
  const views = new Map<string, HTMLIFrameElement>()
  const density = 1

  const files: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(STORAGE_PREFIX))
      files[key.slice(STORAGE_PREFIX.length)] = localStorage.getItem(key) ?? ''
  }

  const viewEvent = (tabId: string, name: string, payload: unknown): void =>
    host().viewEvent(tabId, name, JSON.stringify(payload ?? null))

  const navState = (frame: HTMLIFrameElement): Record<string, unknown> => ({
    url: frame.dataset.url ?? '',
    title: frame.dataset.title ?? '',
    canGoBack: false,
    canGoForward: false
  })

  let pageSerial = 0
  /**
   * Shows `html` in the frame as a document of its own, served by the dev server, the way the
   * WebView's `loadDataWithBaseURL` shows it. As `srcdoc` the document would inherit the chrome's
   * Content Security Policy (`script-src 'self'`), which blocks the inline script and handlers a
   * zen:// page runs (the error page's theme and Reload among them). A load that began after this
   * one owns the frame.
   */
  const showDocument = async (frame: HTMLIFrameElement, html: string): Promise<void> => {
    const id = String(++pageSerial)
    frame.dataset.load = id
    const stored = await fetch(PAGE_ROUTE + id, { method: 'PUT', body: html })
    if (!stored.ok || frame.dataset.load !== id) return
    frame.src = PAGE_ROUTE + id
  }

  // `?sdk=32` stands in for an older release (below 33 the chrome confirms copies itself).
  const sdkInt = Number(new URLSearchParams(location.search).get('sdk')) || 34

  const handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {
    boot: (): BootInfo => ({
      version: 'preview',
      sdkInt,
      signer: null,
      packageName: null,
      files,
      downloadsDir: '/Downloads',
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      fullscreen: false,
      environment: { largeScreen: false, pointerAndKeyboard: false, fontScale: 1 }
    }),
    'storage.write': ({ name, text }) =>
      localStorage.setItem(STORAGE_PREFIX + String(name), String(text)),
    'storage.writeSync': ({ name, text }) =>
      localStorage.setItem(STORAGE_PREFIX + String(name), String(text)),
    'storage.read': ({ name }) => localStorage.getItem(STORAGE_PREFIX + String(name)),
    'storage.exists': ({ name }) => localStorage.getItem(STORAGE_PREFIX + String(name)) !== null,
    'storage.remove': ({ name }) => localStorage.removeItem(STORAGE_PREFIX + String(name)),
    // The preview has no request engine and ships no filter-list snapshot.
    'blocking.bundled': () => [],
    'blocking.install': () => null,
    'view.create': ({ tabId }) => {
      const frame = document.createElement('iframe')
      frame.className = 'zen-preview-view'
      frame.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;border:0;background:#fff;display:none;z-index:50;'
      frame.dataset.tabId = String(tabId)
      frame.addEventListener('load', () => {
        let title = ''
        try {
          title = frame.contentDocument?.title ?? ''
        } catch {
          /* cross-origin */
        }
        frame.dataset.title = title
        // The frame's document is complete: its DOM is ready, then it has finished loading.
        viewEvent(String(tabId), 'domReady', null)
        viewEvent(String(tabId), 'stopLoading', { ...navState(frame), title })
        if (title) viewEvent(String(tabId), 'title', { title })
      })
      document.body.appendChild(frame)
      views.set(String(tabId), frame)
    },
    'view.destroy': ({ tabId }) => {
      views.get(String(tabId))?.remove()
      views.delete(String(tabId))
      viewEvent(String(tabId), 'destroyed', null)
    },
    'view.load': ({ tabId, url }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      frame.dataset.url = String(url)
      frame.dataset.title = ''
      frame.dataset.load = ''
      viewEvent(String(tabId), 'startLoading', null)
      frame.src = String(url)
      viewEvent(String(tabId), 'navigated', { ...navState(frame), inPage: false })
    },
    'view.reload': ({ tabId }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      viewEvent(String(tabId), 'startLoading', null)
      // Deliberately unhurried, like a reload over a slow connection: what the chrome shows while
      // a page is loading (the pull-to-refresh disc spinning) stays up long enough to be looked at.
      const url = frame.dataset.url
      if (url) window.setTimeout(() => (frame.src = url), RELOAD_DELAY_MS)
    },
    'view.loadHtml': ({ tabId, url, html }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      frame.dataset.url = String(url)
      void showDocument(frame, String(html))
      viewEvent(String(tabId), 'navigated', { ...navState(frame), inPage: false })
    },
    'view.setBounds': ({ tabId, rect }) => {
      const frame = views.get(String(tabId))
      const r = rect as Rect
      if (!frame) return
      frame.style.left = `${r.x / density}px`
      frame.style.top = `${r.y / density}px`
      frame.style.width = `${r.width / density}px`
      frame.style.height = `${r.height / density}px`
    },
    'view.setRadius': ({ tabId, radius }) => {
      const frame = views.get(String(tabId))
      if (frame) frame.style.borderRadius = `${Number(radius)}px`
    },
    // The page comes down off the frame's top edge by the pull's offset; like Kotlin, the bottom
    // is clipped so the page never overlaps the chrome below the frame.
    'view.setPullOffset': ({ tabId, offset }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      const y = Math.max(0, Number(offset))
      frame.style.transform = y > 0 ? `translate3d(0, ${y}px, 0)` : ''
      frame.style.clipPath =
        y > 0 ? `inset(0 0 ${y}px 0 round ${frame.style.borderRadius || '0px'})` : ''
    },
    'chrome.setPullToRefresh': () => undefined,
    'view.setVisible': ({ tabId, visible }) => {
      const frame = views.get(String(tabId))
      if (frame) frame.style.display = visible ? 'block' : 'none'
    },
    'view.bringToFront': ({ tabId }) => {
      const frame = views.get(String(tabId))
      if (frame) document.body.appendChild(frame)
    },
    'view.setBackground': ({ tabId, color }) => {
      const frame = views.get(String(tabId))
      if (frame) frame.style.background = String(color)
    },
    'view.snapshot': ({ tabId }) => {
      const frame = views.get(String(tabId))
      return frame && frame.style.display !== 'none' ? snapshotFrame(frame) : null
    },
    'view.eval': () => {
      throw new Error('not available in the preview host')
    },
    // Page controls act inside the page WebViews; a cross-origin iframe offers no way in.
    'view.setZoom': () => undefined,
    'view.setDesktopMode': () => undefined,
    'view.setDarkening': () => undefined,
    'view.setPageRules': () => undefined,
    // Find in page: a same-origin frame is searched for real; a cross-origin one (any live site)
    // cannot be read, so it gets a stand-in count derived from the text (0 to 9 matches, so both
    // the found and the not-found states can be reached), enough for the find bar to lay out.
    'view.find': ({ tabId, text, forward, newSession }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      const result = findInFrame(frame, String(text), Boolean(forward), Boolean(newSession))
      viewEvent(String(tabId), 'found', { ...result, finalUpdate: true })
    },
    'view.stopFind': ({ tabId }) => {
      const frame = views.get(String(tabId))
      if (frame) finds.delete(frame)
    },
    'view.savePage': () => null,
    'view.screenshot': () => null,
    'view.certificate': () => null,
    // The preview has no cookie jar of its own to look into; the sheet shows the connection only.
    'site.cookies': () => [],
    'site.storage': () => ({ usageBytes: null, quotaBytes: null, origins: [] }),
    'site.clearCookies': () => ({ removed: 0, remaining: 0 }),
    'site.clearStorage': () => ({ ok: true, scope: 'origins' }),
    'dialog.confirm': ({ message, detail }) => window.confirm(`${message}\n\n${detail ?? ''}`),
    'dialog.openText': ({ extensions }) =>
      new Promise<Array<{ name: string; text: string }>>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        const exts = Array.isArray(extensions) ? extensions.map((e) => `.${String(e)}`) : []
        if (exts.length) input.accept = exts.join(',')
        input.onchange = async () => {
          const files = [...(input.files ?? [])]
          resolve(
            await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
          )
        }
        input.oncancel = () => resolve([])
        input.click()
      }),
    'dialog.saveText': ({ defaultName, mimeType, text }) => {
      const blob = new Blob([String(text)], { type: String(mimeType) })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = String(defaultName)
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      return true
    },
    'clipboard.writeText': ({ text }) => void navigator.clipboard?.writeText(String(text)),
    'clipboard.writeImage': () => false,
    'app.openExternal': ({ url }) => void window.open(String(url), '_blank'),
    // The browser's own share sheet where there is one; otherwise the share is just logged.
    'app.share': async ({ title, text, url, imageUrl }) => {
      const data = {
        title: title ? String(title) : undefined,
        text: text ? String(text) : undefined,
        url: url ? String(url) : imageUrl ? String(imageUrl) : undefined
      }
      if (typeof navigator.share === 'function') await navigator.share(data).catch(() => undefined)
      else console.info('[zen preview] share', data)
    },
    'app.openAppLinkSettings': () => console.info('[zen preview] open-by-default settings'),
    'externalProtocol.respond': ({ requestId, allow }) =>
      console.info('[zen preview] external protocol', requestId, allow ? 'allowed' : 'refused'),
    // The browser role, remembered per preview profile; the "role dialog" is a confirm().
    'app.isDefaultBrowser': () => localStorage.getItem(DEFAULT_BROWSER_KEY) === 'true',
    'app.requestDefaultBrowser': () => {
      const granted = window.confirm('Preview host: make Zenium the default browser?')
      localStorage.setItem(DEFAULT_BROWSER_KEY, granted ? 'true' : 'false')
      return granted
    },
    'net.fetch': async ({ url }) => {
      try {
        const res = await fetch(String(url))
        return { ok: res.ok, text: res.ok ? await res.text() : '' }
      } catch {
        return { ok: false, text: '' }
      }
    },
    'download.open': () => undefined,
    'profile.clear': () => undefined,
    'keys.setShortcuts': () => undefined,
    'window.setFullscreen': ({ fullscreen }) => {
      if (fullscreen) void document.documentElement.requestFullscreen?.()
      else void document.exitFullscreen?.()
      host().hostEvent('fullscreen', JSON.stringify({ fullscreen }))
    }
  }

  const run = (call: NativeCall): unknown => {
    const handler = handlers[call.method]
    if (!handler) return undefined
    return handler((call.args ?? {}) as Record<string, unknown>)
  }

  const finds = new WeakMap<HTMLIFrameElement, { text: string; matches: number; active: number }>()

  /** Match count and active ordinal for `text`, stepping through the matches on repeated calls. */
  function findInFrame(
    frame: HTMLIFrameElement,
    text: string,
    forward: boolean,
    newSession: boolean
  ): { activeMatchOrdinal: number; matches: number } {
    const needle = text.toLowerCase()
    if (!needle) {
      finds.delete(frame)
      return { activeMatchOrdinal: 0, matches: 0 }
    }
    const previous = finds.get(frame)
    const continuing = previous !== undefined && previous.text === needle && !newSession
    const matches = continuing ? previous.matches : countMatches(frame, needle)
    let active = 0
    if (matches > 0) {
      active = continuing ? ((previous.active - 1 + (forward ? 1 : matches - 1)) % matches) + 1 : 1
    }
    finds.set(frame, { text: needle, matches, active })
    return { activeMatchOrdinal: active, matches }
  }

  function countMatches(frame: HTMLIFrameElement, needle: string): number {
    let body: HTMLElement | null = null
    try {
      body = frame.contentDocument?.body ?? null
    } catch {
      /* cross-origin */
    }
    if (body) {
      const haystack = (body.innerText || body.textContent || '').toLowerCase()
      let count = 0
      for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1))
        count++
      return count
    }
    let hash = 0
    for (const ch of needle) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
    return hash % 10
  }

  const snapshots = new WeakMap<HTMLIFrameElement, { key: string; data: string | null }>()

  /**
   * The preview's stand-in for the hosts' page capture: same-origin frames are serialised into an
   * SVG `<foreignObject>` and rasterised (inline styles only – the image cannot fetch resources).
   * Cross-origin frames cannot be read and yield `null`, like a hidden page on a real host.
   * Rasterising is the expensive part, so an unchanged document reuses its last capture.
   */
  async function snapshotFrame(frame: HTMLIFrameElement): Promise<string | null> {
    let doc: Document | null
    try {
      doc = frame.contentDocument
    } catch {
      return null
    }
    const root = doc?.documentElement
    const width = frame.clientWidth
    const height = frame.clientHeight
    if (!root || !width || !height) return null
    const clone = root.cloneNode(true) as HTMLElement
    clone.querySelectorAll('script').forEach((s) => s.remove())
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
    const markup = new XMLSerializer().serializeToString(clone)
    const key = `${width}x${height}:${markup}`
    const cached = snapshots.get(frame)
    if (cached && cached.key === key) return cached.data
    const data = await rasterise(markup, width, height, frame.style.background)
    snapshots.set(frame, { key, data })
    return data
  }

  async function rasterise(
    markup: string,
    width: number,
    height: number,
    background: string
  ): Promise<string | null> {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`
    // A data: URL, not a blob: one – the chrome's CSP only lets images come from data:/http(s).
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('snapshot failed'))
        img.src = url
      })
      const scale = width > 1400 ? 1400 / width : 0.5
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.fillStyle = background || '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(scale, scale)
      ctx.drawImage(image, 0, 0)
      return canvas.toDataURL('image/jpeg', 0.7)
    } catch {
      return null
    }
  }

  return {
    call(json) {
      const call = JSON.parse(json) as NativeCall
      Promise.resolve()
        .then(() => run(call))
        .then(
          (result) => host().resolve(call.id, result === undefined ? null : JSON.stringify(result)),
          (error: unknown) =>
            host().reject(call.id, error instanceof Error ? error.message : String(error))
        )
    },
    callSync(json) {
      const result = run(JSON.parse(json) as NativeCall)
      return result === undefined ? '' : JSON.stringify(result)
    }
  }
}

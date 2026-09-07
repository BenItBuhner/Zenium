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

  const handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {
    boot: (): BootInfo => ({
      version: 'preview',
      files,
      downloadsDir: '/Downloads',
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      fullscreen: false
    }),
    'storage.write': ({ name, text }) =>
      localStorage.setItem(STORAGE_PREFIX + String(name), String(text)),
    'storage.writeSync': ({ name, text }) =>
      localStorage.setItem(STORAGE_PREFIX + String(name), String(text)),
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
      viewEvent(String(tabId), 'startLoading', null)
      frame.src = String(url)
      viewEvent(String(tabId), 'navigated', { ...navState(frame), inPage: false })
    },
    'view.loadHtml': ({ tabId, url, html }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      frame.dataset.url = String(url)
      frame.srcdoc = String(html)
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
    'view.snapshot': () => null,
    'view.eval': () => {
      throw new Error('not available in the preview host')
    },
    'view.savePage': () => null,
    'view.screenshot': () => null,
    'dialog.confirm': ({ message, detail }) => window.confirm(`${message}\n\n${detail ?? ''}`),
    'clipboard.writeText': ({ text }) => void navigator.clipboard?.writeText(String(text)),
    'clipboard.writeImage': () => false,
    'app.openExternal': ({ url }) => void window.open(String(url), '_blank'),
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

import { getDomain } from './url'

/**
 * Runs inside every web page. It implements the click behaviours Zen adds on top of the engine:
 *  - Glance: modifier+click on a link previews it in a floating overlay.
 *  - Pinned/Essential tabs: plain clicks on third-party links open in their own tab.
 *  - Media: reports play/pause so hosts without native audio events can show the media player.
 *
 * The transport is injected: Electron's preload uses `ipcRenderer`, Android a `WebMessageListener`.
 * No page-visible globals are created by this module itself.
 */
export interface PageScriptFlags {
  glanceEnabled: boolean
  glanceTrigger: 'alt' | 'ctrl' | 'shift'
  thirdParty: 'new-tab' | 'glance' | 'same-tab' | null
}

export interface PageScriptMessage {
  type: 'glance' | 'open-tab' | 'navigate' | 'media'
  url?: string
  x?: number
  y?: number
  background?: boolean
  playing?: boolean
}

export interface PageScriptTransport {
  send(message: PageScriptMessage): void
  onFlags(listener: (flags: PageScriptFlags) => void): void
  /** Hosts without native audio-state events ask for media tracking. */
  trackMedia?: boolean
}

export const DEFAULT_PAGE_FLAGS: PageScriptFlags = {
  glanceEnabled: true,
  glanceTrigger: 'alt',
  thirdParty: null
}

export function installPageScript(transport: PageScriptTransport): void {
  let flags: PageScriptFlags = { ...DEFAULT_PAGE_FLAGS }
  transport.onFlags((next) => {
    flags = next
  })

  const findAnchor = (target: EventTarget | null): HTMLAnchorElement | null => {
    let el = target as Element | null
    while (el && el !== document.documentElement) {
      if (el instanceof HTMLAnchorElement && el.href) return el
      el = el.parentElement
    }
    return null
  }

  const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url)

  const triggerHeld = (e: MouseEvent): boolean => {
    switch (flags.glanceTrigger) {
      case 'alt':
        return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
      case 'ctrl':
        return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
      case 'shift':
        return e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
    }
  }

  window.addEventListener(
    'click',
    (e) => {
      if (e.defaultPrevented || e.button !== 0) return
      const anchor = findAnchor(e.target)
      if (!anchor) return
      const href = anchor.href
      if (!isHttpUrl(href)) return
      // Don't hijack in-page fragment navigation or explicit download links.
      if (anchor.hasAttribute('download')) return
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && selection.toString().trim()) return

      const x = e.clientX / Math.max(1, window.innerWidth)
      const y = e.clientY / Math.max(1, window.innerHeight)
      if (flags.glanceEnabled && triggerHeld(e)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        transport.send({ type: 'glance', url: href, x, y })
        return
      }

      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
      if (plain && flags.thirdParty && flags.thirdParty !== 'same-tab') {
        const target = anchor.target
        if (target && target !== '_self' && target !== '_top' && target !== '_parent') return
        if (getDomain(href) !== getDomain(location.href)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          transport.send({
            type: flags.thirdParty === 'glance' ? 'glance' : 'open-tab',
            url: href,
            x,
            y
          })
        }
      }
    },
    true
  )

  if (transport.trackMedia) {
    let lastPlaying: boolean | null = null
    const report = (): void => {
      const playing = [...document.querySelectorAll('video,audio')].some(
        (m) => !(m as HTMLMediaElement).paused && !(m as HTMLMediaElement).muted
      )
      if (playing !== lastPlaying) {
        lastPlaying = playing
        transport.send({ type: 'media', playing })
      }
    }
    for (const type of ['play', 'playing', 'pause', 'ended', 'volumechange', 'emptied'])
      document.addEventListener(type, report, true)
    window.addEventListener('pagehide', () => {
      if (lastPlaying) {
        lastPlaying = false
        transport.send({ type: 'media', playing: false })
      }
    })
  }
}

import { getDomain } from './url'
import {
  INTERSTITIAL_ACTIONS,
  INTERSTITIAL_MESSAGE_KEY,
  type InterstitialAction,
  type InterstitialMessage
} from './interstitial'

/**
 * Runs inside every web page. It implements the click behaviours Zen adds on top of the engine:
 *  - Glance: modifier+click on a link previews it in a floating overlay.
 *  - Pinned/Essential tabs: plain clicks on third-party links open in their own tab.
 *  - Media: reports play/pause so hosts without native audio events can show the media player.
 *  - Boosts "zap element": pick an element to hide it on this site for good.
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
  type:
    | 'glance'
    | 'open-tab'
    | 'navigate'
    | 'media'
    | 'zap'
    | 'activation'
    | 'popup-blocked'
    | 'interstitial'
    | 'focus'
  url?: string
  x?: number
  y?: number
  background?: boolean
  playing?: boolean
  /** `zap`: CSS selector of the element the user picked. */
  selector?: string
  /** `interstitial`: the button pressed on a Zenium warning page (`zen://error`). */
  action?: InterstitialAction
}

export interface PageScriptTransport {
  send(message: PageScriptMessage): void
  onFlags(listener: (flags: PageScriptFlags) => void): void
  /** Boost zap mode toggled by the browser. */
  onZap?(listener: (on: boolean) => void): void
  /** Hosts without native audio-state events ask for media tracking. */
  trackMedia?: boolean
  /**
   * Hosts whose engine blocks pop-ups itself (the Android WebView) learn which URLs it refused:
   * the script runs in the page's world there and can watch `window.open` return null.
   */
  reportBlockedPopups?: boolean
}

/** Keys that never count as a gesture in Chromium's user-activation model. */
const NON_ACTIVATING_KEYS = new Set(['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'AltGraph'])

/** Consecutive activation reports closer than this are dropped (the clock only needs freshness). */
const ACTIVATION_REPORT_INTERVAL_MS = 250

/** Whether a DOM event grants user activation (trusted press, tap or non-modifier key). */
export function isActivatingEvent(e: Event): boolean {
  if (!e.isTrusted) return false
  switch (e.type) {
    case 'pointerdown':
    case 'mousedown':
    case 'touchend':
      return true
    case 'keydown':
      return !NON_ACTIVATING_KEYS.has((e as KeyboardEvent).key)
    default:
      return false
  }
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

  const zap = installZap(transport)
  installActivationReporter(transport)
  if (transport.reportBlockedPopups) installPopupObserver(transport)
  installInterstitialRelay(transport)

  window.addEventListener(
    'click',
    (e) => {
      if (zap.active()) return
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

// ---------------------------------------------------------------------------
// Pop-up blocker: user activation and blocked window.open calls
// ---------------------------------------------------------------------------

/**
 * Tells the browser when the user interacts with the page, so a `window.open` that follows can be
 * told apart from one the page fired on its own. Trusted events only; `navigator.userActivation`
 * (where the engine has it) is consulted as well so a gesture the listeners missed still counts.
 */
function installActivationReporter(transport: PageScriptTransport): void {
  let lastSent = -Infinity
  const report = (): void => {
    const now = Date.now()
    if (now - lastSent < ACTIVATION_REPORT_INTERVAL_MS) return
    lastSent = now
    transport.send({ type: 'activation' })
  }
  const onEvent = (e: Event): void => {
    if (isActivatingEvent(e)) report()
  }
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchend'])
    window.addEventListener(type, onEvent, { capture: true, passive: true })
  // Focus changes ride on gestures too (a tap that lands on a control); consult the engine.
  window.addEventListener(
    'focusin',
    () => {
      const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation
      if (ua?.isActive) report()
    },
    true
  )
}

/**
 * Watches `window.open`: when the engine returns null while the page has no user activation the
 * pop-up was blocked, and the browser lists it so the user can open it anyway. A null result
 * during activation is a `noopener` window that did open, not a block.
 */
function installPopupObserver(transport: PageScriptTransport): void {
  const nativeOpen = window.open
  const resolve = (url: unknown): string => {
    const text = url === undefined || url === null ? '' : String(url)
    try {
      return new URL(text, document.baseURI).href
    } catch {
      return text
    }
  }
  const observed = function (
    this: Window | undefined,
    url?: string | URL,
    target?: string,
    features?: string
  ): Window | null {
    const result = nativeOpen.call(this ?? window, url, target, features)
    if (result === null) {
      const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation
      if (!ua?.isActive) transport.send({ type: 'popup-blocked', url: resolve(url) })
    }
    return result
  }
  try {
    Object.defineProperty(window, 'open', { value: observed, configurable: true, writable: true })
  } catch {
    /* a frozen window object keeps the engine's open; the blocker still blocks */
  }
}

// ---------------------------------------------------------------------------
// Boosts: zap element
// ---------------------------------------------------------------------------

const STABLE_CLASS = /^[a-zA-Z][a-zA-Z0-9_-]{1,40}$/
const UNSTABLE_CLASS = /(^|[-_])(\d{2,}|[a-f0-9]{5,})([-_]|$)|^css-|^sc-|^jsx-|^_/

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(s)
    : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

/**
 * The interstitials (`zen://error?kind=…`) post their button presses on the window; only a
 * document of Zenium's own scheme may relay them, so a web page cannot except itself from Safe
 * Browsing or HTTPS-only mode by posting the same message. The core still checks the URL against
 * the block it is holding for the tab.
 */
function installInterstitialRelay(transport: PageScriptTransport): void {
  if (location.protocol !== 'zen:') return
  const actions = new Set<string>(INTERSTITIAL_ACTIONS)
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return
    const data = e.data as { [INTERSTITIAL_MESSAGE_KEY]?: Partial<InterstitialMessage> } | null
    const message = data && typeof data === 'object' ? data[INTERSTITIAL_MESSAGE_KEY] : undefined
    if (!message || typeof message !== 'object') return
    const { action, url } = message
    if (typeof action !== 'string' || !actions.has(action) || typeof url !== 'string') return
    transport.send({ type: 'interstitial', action: action as InterstitialAction, url })
  })
}

/** A selector that matches exactly this element and is likely to survive re-renders. */
export function selectorFor(el: Element): string {
  if (el.id && !/\d{3,}/.test(el.id)) {
    const s = `#${cssEscape(el.id)}`
    if (document.querySelectorAll(s).length === 1) return s
  }
  const parts: string[] = []
  let cur: Element | null = el
  let depth = 0
  while (cur && cur !== document.documentElement && depth < 6) {
    let part = cur.tagName.toLowerCase()
    const classes = [...cur.classList]
      .filter((c) => STABLE_CLASS.test(c) && !UNSTABLE_CLASS.test(c))
      .slice(0, 3)
    if (cur.id && !/\d{3,}/.test(cur.id)) {
      parts.unshift(`#${cssEscape(cur.id)}`)
      break
    }
    if (classes.length) part += classes.map((c) => `.${cssEscape(c)}`).join('')
    else {
      const role = cur.getAttribute('role')
      const label = cur.getAttribute('aria-label')
      if (role) part += `[role="${role.replace(/"/g, '\\"')}"]`
      else if (label && label.length < 40) part += `[aria-label="${label.replace(/"/g, '\\"')}"]`
    }
    const parent = cur.parentElement
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      if (siblings.length > 1 && !classes.length)
        part += `:nth-of-type(${siblings.indexOf(cur) + 1})`
    }
    parts.unshift(part)
    const candidate = parts.join(' > ')
    if (document.querySelectorAll(candidate).length === 1) return candidate
    cur = parent
    depth++
  }
  return parts.join(' > ')
}

function installZap(transport: PageScriptTransport): { active: () => boolean } {
  let zapping = false
  let highlight: HTMLDivElement | null = null
  let hovered: Element | null = null

  const ensureHighlight = (): HTMLDivElement => {
    if (highlight && highlight.isConnected) return highlight
    highlight = document.createElement('div')
    highlight.setAttribute('aria-hidden', 'true')
    Object.assign(highlight.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483647',
      border: '2px solid #ff4f9a',
      background: 'rgba(255, 79, 154, 0.18)',
      borderRadius: '6px',
      boxShadow: '0 0 0 2px rgba(255,255,255,.6)',
      transition: 'all 60ms ease-out',
      left: '0',
      top: '0',
      width: '0',
      height: '0'
    })
    document.documentElement.appendChild(highlight)
    return highlight
  }

  const onMove = (e: MouseEvent): void => {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || el === highlight || el === document.documentElement || el === document.body) return
    hovered = el
    const r = el.getBoundingClientRect()
    const h = ensureHighlight()
    h.style.left = `${r.left - 2}px`
    h.style.top = `${r.top - 2}px`
    h.style.width = `${r.width + 4}px`
    h.style.height = `${r.height + 4}px`
  }

  const swallow = (e: Event): void => {
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  const stop = (): void => {
    if (!zapping) return
    zapping = false
    document.documentElement.style.cursor = ''
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('pointerdown', onMove, true)
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('mousedown', swallow, true)
    window.removeEventListener('mouseup', swallow, true)
    highlight?.remove()
    highlight = null
    hovered = null
  }

  const onClick = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopImmediatePropagation()
    const el = hovered ?? (document.elementFromPoint(e.clientX, e.clientY) as Element | null)
    if (!el) return
    const selector = selectorFor(el)
    stop()
    transport.send({ type: 'zap', selector })
  }

  const start = (): void => {
    if (zapping) return
    zapping = true
    ensureHighlight()
    document.documentElement.style.cursor = 'crosshair'
    window.addEventListener('mousemove', onMove, true)
    // Touch has no hover: highlight the element under the finger before the click lands.
    window.addEventListener('pointerdown', onMove, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('mousedown', swallow, true)
    window.addEventListener('mouseup', swallow, true)
  }

  transport.onZap?.((on) => (on ? start() : stop()))
  return { active: () => zapping }
}

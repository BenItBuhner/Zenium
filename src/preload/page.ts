import { ipcRenderer } from 'electron'
import { getDomain } from '../shared/url'

/**
 * Runs inside every web page (isolated world). It implements the click behaviours Zen adds on top
 * of the engine:
 *  - Glance: modifier+click on a link previews it in a floating overlay.
 *  - Pinned/Essential tabs: plain clicks on third-party links open in their own tab.
 *  - Boosts "zap element": pick an element to hide it on this site for good.
 * No page-visible globals are created.
 */
interface Flags {
  glanceEnabled: boolean
  glanceTrigger: 'alt' | 'ctrl' | 'shift'
  thirdParty: 'new-tab' | 'glance' | 'same-tab' | null
}

let flags: Flags = { glanceEnabled: true, glanceTrigger: 'alt', thirdParty: null }

ipcRenderer.on('zen:page-flags', (_event, next: Flags) => {
  flags = next
})

function findAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  let el = target as Element | null
  while (el && el !== document.documentElement) {
    if (el instanceof HTMLAnchorElement && el.href) return el
    el = el.parentElement
  }
  return null
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function triggerHeld(e: MouseEvent): boolean {
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
    if (zapping) return
    if (e.defaultPrevented || e.button !== 0) return
    const anchor = findAnchor(e.target)
    if (!anchor) return
    const href = anchor.href
    if (!isHttpUrl(href)) return
    // Don't hijack in-page fragment navigation or explicit download links.
    if (anchor.hasAttribute('download')) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim()) return

    if (flags.glanceEnabled && triggerHeld(e)) {
      e.preventDefault()
      e.stopImmediatePropagation()
      ipcRenderer.send('zen:page', {
        type: 'glance',
        url: href,
        x: e.clientX / Math.max(1, window.innerWidth),
        y: e.clientY / Math.max(1, window.innerHeight)
      })
      return
    }

    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
    if (plain && flags.thirdParty && flags.thirdParty !== 'same-tab') {
      const target = anchor.target
      if (target && target !== '_self' && target !== '_top' && target !== '_parent') return
      if (getDomain(href) !== getDomain(location.href)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        ipcRenderer.send('zen:page', {
          type: flags.thirdParty === 'glance' ? 'glance' : 'open-tab',
          url: href,
          x: e.clientX / Math.max(1, window.innerWidth),
          y: e.clientY / Math.max(1, window.innerHeight)
        })
      }
    }
  },
  true
)

// ---------------------------------------------------------------------------
// Boosts: zap element
// ---------------------------------------------------------------------------

let zapping = false
let highlight: HTMLDivElement | null = null
let hovered: Element | null = null

const STABLE_CLASS = /^[a-zA-Z][a-zA-Z0-9_-]{1,40}$/
const UNSTABLE_CLASS = /(^|[-_])(\d{2,}|[a-f0-9]{5,})([-_]|$)|^css-|^sc-|^jsx-|^_/

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(s)
    : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

/** A selector that matches exactly this element and is likely to survive re-renders. */
function selectorFor(el: Element): string {
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

function ensureHighlight(): HTMLDivElement {
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

function onZapMove(e: MouseEvent): void {
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

function onZapClick(e: MouseEvent): void {
  e.preventDefault()
  e.stopImmediatePropagation()
  const el = hovered ?? (document.elementFromPoint(e.clientX, e.clientY) as Element | null)
  if (!el) return
  const selector = selectorFor(el)
  stopZap()
  ipcRenderer.send('zen:page', { type: 'zap', selector })
}

function swallow(e: Event): void {
  e.preventDefault()
  e.stopImmediatePropagation()
}

function startZap(): void {
  if (zapping) return
  zapping = true
  ensureHighlight()
  document.documentElement.style.cursor = 'crosshair'
  window.addEventListener('mousemove', onZapMove, true)
  window.addEventListener('click', onZapClick, true)
  window.addEventListener('mousedown', swallow, true)
  window.addEventListener('mouseup', swallow, true)
}

function stopZap(): void {
  if (!zapping) return
  zapping = false
  document.documentElement.style.cursor = ''
  window.removeEventListener('mousemove', onZapMove, true)
  window.removeEventListener('click', onZapClick, true)
  window.removeEventListener('mousedown', swallow, true)
  window.removeEventListener('mouseup', swallow, true)
  highlight?.remove()
  highlight = null
  hovered = null
}

ipcRenderer.on('zen:zap', (_event, on: boolean) => {
  if (on) startZap()
  else stopZap()
})

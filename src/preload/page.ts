import { ipcRenderer } from 'electron'
import { getDomain } from '../shared/url'

/**
 * Runs inside every web page (isolated world). It implements the click behaviours Zen adds on top
 * of the engine:
 *  - Glance: modifier+click on a link previews it in a floating overlay.
 *  - Pinned/Essential tabs: plain clicks on third-party links open in their own tab.
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

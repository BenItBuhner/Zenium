import { HINT_FADE_MS, hintPalette, type PageHint } from './fullscreenHint'

/*
 * The fullscreen hint as the page script draws it: a v2 toast (radius 8, a 1px border, the
 * panel colour, 15px text) centred at the top of the page, in the top layer so it stands over
 * the element in fullscreen, fading in and – after its time – out. It lives in a closed shadow
 * root on a tag of its own so the page's styles do not reach it, and every style is set through
 * the CSSOM so a page's content security policy has nothing to refuse.
 */

const HOST_TAG = 'zenium-fullscreen-hint'
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, sans-serif'

/** Where hints go: the document element, so a page that replaces its body leaves them alone. */
function mount(): Element {
  return document.documentElement
}

/** The hint's element for `hint`, styled and ready to be shown. */
export function renderHint(hint: PageHint): HTMLElement {
  const palette = hintPalette(hint.dark)
  const host = document.createElement(HOST_TAG)
  host.setAttribute('role', 'status')
  host.setAttribute('aria-live', 'polite')
  // `popover` puts the hint in the top layer, above an element in fullscreen; the manual kind
  // stays until it is hidden. Browsers without it show the hint as a fixed element instead.
  host.setAttribute('popover', 'manual')
  Object.assign(host.style, {
    position: 'fixed',
    inset: 'auto',
    top: '24px',
    left: '0',
    right: '0',
    margin: '0 auto',
    width: 'fit-content',
    maxWidth: 'calc(100vw - 48px)',
    height: 'auto',
    padding: '0',
    border: '0',
    background: 'transparent',
    overflow: 'visible',
    color: palette.text,
    zIndex: '2147483647',
    pointerEvents: 'none',
    opacity: '0',
    transition: `opacity ${HINT_FADE_MS}ms ease`
  })
  const root = host.attachShadow({ mode: 'closed' })
  const panel = document.createElement('div')
  Object.assign(panel.style, {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    padding: '10px 16px',
    borderRadius: '8px',
    border: `1px solid ${palette.border}`,
    background: palette.panel,
    color: palette.text,
    boxShadow: '0 2px 6px rgb(0 0 0 / 0.2)',
    font: `15px/1.4 ${FONT}`,
    textAlign: 'center',
    whiteSpace: 'nowrap'
  })
  if (hint.text) {
    const line = document.createElement('div')
    line.textContent = hint.text
    panel.appendChild(line)
  }
  if (hint.exit) {
    const line = document.createElement('div')
    Object.assign(line.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      opacity: hint.text ? '0.69' : '1'
    })
    if (hint.exit.before) line.appendChild(document.createTextNode(hint.exit.before))
    const key = document.createElement('kbd')
    key.textContent = hint.exit.key
    Object.assign(key.style, {
      display: 'inline-flex',
      alignItems: 'center',
      height: '20px',
      padding: '0 6px',
      borderRadius: '4px',
      border: `1px solid ${palette.border}`,
      background: palette.fill,
      font: `11px/1 ${FONT}`,
      color: palette.text
    })
    line.appendChild(key)
    if (hint.exit.after) line.appendChild(document.createTextNode(hint.exit.after))
    panel.appendChild(line)
  }
  root.appendChild(panel)
  return host
}

/** The page's hint, one at a time: a new hint replaces the one standing, null takes it down. */
export function installHint(onHint: (listener: (hint: PageHint | null) => void) => void): void {
  let current: HTMLElement | null = null
  let fade: ReturnType<typeof setTimeout> | null = null
  let gone: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (fade !== null) clearTimeout(fade)
    if (gone !== null) clearTimeout(gone)
    fade = null
    gone = null
  }
  const remove = (): void => {
    clearTimers()
    const el = current
    current = null
    if (!el) return
    if ('hidePopover' in el && el.isConnected) {
      try {
        el.hidePopover()
      } catch {
        /* not showing */
      }
    }
    el.remove()
  }
  const show = (hint: PageHint): void => {
    remove()
    const el = renderHint(hint)
    current = el
    mount().appendChild(el)
    if ('showPopover' in el) {
      try {
        el.showPopover()
      } catch {
        /* a document that cannot show popovers keeps the fixed element */
      }
    }
    // Two frames so the transition starts from the hidden state.
    requestAnimationFrame(() => requestAnimationFrame(() => (el.style.opacity = '1')))
    fade = setTimeout(() => {
      el.style.opacity = '0'
      gone = setTimeout(() => {
        if (current === el) remove()
      }, HINT_FADE_MS)
    }, hint.duration)
  }

  onHint((hint) => (hint ? show(hint) : remove()))
}

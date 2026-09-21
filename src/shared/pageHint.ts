import {
  HINT_BUBBLE_HEIGHT_PX,
  HINT_BUBBLE_TOP_PX,
  HINT_FADE_MS,
  hintPalette,
  type PageHint
} from './fullscreenHint'
import {
  isAtRest,
  SPRING_GENTLE,
  SPRING_SNAPPY,
  stepSpring,
  type SpringConfig,
  type SpringState
} from './spring'
import { REDUCED_FADE_MS, TOAST_CARD } from './toastCard'

/*
 * The fullscreen hint as the page script draws it: a v2 panel pill (§9.20: radius 8, a 1px
 * border, the panel colour, one 15/20 line, 32 tall) centred at the top of the page, in the top
 * layer so it stands over the element in fullscreen, fading in and – after its time – out. It
 * has no button and takes no focus (`role="status"`). It lives in a closed shadow
 * root on a tag of its own so the page's styles do not reach it, and every style is set through
 * the CSSOM so a page's content security policy has nothing to refuse.
 *
 * The `toast` kind is the phone chrome's message card instead (v2 §9.33, `ToastCard`'s
 * `.zen-message` metrics, one source with it in `toastCard.ts`: a 44 px row 8 px inside the
 * edges, 15/20 text at the body weight, the panel, the hairline, the card radius and shadow)
 * along the bottom edge, moving as the chrome's toasts move (`useMessageMotion`): in across the
 * edge on `SPRING_GENTLE`, out on `SPRING_SNAPPY` thinning with its travel, a 120 ms fade in
 * place under reduced motion (§11.3). The springs are the shared ones, stepped per frame here,
 * since the page's CSS transitions could not carry them.
 */

const HOST_TAG = 'zenium-fullscreen-hint'
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, sans-serif'

/** The toast's inset from the frame's edges (§9.33) and its row height: the chrome's card's. */
export const TOAST_INSET_PX = TOAST_CARD.insetPx
export const TOAST_ROW_PX = TOAST_CARD.rowPx
/** The fade an appearance or departure becomes under reduced motion (§11.3): the chrome's. */
export const TOAST_REDUCED_FADE_MS = REDUCED_FADE_MS

/** Where hints go: the document element, so a page that replaces its body leaves them alone. */
function mount(): Element {
  return document.documentElement
}

/** Whether the page's user asked for reduced motion (the chrome's toasts fade in place then). */
function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** The hint's element for `hint`, styled and ready to be shown. */
export function renderHint(hint: PageHint): HTMLElement {
  const palette = hintPalette(hint.dark)
  const toast = hint.kind === 'toast'
  const host = document.createElement(HOST_TAG)
  host.setAttribute('role', 'status')
  host.setAttribute('aria-live', 'polite')
  // `popover` puts the hint in the top layer, above an element in fullscreen; the manual kind
  // stays until it is hidden. Browsers without it show the hint as a fixed element instead.
  host.setAttribute('popover', 'manual')
  Object.assign(host.style, {
    position: 'fixed',
    inset: 'auto',
    top: toast ? 'auto' : `${HINT_BUBBLE_TOP_PX}px`,
    bottom: toast ? `calc(${TOAST_INSET_PX}px + env(safe-area-inset-bottom, 0px))` : 'auto',
    left: toast ? `${TOAST_INSET_PX}px` : '0',
    right: toast ? `${TOAST_INSET_PX}px` : '0',
    margin: '0 auto',
    width: toast ? 'auto' : 'fit-content',
    maxWidth: toast ? 'none' : 'calc(100vw - 48px)',
    height: 'auto',
    padding: '0',
    border: '0',
    background: 'transparent',
    overflow: 'visible',
    color: palette.text,
    zIndex: '2147483647',
    pointerEvents: 'none',
    opacity: '0',
    // The bubble fades on a transition; the toast is moved per frame (`installHint`).
    transition: toast ? 'none' : `opacity ${HINT_FADE_MS}ms ease`
  })
  const root = host.attachShadow({ mode: 'closed' })
  const panel = document.createElement('div')
  // The bubble is one row: 32 tall, 12 from its edge to the text's box, the body type (15/20).
  const bubblePad = (HINT_BUBBLE_HEIGHT_PX - TOAST_CARD.linePx) / 2 - 1
  Object.assign(panel.style, {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: toast ? `${TOAST_CARD.gapPx}px` : '4px',
    boxSizing: 'border-box',
    minHeight: toast ? `${TOAST_ROW_PX}px` : `${HINT_BUBBLE_HEIGHT_PX}px`,
    padding: toast ? `${TOAST_CARD.padPx}px ${TOAST_CARD.gutterPx}px` : `${bubblePad}px 12px`,
    borderRadius: `${TOAST_CARD.radiusPx}px`,
    border: `1px solid ${palette.border}`,
    background: palette.panel,
    color: palette.text,
    boxShadow: TOAST_CARD.shadow,
    font: `${TOAST_CARD.weight} ${TOAST_CARD.fontPx}px/${TOAST_CARD.linePx}px ${FONT}`,
    textAlign: toast ? 'left' : 'center',
    whiteSpace: toast ? 'normal' : 'nowrap',
    overflowWrap: 'anywhere'
  })
  if (hint.text) {
    const line = document.createElement('div')
    line.textContent = hint.text
    if (toast) line.style.flex = '1 1 auto'
    panel.appendChild(line)
  }
  if (hint.exit) {
    // A flex row of its own, the body line tall: an inline box around the key cap would add
    // baseline slack under it and grow the pill past its 32.
    const line = document.createElement('div')
    Object.assign(line.style, {
      display: 'flex',
      alignItems: 'center',
      height: `${TOAST_CARD.linePx}px`,
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

/** A motion under way (a spring or a fade); calling it stops the motion where it is. */
type Cancel = () => void

function frame(cb: (now: number) => void): number {
  return requestAnimationFrame(cb)
}

/**
 * Run `config`'s spring from `from` to `target` (px), `onFrame` with every position and `done`
 * once at rest – the chrome's `SpringAnimation` in a page's clothes. Frames longer than 64 ms
 * (a stall) are stepped as 64 ms so the spring does not leap.
 */
export function springTo(
  from: number,
  target: number,
  config: SpringConfig,
  onFrame: (x: number) => void,
  done: () => void
): Cancel {
  let state: SpringState = { x: from, v: 0 }
  let last: number | null = null
  let handle = frame(function step(now) {
    const dt = last === null ? 1 / 60 : Math.min(0.064, Math.max(0.001, (now - last) / 1000))
    last = now
    state = stepSpring(state, target, dt, config)
    onFrame(state.x)
    if (isAtRest(state, target)) done()
    else handle = frame(step)
  })
  return () => cancelAnimationFrame(handle)
}

/** Fade `el` from `from` to `to` over `ms`, per frame (§11.3's fade in place). */
export function fadeTo(
  el: HTMLElement,
  from: number,
  to: number,
  ms: number,
  done: () => void
): Cancel {
  const startedAt = performance.now()
  el.style.opacity = from.toFixed(3)
  let handle = frame(function step(now) {
    const t = Math.min(1, (now - startedAt) / ms)
    el.style.opacity = (from + (to - from) * t).toFixed(3)
    if (t >= 1) done()
    else handle = frame(step)
  })
  return () => cancelAnimationFrame(handle)
}

/** How much of the toast is still present `y` px into its `reach` (the chrome's `dismissPresence`). */
export function toastPresence(y: number, reach: number): number {
  if (reach <= 0) return 1
  return Math.min(1, Math.max(0, 1 - Math.abs(y) / reach))
}

/** The page's hint, one at a time: a new hint replaces the one standing, null takes it down. */
export function installHint(onHint: (listener: (hint: PageHint | null) => void) => void): void {
  let current: HTMLElement | null = null
  let stand: ReturnType<typeof setTimeout> | null = null
  let gone: ReturnType<typeof setTimeout> | null = null
  let motion: Cancel | null = null

  const clearTimers = (): void => {
    if (stand !== null) clearTimeout(stand)
    if (gone !== null) clearTimeout(gone)
    stand = null
    gone = null
    motion?.()
    motion = null
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

  /** The bubble: a fade in, its stand, a fade out. */
  const showBubble = (el: HTMLElement, hint: PageHint): void => {
    // Two frames so the transition starts from the hidden state.
    requestAnimationFrame(() => requestAnimationFrame(() => (el.style.opacity = '1')))
    stand = setTimeout(() => {
      el.style.opacity = '0'
      gone = setTimeout(() => {
        if (current === el) remove()
      }, HINT_FADE_MS)
    }, hint.duration)
  }

  /**
   * The toast: in from below its edge on the gentle spring, its stand, out on the snappy one
   * thinning with its travel; a fade in place either way under reduced motion. `will-change`
   * only while it moves (§9.33).
   */
  const showToast = (el: HTMLElement, hint: PageHint): void => {
    const leaveWith = (leave: (done: () => void) => Cancel): void => {
      stand = setTimeout(() => {
        stand = null
        motion?.()
        motion = leave(() => {
          motion = null
          if (current === el) remove()
        })
      }, hint.duration)
    }
    if (reducedMotion()) {
      motion = fadeTo(el, 0, 1, TOAST_REDUCED_FADE_MS, () => (motion = null))
      leaveWith((done) =>
        fadeTo(el, Number.parseFloat(el.style.opacity) || 1, 0, TOAST_REDUCED_FADE_MS, done)
      )
      return
    }
    // A card's length past its edge, the inset included (the chrome's `reach`).
    const reach = Math.max(1, el.offsetHeight + TOAST_INSET_PX)
    let y = reach
    const place = (to: number): void => {
      y = to
      el.style.transform = `translateY(${to.toFixed(2)}px)`
    }
    const moving = (on: boolean): void => {
      el.style.willChange = on ? 'transform, opacity' : ''
    }
    place(reach)
    el.style.opacity = '1'
    moving(true)
    motion = springTo(reach, 0, SPRING_GENTLE, place, () => {
      motion = null
      moving(false)
    })
    leaveWith((done) => {
      moving(true)
      return springTo(
        y,
        reach,
        SPRING_SNAPPY,
        (to) => {
          place(to)
          el.style.opacity = toastPresence(to, reach).toFixed(3)
        },
        done
      )
    })
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
    if (hint.kind === 'toast') showToast(el, hint)
    else showBubble(el, hint)
  }

  /**
   * The top layer paints in order of entry, so an element entering fullscreen after the hint
   * was shown would stand over it. The phone's hint is cued by the engine's view going up
   * (`Host.enterFullscreen`), which the page's own `fullscreenchange` may trail: a standing
   * hint is raised again as the element arrives – a manual popover hidden and shown lands on
   * top, its inline styles (the motion under way) untouched.
   */
  const raise = (): void => {
    const el = current
    if (!el || !el.isConnected || !inFullscreen()) return
    if (!('hidePopover' in el && 'showPopover' in el)) return
    try {
      el.hidePopover()
      el.showPopover()
    } catch {
      /* a document that cannot show popovers keeps the fixed element */
    }
  }
  document.addEventListener('fullscreenchange', raise, true)
  document.addEventListener('webkitfullscreenchange', raise, true)

  onHint((hint) => (hint ? show(hint) : remove()))
}

/** Whether the document has a fullscreen element, under either name the engines have given it. */
function inFullscreen(): boolean {
  const doc = document as Document & { webkitFullscreenElement?: Element | null }
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null
}

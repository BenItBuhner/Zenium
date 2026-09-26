import { hintPalette } from './fullscreenHint'
import { REDUCED_FADE_MS, TOAST_CARD } from './toastCard'
import type { QuitHoldState } from './types'

/*
 * "Hold ⌘Q to quit" (session-08, Chrome's confirm-quit panel) as the page script draws it: a
 * §9.23 title block standing alone as a notice panel – padding 16, the 16 px glyph slot on the
 * title's start with its 8 px gap holding the hold's progress ring, the title 17/600 at 22 with
 * the chord set as a key cap – on the v2 panel (`--v2-panel`, the 1 px `--v2-border`, the card
 * radius, the panel shadow, `--v2-text`), centred over the page, taking no pointer and no
 * focus (`role="status"`). It pops in on §11's 180 ms (opacity and a scale from .96, `--zen-ease`)
 * and fades out in 120 ms when a key comes up; under reduced motion both ways are the 120 ms
 * opacity fade in place (§11.3). The ring sweeps the same under either setting: it reads a key
 * the user is holding – input, not animation – and §11.3 removes springs and eases, not readouts
 * (the design lead's ruling on #486; a ring stepped at thirds told a user who asked for less
 * motion less truth about their own hold).
 *
 * Why the page draws it: on desktop the page's view lies over the chrome, and the chrome could
 * show a panel over the page only by hiding the view – which drops the page's key events, and
 * the hold is ended by the key coming UP in the very view the key went down in. So the page
 * paints the panel where it stands, as it paints the fullscreen hints (`pageHint.ts`; §9.33's
 * "only where the chrome physically cannot draw"): a closed shadow root on a tag of its own,
 * every style set through the CSSOM so a page's content security policy has nothing to refuse,
 * the chrome's tokens by value (`HINT_PALETTE`, pinned to the stylesheet by `v2Tokens.test.ts`).
 * The chrome draws the same block itself (`components/overlays/QuitHold.tsx`) where no live
 * page is in the frame; the two share these numbers and `quitHoldProgress`.
 */

/** The IPC channel the Electron host posts the panel (or null) into a page on (`TabView.showQuitHold` → `preload/page.ts`). */
export const QUIT_HOLD_CHANNEL = 'zen:quit-hold'

/** What the page needs to paint the panel: the hold, and the chrome's scheme and accent by value. */
export interface QuitHoldPanel extends QuitHoldState {
  /** The chrome's colour scheme, for the panel's inks. */
  dark: boolean
  /** The window's space accent (`#rrggbb`), which the ring mixes as `--v2-accent` does. */
  accent: string
}

/** The panel's geometry, one source for the page-drawn panel and the chrome's own. */
export const QUIT_HOLD_PANEL = {
  /** The title block's padding (§9.23). */
  padPx: 16,
  /** The title block's glyph slot, here the ring, and its gap to the title (§9.23). */
  glyphPx: 16,
  glyphGapPx: 8,
  ringStrokePx: 2,
  /**
   * The title (§4: `--v2-font-heading`, `--v2-line-heading`, `--v2-weight-heading`). The weight is
   * the heading token's base, which the chrome's twin reads as the token – `--v2-weight-heading`
   * adds the bold-text setting's adjustment (A11Y-05, `lib/textScale.ts`), a setting of the
   * Android host, whose page views draw no panel; on the desktop, where this panel is drawn, the
   * adjustment is 0 and both routes set the same 600. Pinned to the stylesheet by `v2Tokens.test.ts`.
   */
  titlePx: 17,
  titleLinePx: 22,
  titleWeight: 600,
  /** The chord's key cap: the title's line tall, 13/600 inside (the hint strip's key chips, §9.35). */
  keycapHeightPx: 22,
  keycapPadPx: 8,
  keycapRadiusPx: 6,
  keycapFontPx: 13,
  /** The card radius (`--v2-radius-card`) and the panel shadow (`--v2-shadow-panel`). */
  radiusPx: TOAST_CARD.radiusPx,
  shadow: TOAST_CARD.shadow,
  /** The pop in (§11: 180 ms, `--zen-ease`) and the fade out (120 ms; both ways under reduced motion). */
  popMs: 180,
  fadeMs: REDUCED_FADE_MS,
  ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  /** The panel's least distance from the frame's edges. */
  marginPx: 24
} as const

/**
 * The chrome's type family by value (`--font-sans`, `main.css`; pinned by `v2Tokens.test.ts`):
 * the page cannot read the chrome's stylesheet, and the twin the chrome draws sets the same
 * stack through the token, so the two routes shape their glyphs alike.
 */
export const QUIT_HOLD_FONT =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif"

/** The title's words around the key cap (§9.1: sentence case; Chrome's are "Hold ⌘Q to Quit"). */
export const QUIT_HOLD_TITLE = { before: 'Hold ', after: ' to quit' } as const

/** The title as one string, for the live region and the tests. */
export function quitHoldTitle(chord: string): string {
  return `${QUIT_HOLD_TITLE.before}${chord}${QUIT_HOLD_TITLE.after}`
}

/** The ring's ink: the chrome's `--v2-accent` mix of the space accent, by scheme. */
export function quitHoldAccent(accent: string, dark: boolean): string {
  return `color-mix(in srgb, ${accent} 40%, ${dark ? '#fff' : '#000'})`
}

/**
 * How far the hold has come at `now`, 0..1: linear over its duration, under either motion
 * setting – the ring is a readout of the key being held, not an animation (§11.3).
 */
export function quitHoldProgress(hold: QuitHoldState, now: number): number {
  const raw = hold.durationMs > 0 ? (now - hold.startedAt) / hold.durationMs : 1
  return Math.min(1, Math.max(0, raw))
}

const HOST_TAG = 'zenium-quit-hold'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** The ring's radius and circumference at the glyph size and stroke. */
export function quitHoldRing(): { radius: number; circumference: number } {
  const radius = (QUIT_HOLD_PANEL.glyphPx - QUIT_HOLD_PANEL.ringStrokePx) / 2
  return { radius, circumference: 2 * Math.PI * radius }
}

/** Where the panel goes: the document element, so a page that replaces its body leaves it alone. */
function mount(): Element {
  return document.documentElement
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * The panel's element, painted at progress 0 and transparent, with the ring's setter. The host
 * is the whole viewport as a grid with the panel at its centre, and it is the host that pops
 * and fades (a scale of the host about the viewport's centre is a scale of the centred panel
 * about its own), so the motion and the progress (`data-progress`, 0..1) can be read from
 * outside the closed root – by the tests, and by the drives from the page.
 */
export interface RenderedQuitHoldPanel {
  host: HTMLElement
  setProgress(p: number): void
}

export function renderQuitHoldPanel(hold: QuitHoldPanel): RenderedQuitHoldPanel {
  const palette = hintPalette(hold.dark)
  const g = QUIT_HOLD_PANEL
  const host = document.createElement(HOST_TAG)
  host.setAttribute('role', 'status')
  host.setAttribute('aria-live', 'polite')
  host.setAttribute('aria-label', quitHoldTitle(hold.chord))
  host.setAttribute('data-quit-hold', '')
  host.setAttribute('data-chord', hold.chord)
  // `popover` puts the panel in the top layer, above an element in fullscreen; the manual kind
  // stays until it is hidden. The user agent's popover box is undone: the host is the frame.
  host.setAttribute('popover', 'manual')
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    width: 'auto',
    height: 'auto',
    maxWidth: 'none',
    maxHeight: 'none',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    overflow: 'visible',
    display: 'grid',
    placeItems: 'center',
    color: palette.text,
    zIndex: '2147483647',
    pointerEvents: 'none',
    opacity: '0'
  })
  const root = host.attachShadow({ mode: 'closed' })

  const panel = document.createElement('div')
  panel.setAttribute('part', 'panel')
  Object.assign(panel.style, {
    display: 'flex',
    alignItems: 'center',
    gap: `${g.glyphGapPx}px`,
    boxSizing: 'border-box',
    maxWidth: `calc(100vw - ${2 * g.marginPx}px)`,
    padding: `${g.padPx}px`,
    borderRadius: `${g.radiusPx}px`,
    border: `1px solid ${palette.border}`,
    background: palette.panel,
    color: palette.text,
    boxShadow: g.shadow,
    font: `${g.titleWeight} ${g.titlePx}px/${g.titleLinePx}px ${QUIT_HOLD_FONT}`
  })

  // The ring in the glyph slot: the track in the hairline ink, the sweep in the accent, from
  // twelve o'clock. Drawn by `stroke-dashoffset`, which the setter moves.
  const { radius, circumference } = quitHoldRing()
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', `${g.glyphPx}`)
  svg.setAttribute('height', `${g.glyphPx}`)
  svg.setAttribute('viewBox', `0 0 ${g.glyphPx} ${g.glyphPx}`)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('data-ring', '')
  Object.assign(svg.style, { flex: 'none', display: 'block', transform: 'rotate(-90deg)' })
  const centre = `${g.glyphPx / 2}`
  const track = document.createElementNS(SVG_NS, 'circle')
  track.setAttribute('cx', centre)
  track.setAttribute('cy', centre)
  track.setAttribute('r', `${radius}`)
  track.setAttribute('fill', 'none')
  track.setAttribute('stroke', palette.border)
  track.setAttribute('stroke-width', `${g.ringStrokePx}`)
  const sweep = document.createElementNS(SVG_NS, 'circle')
  sweep.setAttribute('cx', centre)
  sweep.setAttribute('cy', centre)
  sweep.setAttribute('r', `${radius}`)
  sweep.setAttribute('fill', 'none')
  sweep.setAttribute('stroke', quitHoldAccent(hold.accent, hold.dark))
  sweep.setAttribute('stroke-width', `${g.ringStrokePx}`)
  sweep.setAttribute('stroke-linecap', 'round')
  sweep.setAttribute('stroke-dasharray', `${circumference}`)
  sweep.setAttribute('stroke-dashoffset', `${circumference}`)
  sweep.setAttribute('data-sweep', '')
  svg.append(track, sweep)

  // The title: the words and the chord's key cap in one flex row the line tall – an inline key
  // cap would add baseline slack under it and grow the block past §9.23's 54. (No `text-wrap:
  // balance`: it acts on a block's line boxes, and these are flex items – a no-op here.)
  const title = document.createElement('div')
  title.setAttribute('part', 'title')
  Object.assign(title.style, {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '4px',
    minHeight: `${g.titleLinePx}px`,
    whiteSpace: 'pre'
  })
  const before = document.createElement('span')
  before.textContent = QUIT_HOLD_TITLE.before.trimEnd()
  const key = document.createElement('kbd')
  key.textContent = hold.chord
  Object.assign(key.style, {
    display: 'inline-flex',
    alignItems: 'center',
    boxSizing: 'border-box',
    height: `${g.keycapHeightPx}px`,
    padding: `0 ${g.keycapPadPx}px`,
    borderRadius: `${g.keycapRadiusPx}px`,
    border: `1px solid ${palette.border}`,
    background: palette.fill,
    font: `${g.titleWeight} ${g.keycapFontPx}px/1 ${QUIT_HOLD_FONT}`,
    color: palette.text,
    whiteSpace: 'nowrap'
  })
  const after = document.createElement('span')
  after.textContent = QUIT_HOLD_TITLE.after.trimStart()
  title.append(before, key, after)

  panel.append(svg, title)
  root.appendChild(panel)
  return {
    host,
    setProgress: (p) => {
      const clamped = Math.min(1, Math.max(0, p))
      sweep.setAttribute('stroke-dashoffset', `${circumference * (1 - clamped)}`)
      host.setAttribute('data-progress', clamped.toFixed(3))
    }
  }
}

/**
 * The page's panel, one at a time: a hold's panel comes up on the first message, a repeat of
 * the same hold (its `startedAt`) changes nothing, a different hold replaces the one standing
 * at once, and null takes it down with its fade. The ring is stepped per frame from the hold's
 * own clock (`quitHoldProgress`), so a panel that arrives late starts where the hold is.
 */
export function installQuitHoldPanel(
  onPanel: (listener: (panel: QuitHoldPanel | null) => void) => void,
  now: () => number = Date.now
): void {
  let current: (RenderedQuitHoldPanel & { hold: QuitHoldPanel }) | null = null
  let frame: number | null = null
  /** The panel on its way out, until its fade's end takes it. */
  let fading: { rendered: RenderedQuitHoldPanel; timer: ReturnType<typeof setTimeout> } | null =
    null

  const stopFrames = (): void => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }
  const remove = (rendered: RenderedQuitHoldPanel): void => {
    try {
      rendered.host.hidePopover?.()
    } catch {
      // Not in the top layer (a browser without popover, or already hidden): nothing to undo.
    }
    rendered.host.remove()
  }
  const dropFading = (): void => {
    if (!fading) return
    clearTimeout(fading.timer)
    remove(fading.rendered)
    fading = null
  }
  const takeDown = (fade: boolean): void => {
    const rendered = current
    current = null
    stopFrames()
    // A panel still fading goes at once for a new one, or for the one now leaving; a second
    // null while it fades leaves it its fade.
    if (!fade || rendered) dropFading()
    if (!rendered) return
    if (!fade) {
      remove(rendered)
      return
    }
    // The leave is a 120 ms fade in place under either motion setting (§11.3).
    const { host } = rendered
    host.setAttribute('data-leaving', '')
    host.style.transition = `opacity ${QUIT_HOLD_PANEL.fadeMs}ms ease`
    host.style.opacity = '0'
    fading = {
      rendered,
      timer: setTimeout(() => {
        fading = null
        remove(rendered)
      }, QUIT_HOLD_PANEL.fadeMs)
    }
  }
  const show = (hold: QuitHoldPanel): void => {
    if (current && current.hold.startedAt === hold.startedAt) return
    takeDown(false)
    const reduced = reducedMotion()
    const rendered = renderQuitHoldPanel(hold)
    current = { ...rendered, hold }
    mount().appendChild(rendered.host)
    try {
      rendered.host.showPopover?.()
    } catch {
      // A page that already has a popover open in a conflicting state: the fixed host still shows.
    }
    rendered.setProgress(quitHoldProgress(hold, now()))
    // The pop in: the start pose is painted first, then the transition carries it to rest.
    const { host } = rendered
    if (!reduced) host.style.transform = 'scale(0.96)'
    void host.getBoundingClientRect()
    host.style.transition = reduced
      ? `opacity ${QUIT_HOLD_PANEL.fadeMs}ms ease`
      : `opacity ${QUIT_HOLD_PANEL.popMs}ms ${QUIT_HOLD_PANEL.ease}, transform ${QUIT_HOLD_PANEL.popMs}ms ${QUIT_HOLD_PANEL.ease}`
    host.style.opacity = '1'
    if (!reduced) host.style.transform = 'scale(1)'
    const tick = (): void => {
      if (current?.host !== rendered.host) return
      const p = quitHoldProgress(hold, now())
      rendered.setProgress(p)
      frame = p < 1 ? requestAnimationFrame(tick) : null
    }
    frame = requestAnimationFrame(tick)
  }

  onPanel((hold) => {
    if (hold) show(hold)
    else takeDown(true)
  })
}

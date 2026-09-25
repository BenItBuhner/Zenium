// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HINT_PALETTE } from '../fullscreenHint'
import {
  installQuitHoldPanel,
  QUIT_HOLD_FONT,
  QUIT_HOLD_PANEL,
  QUIT_HOLD_TITLE,
  quitHoldAccent,
  quitHoldProgress,
  quitHoldRing,
  quitHoldTitle,
  renderQuitHoldPanel,
  type QuitHoldPanel
} from '../quitHoldPanel'
import { TOAST_CARD } from '../toastCard'

/*
 * "Hold ⌘Q to quit" as the page script paints it (session-08): the §9.23 title block standing
 * alone at the page's centre, the hold's ring in the glyph slot, the chord a key cap; in on
 * §11's 180 ms pop, out on the 120 ms fade, the fade both ways under reduced motion (§11.3).
 */

/** Frames under the test's hand: each `tick` runs the callbacks queued so far. */
class Frames {
  private queue: Array<{ id: number; cb: (now: number) => void }> = []
  private seq = 0
  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.push({ id, cb })
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue = this.queue.filter((f) => f.id !== id)
    })
  }
  tick(): void {
    const due = this.queue
    this.queue = []
    for (const f of due) f.cb(clock.now)
  }
  get pending(): number {
    return this.queue.length
  }
}

/** The hold's clock, the test's own: the panel steps its ring from it. */
const clock = { now: 10_000 }
let frames: Frames

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  clock.now = 10_000
  frames = new Frames()
  frames.install()
  document.documentElement.querySelectorAll('zenium-quit-hold').forEach((el) => el.remove())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function reduceMotion(on: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: on && query.includes('prefers-reduced-motion'),
      media: query
    })
  })
}

const hold = (startedAt = clock.now, dark = false): QuitHoldPanel => ({
  startedAt,
  durationMs: 1500,
  chord: '⌘Q',
  dark,
  accent: '#3366cc'
})

/**
 * Render with the root open, to read the panel's own styles – closed in production, where a
 * page's scripts must not reach it.
 */
function renderOpen(p: QuitHoldPanel): { host: HTMLElement; panel: HTMLElement } {
  const original = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    return original.call(this, { ...init, mode: 'open' })
  }
  try {
    const { host } = renderQuitHoldPanel(p)
    const panel = host.shadowRoot?.querySelector<HTMLElement>('[part="panel"]')
    if (!panel) throw new Error('no panel in the root')
    return { host, panel }
  } finally {
    Element.prototype.attachShadow = original
  }
}

/** Stand the panel up through the installer and hand back the listener and the host. */
function stand(panel: QuitHoldPanel): {
  post: (p: QuitHoldPanel | null) => void
  host: HTMLElement
} {
  let listener: ((p: QuitHoldPanel | null) => void) | null = null
  installQuitHoldPanel(
    (l) => {
      listener = l
    },
    () => clock.now
  )
  listener!(panel)
  const host = document.documentElement.querySelector<HTMLElement>('zenium-quit-hold')!
  expect(host).not.toBeNull()
  return { post: (p) => listener!(p), host }
}

describe('the panel’s words and numbers', () => {
  it('says "Hold ⌘Q to quit" – Chrome’s words in the design language’s sentence case (§9.1)', () => {
    expect(quitHoldTitle('⌘Q')).toBe('Hold ⌘Q to quit')
    expect(quitHoldTitle('Ctrl + Shift + Q')).toBe('Hold Ctrl + Shift + Q to quit')
    expect(QUIT_HOLD_TITLE).toEqual({ before: 'Hold ', after: ' to quit' })
  })

  it('is the §9.23 title block standing alone: 16 around, the 16 glyph slot 8 before the 17/600 title on 22 – 54 inside the hairline', () => {
    expect(QUIT_HOLD_PANEL.padPx).toBe(16)
    expect(QUIT_HOLD_PANEL.glyphPx).toBe(16)
    expect(QUIT_HOLD_PANEL.glyphGapPx).toBe(8)
    expect(QUIT_HOLD_PANEL.titlePx).toBe(17)
    expect(QUIT_HOLD_PANEL.titleLinePx).toBe(22)
    expect(QUIT_HOLD_PANEL.titleWeight).toBe(600)
    expect(QUIT_HOLD_PANEL.padPx * 2 + QUIT_HOLD_PANEL.titleLinePx).toBe(54)
    // The key cap is the line tall, so it adds nothing to the block; the card's radius and
    // the panel's shadow are the message cards' own.
    expect(QUIT_HOLD_PANEL.keycapHeightPx).toBe(QUIT_HOLD_PANEL.titleLinePx)
    expect(QUIT_HOLD_PANEL.radiusPx).toBe(TOAST_CARD.radiusPx)
    expect(QUIT_HOLD_PANEL.shadow).toBe(TOAST_CARD.shadow)
    // §11: the pop's 180 on the standard ease, the leave's 120.
    expect(QUIT_HOLD_PANEL.popMs).toBe(180)
    expect(QUIT_HOLD_PANEL.fadeMs).toBe(120)
    expect(QUIT_HOLD_PANEL.ease).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)')
  })

  it('the ring fits the glyph slot inside its 2 px stroke', () => {
    const { radius, circumference } = quitHoldRing()
    expect(radius).toBe(7)
    expect(circumference).toBeCloseTo(2 * Math.PI * 7, 6)
  })

  it('reads the hold’s progress from its clock, clamped – the live fraction under either motion setting', () => {
    const h = hold(1000)
    expect(quitHoldProgress(h, 1000)).toBe(0)
    expect(quitHoldProgress(h, 1750)).toBe(0.5)
    expect(quitHoldProgress(h, 2500)).toBe(1)
    expect(quitHoldProgress(h, 9000)).toBe(1)
    expect(quitHoldProgress(h, 500)).toBe(0)
    expect(quitHoldProgress({ ...h, durationMs: 0 }, 1000)).toBe(1)
    // No stepping anywhere: the ring reads the key held (input, not animation – §11.3 removes
    // springs and eases, not readouts), so there is no motion setting to read.
    expect(quitHoldProgress.length).toBe(2)
    expect(QUIT_HOLD_PANEL).not.toHaveProperty('steps')
  })

  it('shapes its glyphs as the chrome does: the `--font-sans` stack and the heading weight by value, one source for the page panel and the twin', () => {
    expect(QUIT_HOLD_FONT).toBe(
      "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif"
    )
    const { panel } = renderOpen(hold())
    const key = panel.querySelector<HTMLElement>('kbd')!
    // The shorthand as the engine stores it: the family unbroken, the weight and size the block's.
    const type = (el: HTMLElement): { family: string; weight: string; size: string } => ({
      family: el.style.fontFamily.replace(/"/g, "'"),
      weight: el.style.fontWeight,
      size: el.style.fontSize
    })
    expect(type(panel)).toEqual({
      family: QUIT_HOLD_FONT,
      weight: `${QUIT_HOLD_PANEL.titleWeight}`,
      size: `${QUIT_HOLD_PANEL.titlePx}px`
    })
    expect(panel.style.lineHeight).toBe(`${QUIT_HOLD_PANEL.titleLinePx}px`)
    expect(type(key)).toEqual({
      family: QUIT_HOLD_FONT,
      weight: `${QUIT_HOLD_PANEL.titleWeight}`,
      size: `${QUIT_HOLD_PANEL.keycapFontPx}px`
    })
  })

  it('sets no `text-wrap: balance` on the title: a flex row of the words and the key cap has no line boxes for it to balance', () => {
    const { panel } = renderOpen(hold())
    const title = panel.querySelector<HTMLElement>('[part="title"]')!
    expect(title.style.display).toBe('flex')
    expect(title.style.getPropertyValue('text-wrap')).toBe('')
  })

  it('inks the ring as the chrome’s `--v2-accent` does: the space accent at 40 % into the scheme’s pole', () => {
    expect(quitHoldAccent('#3366cc', false)).toBe('color-mix(in srgb, #3366cc 40%, #000)')
    expect(quitHoldAccent('#3366cc', true)).toBe('color-mix(in srgb, #3366cc 40%, #fff)')
  })
})

describe('the rendered panel', () => {
  it('is a status host over the whole page, in the top layer, taking no pointer, transparent until it pops', () => {
    const { host } = renderQuitHoldPanel(hold())
    expect(host.tagName.toLowerCase()).toBe('zenium-quit-hold')
    expect(host.getAttribute('role')).toBe('status')
    expect(host.getAttribute('aria-live')).toBe('polite')
    expect(host.getAttribute('aria-label')).toBe('Hold ⌘Q to quit')
    expect(host.getAttribute('popover')).toBe('manual')
    expect(host.hasAttribute('data-quit-hold')).toBe(true)
    expect(host.getAttribute('data-chord')).toBe('⌘Q')
    expect(host.style.position).toBe('fixed')
    expect(['0', '0px']).toContain(host.style.inset)
    expect(host.style.display).toBe('grid')
    expect(host.style.placeItems).toBe('center')
    expect(host.style.pointerEvents).toBe('none')
    expect(host.style.opacity).toBe('0')
    expect(host.style.zIndex).toBe('2147483647')
    // The panel is behind a closed root: a page's own styles and scripts do not reach it.
    expect(host.shadowRoot).toBeNull()
  })

  it('takes the chrome’s inks by value, per scheme', () => {
    expect(renderQuitHoldPanel(hold(clock.now, false)).host.style.color).toBe(
      HINT_PALETTE.light.text
    )
    expect(renderQuitHoldPanel(hold(clock.now, true)).host.style.color).toBe(HINT_PALETTE.dark.text)
  })

  it('tells its progress on the host, clamped and to three places', () => {
    const { host, setProgress } = renderQuitHoldPanel(hold())
    setProgress(0.5)
    expect(host.getAttribute('data-progress')).toBe('0.500')
    setProgress(2)
    expect(host.getAttribute('data-progress')).toBe('1.000')
    setProgress(-1)
    expect(host.getAttribute('data-progress')).toBe('0.000')
  })
})

describe('the panel over the page', () => {
  it('pops in on the first message and steps its ring from the hold’s clock, frame by frame', () => {
    reduceMotion(false)
    const { host } = stand(hold())
    expect(host.style.opacity).toBe('1')
    expect(host.style.transform).toBe('scale(1)')
    expect(host.style.transition).toContain(`opacity ${QUIT_HOLD_PANEL.popMs}ms`)
    expect(host.style.transition).toContain(`transform ${QUIT_HOLD_PANEL.popMs}ms`)
    expect(host.style.transition).toContain(QUIT_HOLD_PANEL.ease)
    expect(host.getAttribute('data-progress')).toBe('0.000')
    clock.now += 750
    frames.tick()
    expect(host.getAttribute('data-progress')).toBe('0.500')
    expect(frames.pending).toBe(1)
    clock.now += 750
    frames.tick()
    expect(host.getAttribute('data-progress')).toBe('1.000')
    // Full, the ring asks for no more frames; the panel stands until the core takes it down.
    expect(frames.pending).toBe(0)
    expect(host.isConnected).toBe(true)
  })

  it('a panel arriving late starts where the hold is', () => {
    reduceMotion(false)
    const started = clock.now
    clock.now += 300
    const { host } = stand(hold(started))
    expect(host.getAttribute('data-progress')).toBe('0.200')
  })

  it('a repeat of the same hold changes nothing; a new hold replaces the panel standing', () => {
    reduceMotion(false)
    const first = hold()
    const { post, host } = stand(first)
    post({ ...first })
    expect(document.documentElement.querySelectorAll('zenium-quit-hold')).toHaveLength(1)
    expect(document.documentElement.querySelector('zenium-quit-hold')).toBe(host)
    clock.now += 400
    post(hold(clock.now))
    const hosts = document.documentElement.querySelectorAll('zenium-quit-hold')
    expect(hosts).toHaveLength(1)
    expect(hosts[0]).not.toBe(host)
    expect(host.isConnected).toBe(false)
    expect(hosts[0]!.getAttribute('data-progress')).toBe('0.000')
  })

  it('fades out in 120 ms when the hold ends, then is gone with its frames', () => {
    reduceMotion(false)
    const { post, host } = stand(hold())
    clock.now += 500
    frames.tick()
    expect(frames.pending).toBe(1)
    post(null)
    expect(host.hasAttribute('data-leaving')).toBe(true)
    expect(host.style.opacity).toBe('0')
    expect(host.style.transition).toBe(`opacity ${QUIT_HOLD_PANEL.fadeMs}ms ease`)
    expect(frames.pending).toBe(0)
    // Its last sweep stays for the fade.
    expect(host.getAttribute('data-progress')).toBe('0.333')
    vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs - 1)
    expect(host.isConnected).toBe(true)
    vi.advanceTimersByTime(1)
    expect(host.isConnected).toBe(false)
  })

  it('a hold beginning during the fade takes the leaving panel down at once and stands afresh', () => {
    reduceMotion(false)
    const { post, host } = stand(hold())
    post(null)
    vi.advanceTimersByTime(60)
    clock.now += 60
    post(hold(clock.now))
    expect(host.isConnected).toBe(false)
    const next = document.documentElement.querySelector<HTMLElement>('zenium-quit-hold')!
    expect(next.style.opacity).toBe('1')
    // The old fade's timer is dropped: it must not take the new panel's turn.
    vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs)
    expect(next.isConnected).toBe(true)
  })

  it('a second null while the panel fades leaves it its fade', () => {
    reduceMotion(false)
    const { post, host } = stand(hold())
    post(null)
    vi.advanceTimersByTime(60)
    post(null)
    expect(host.isConnected).toBe(true)
    vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs - 60)
    expect(host.isConnected).toBe(false)
  })

  it('a null with no panel standing is nothing', () => {
    reduceMotion(false)
    let listener: ((p: QuitHoldPanel | null) => void) | null = null
    installQuitHoldPanel((l) => {
      listener = l
    })
    expect(() => listener!(null)).not.toThrow()
    expect(document.documentElement.querySelector('zenium-quit-hold')).toBeNull()
  })

  it('under reduced motion fades in place both ways (§11.3) while the ring still reads the live fraction – the hold is input, not animation', () => {
    reduceMotion(true)
    const { post, host } = stand(hold())
    expect(host.style.transform).toBe('')
    expect(host.style.transition).toBe(`opacity ${QUIT_HOLD_PANEL.fadeMs}ms ease`)
    expect(host.style.opacity).toBe('1')
    clock.now += 499
    frames.tick()
    expect(host.getAttribute('data-progress')).toBe('0.333')
    clock.now += 251
    frames.tick()
    expect(host.getAttribute('data-progress')).toBe('0.500')
    clock.now += 750
    frames.tick()
    expect(host.getAttribute('data-progress')).toBe('1.000')
    post(null)
    expect(host.style.opacity).toBe('0')
    expect(host.style.transition).toBe(`opacity ${QUIT_HOLD_PANEL.fadeMs}ms ease`)
    vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs)
    expect(host.isConnected).toBe(false)
  })
})

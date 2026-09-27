// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HistoryNavHostFrame } from '@renderer/lib/historyNav'
import type { UIState } from '@shared/types'

/*
 * The history navigation bubble (GN-04) on the two kinds of host. Where the chrome is on top
 * the disc is the DOM's, moved on transform and opacity through refs. Where a host draws the
 * disc itself (Android, whose pages are layered above the chrome) the component renders no
 * disc and hands the host the same frames as the disc's box in window px with the viewport's
 * box as the clip – once per frame, and `null` as the bubble goes down – while the root stays
 * on the DOM as the drag's state.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: vi.fn(),
  onEvent: () => () => undefined
}))
// What the release would close at the history's first page is the root-back decision in
// `lib/back.ts`, off the whole UI state; here the machine is told 'tab' whenever the dragged tab
// is in the store, so the caption's pill can be looked at without a full state fixture.
const closeTarget = vi.fn((): 'none' | 'tab' | 'app' => 'none')
vi.mock('@renderer/lib/back', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/back')>()),
  dragCloseTarget: () => closeTarget()
}))

const {
  abortHistoryNav,
  BUBBLE_MIN_SCALE,
  BUBBLE_SIZE,
  dispatchHistoryNavEvent,
  NAV_STEP_CLAMP,
  NAV_THRESHOLD,
  setHistoryNavHost,
  TINT_PROPERTY
} = await import('@renderer/lib/historyNav')
const { browserStore } = await import('@renderer/lib/ui')
const { HistoryNavBubble } = await import('../HistoryNavBubble')

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/** The content frame the root is laid along: 360 wide from x 6 (a gutter to the window's edge), from y 100 to 700. */
const FRAME = { left: 6, right: 366, top: 100, bottom: 700 }

let container: HTMLDivElement
let root: Root
const applied: Array<HistoryNavHostFrame | null> = []

const rootEl = (): HTMLElement | null => document.querySelector('[data-testid="history-nav"]')
const disc = (): HTMLElement | null => document.querySelector('[data-testid="history-nav-bubble"]')

/** `count` samples of the finger, each one step clamp further in: the motion follows exactly. */
function drag(count: number, edge: 'left' | 'right' = 'left'): void {
  act(() => dispatchHistoryNavEvent('t1', 'start', { edge }))
  for (let i = 1; i <= count; i++) {
    act(() => dispatchHistoryNavEvent('t1', 'move', { travel: NAV_STEP_CLAMP * i, time: i * 16 }))
  }
}

beforeEach(() => {
  applied.length = 0
  run.mockReset()
  // The springs never advance here: the frames under test are the finger's.
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  // The root has no width of its own: its box is the frame's side it is laid along; its
  // parent (the viewport that clips the disc) is the whole frame.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const isRoot = this.getAttribute('data-testid') === 'history-nav'
    const x = this.getAttribute('data-edge') === 'right' ? FRAME.right : FRAME.left
    const left = isRoot ? x : FRAME.left
    const right = isRoot ? x : FRAME.right
    return {
      left,
      right,
      top: FRAME.top,
      bottom: FRAME.bottom,
      width: right - left,
      height: FRAME.bottom - FRAME.top,
      x: left,
      y: FRAME.top,
      toJSON: () => ({})
    } as DOMRect
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(HistoryNavBubble)))
})

afterEach(() => {
  act(() => abortHistoryNav())
  act(() => root.unmount())
  container.remove()
  setHistoryNavHost(null)
  browserStore.set({ state: null })
  closeTarget.mockReturnValue('none')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * The dragged tab in the store, at its history's first page, so the machine asks what the
 * release closes: the least state the store's readers (`lib/back.ts`'s back state, the
 * selectors) walk without a full fixture.
 */
function atTheFirstPage(): void {
  browserStore.set({
    state: {
      tabs: { t1: { id: 't1', spaceId: 's', url: 'https://example.test/', canGoBack: false } },
      spaces: [{ id: 's', tabIds: ['t1'], activeTabId: 't1' }],
      activeSpaceId: 's',
      folders: {},
      essentialTabIds: []
    } as unknown as UIState
  })
  closeTarget.mockReturnValue('tab')
}

/** Ten steps of a third of a drag distance, the least that arm. */
function dragToArmed(): void {
  drag(10)
}

describe('HistoryNavBubble', () => {
  it('draws nothing while idle', () => {
    expect(rootEl()).toBeNull()
    expect(disc()).toBeNull()
  })

  describe('with the chrome on top (no host)', () => {
    it('moves the DOM disc on transform and opacity and flags armed on it and the root', () => {
      drag(3)
      const el = disc()
      expect(el).not.toBeNull()
      expect(rootEl()?.dataset.hosted).toBeUndefined()
      expect(el!.style.transform.startsWith('translate3d(')).toBe(true)
      expect(el!.style.transform).toContain(`${NAV_STEP_CLAMP * 3 - BUBBLE_SIZE}px`)
      expect(el!.style.opacity).toBe('1')
      expect(el!.dataset.armed).toBeUndefined()
      expect(rootEl()?.dataset.armed).toBeUndefined()
      // Ten steps of a third of a drag distance are the least that arm.
      for (let i = 4; i <= 10; i++) {
        act(() =>
          dispatchHistoryNavEvent('t1', 'move', { travel: NAV_STEP_CLAMP * i, time: i * 16 })
        )
      }
      expect(rootEl()?.dataset.phase).toBe('dragging')
      expect(disc()!.dataset.armed).toBe('')
      expect(rootEl()?.dataset.armed).toBe('')
      expect(run).toHaveBeenCalledWith('haptic', { kind: 'tick' })
    })

    // The arrow's tint (the lead's 04:34 ruling, v2 §11.9 amended for the arrow alone): the
    // disc's `--zen-histnav-tint` is written per frame off `ArmedTint` – Chrome's 250 ms to the
    // accent as the drag arms, back from wherever it stands as it disarms – and main.css mixes
    // the glyph's and the caption's ink from it. The clock here is the frames' (`performance.now`
    // stubbed; the disc's own animation frames never fire), so each move is a sample.
    it('tints the arrow toward the accent over 250 ms as the drag arms and back from where it stands as it disarms', () => {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
      const tint = (): string => disc()!.style.getPropertyValue(TINT_PROPERTY)
      const move = (steps: number, at: number): void => {
        clock.mockReturnValue(at)
        act(() =>
          dispatchHistoryNavEvent('t1', 'move', { travel: NAV_STEP_CLAMP * steps, time: at })
        )
      }
      drag(3)
      expect(tint()).toBe('0.000')
      for (let i = 4; i <= 10; i++) move(i, 0)
      // The arming frame (ten steps, 106.7 px) is still the ink: the tween starts here.
      expect(disc()!.dataset.armed).toBe('')
      expect(tint()).toBe('0.000')
      // The finger held there: half way at 125 ms, the accent at 250, held past it.
      move(10, 125)
      expect(tint()).toBe('0.500')
      move(10, 250)
      expect(tint()).toBe('1.000')
      move(10, 400)
      expect(tint()).toBe('1.000')
      // One step back (96 px, the threshold itself, not past it): the flag goes, and the ink runs back from the accent.
      move(9, 400)
      expect(disc()!.dataset.armed).toBeUndefined()
      expect(tint()).toBe('1.000')
      move(9, 525)
      expect(tint()).toBe('0.500')
      // Half way back it crosses again: the rise resumes from .5 – no jump either way.
      move(10, 525)
      expect(disc()!.dataset.armed).toBe('')
      expect(tint()).toBe('0.500')
      move(10, 650)
      expect(tint()).toBe('1.000')
    })

    it('rides the tint over 120 ms under reduced motion – a tween still, not set outright', () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }))
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
      const tint = (): string => disc()!.style.getPropertyValue(TINT_PROPERTY)
      dragToArmed()
      expect(rootEl()?.dataset.reduced).toBe('true')
      expect(tint()).toBe('0.000')
      clock.mockReturnValue(60)
      act(() => dispatchHistoryNavEvent('t1', 'move', { travel: NAV_STEP_CLAMP * 10, time: 60 }))
      expect(tint()).toBe('0.500')
      clock.mockReturnValue(120)
      act(() => dispatchHistoryNavEvent('t1', 'move', { travel: NAV_STEP_CLAMP * 10, time: 120 }))
      expect(tint()).toBe('1.000')
    })

    it("has the caption wear the arrow's ink: one mixed ink on the disc, read by the glyph and the caption both", () => {
      atTheFirstPage()
      vi.spyOn(performance, 'now').mockReturnValue(0)
      dragToArmed()
      expect(rootEl()?.dataset.closeTarget).toBe('tab')
      const el = disc()!
      expect(el.dataset.armed).toBe('')
      const glyph = el.querySelector<HTMLElement>('.zen-histnav-glyph')!
      const caption = el.querySelector<HTMLElement>('[data-testid="history-nav-caption"]')!
      expect(caption.textContent).toBe('Close tab')
      expect(caption.classList.contains('zen-histnav-caption')).toBe(true)
      expect(glyph.classList.contains('zen-histnav-glyph')).toBe(true)
      // The tint is the disc's, one value; the two colours are main.css's one mix of it.
      expect(el.style.getPropertyValue(TINT_PROPERTY)).toBe('0.000')
      const rule = (selector: string): string => {
        const start = css.indexOf(`${selector} {`)
        return css.slice(start, css.indexOf('}', start))
      }
      expect(rule('.zen-histnav-glyph')).toContain('color: var(--zen-histnav-ink);')
      expect(rule('.zen-histnav-caption')).toContain('color: var(--zen-histnav-ink);')
    })

    it('main.css mixes the ink from the tint – the text ink toward the control accent, the page accent behind it – with no transition and no rule on the disc', () => {
      const start = css.indexOf('.zen-histnav-disc {')
      const discRule = css.slice(start, css.indexOf('}', start))
      expect(discRule).toContain('--zen-histnav-ink: color-mix(')
      expect(discRule).toContain('in srgb,')
      expect(discRule).toContain('var(--v2-text),')
      // The control accent falls back to the page family's `--v2-accent`: the disc sits in the
      // content frame, under no `data-surface` root that resolves the role.
      expect(discRule).toContain(
        'var(--v2-control-accent, var(--v2-accent)) calc(var(--zen-histnav-tint, 0) * 100%)'
      )
      // The fill and the hairline are the panel and the border, tint or no tint.
      expect(discRule).toContain('background: var(--v2-panel);')
      expect(discRule).toContain('border: 1px solid var(--v2-border);')
      // No CSS transition carries the tint (the reduced-motion stylesheet keeps transitions to
      // opacity fades; the tween is the component's), and no armed rule on the disc.
      const block = css.slice(css.indexOf('.zen-histnav-disc {'), css.indexOf('.zen-space-strip {'))
      expect(block).not.toMatch(/transition:\s*color/)
      expect(block).not.toMatch(/\.zen-histnav-disc\[data-armed\]/)
    })
  })

  describe('with a host drawing the disc', () => {
    beforeEach(() => {
      setHistoryNavHost({ apply: (frame) => applied.push(frame) })
    })

    it('renders the root as the state and no disc, and lays the host its disc against the frame', () => {
      drag(0)
      expect(rootEl()?.dataset.hosted).toBe('true')
      expect(rootEl()?.dataset.phase).toBe('dragging')
      expect(rootEl()?.dataset.edge).toBe('left')
      expect(disc()).toBeNull()
      // The rest: a whole disc out beyond the frame's left side, centred on its height, clipped
      // to the frame – over the gutter to the window's edge nothing of it shows.
      expect(applied).toEqual([
        {
          edge: 'left',
          left: FRAME.left - BUBBLE_SIZE,
          top: (FRAME.top + FRAME.bottom) / 2 - BUBBLE_SIZE / 2,
          size: BUBBLE_SIZE,
          scale: BUBBLE_MIN_SCALE,
          opacity: 0,
          armed: false,
          reduced: false,
          clip: { left: FRAME.left, top: FRAME.top, right: FRAME.right, bottom: FRAME.bottom },
          caption: 0,
          captionText: null
        }
      ])
    })

    it('hands the host a frame per sample, the leading edge riding the finger, and the armed flag at the threshold', () => {
      drag(10)
      expect(applied).toHaveLength(11)
      const third = applied[3]!
      expect(third.left + third.size).toBeCloseTo(FRAME.left + NAV_STEP_CLAMP * 3, 9)
      expect(third.opacity).toBe(1)
      expect(third.armed).toBe(false)
      const last = applied[10]!
      expect(last.armed).toBe(true)
      expect(last.left + last.size).toBeGreaterThan(FRAME.left + NAV_THRESHOLD)
      // The clip is measured with the side, once: every frame carries the same box.
      expect(applied.every((f) => f !== null && f.clip.left === FRAME.left)).toBe(true)
      expect(rootEl()?.dataset.armed).toBe('')
      // The host taps on the armed frame itself (Chrome's KEYBOARD_TAP on the bubble's view):
      // the chrome sends no tick of its own on top of it.
      expect(run).not.toHaveBeenCalledWith('haptic', { kind: 'tick' })
    })

    it('measures the frame once per drag – the side and the clip box in one frame – and never per sample', () => {
      drag(6)
      const reads = vi.mocked(Element.prototype.getBoundingClientRect).mock.calls.length
      expect(reads).toBe(2)
    })

    it('lays a right-edge drag against the right side', () => {
      drag(3, 'right')
      expect(applied[0]).toMatchObject({ edge: 'right', left: FRAME.right, opacity: 0 })
      // The leading (left) edge stands three steps in from the right side.
      expect(applied[3]!.left).toBeCloseTo(FRAME.right - NAV_STEP_CLAMP * 3, 9)
    })

    it('takes the disc down with null as the bubble goes idle', () => {
      drag(3)
      applied.length = 0
      act(() => abortHistoryNav())
      expect(rootEl()).toBeNull()
      // The machine's last paint puts the disc at rest, then the component lets the host go.
      expect(applied[applied.length - 1]).toBeNull()
      expect(applied[applied.length - 2]).toMatchObject({
        opacity: 0,
        left: FRAME.left - BUBBLE_SIZE
      })
    })
  })
})

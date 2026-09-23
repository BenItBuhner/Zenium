// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { DEFAULT_FONT_SETTINGS, type PageFontSettings } from '@shared/fonts'
import type { Settings, UIState } from '@shared/types'
import { fontsGroups } from '../fonts'
import { FONTS_COMMIT_QUIET_MS, useFontsDraft } from '../fontsDraft'
import { onLayout } from '../model'
import { GroupList } from '../rows'

/*
 * The Customise fonts group's ± rows under the Android performance gate's ruling for #350: a
 * sequence of presses is ONE gesture with the gesture budget's three long tasks for the whole
 * of it, and the row meets that by coalescing – each press steps the row's own value and the
 * preview at once, and the commit (`settings.update`, then the core's broadcast and the host's
 * `fonts.apply`) runs once per quiet sequence, `FONTS_COMMIT_QUIET_MS` after the last step or
 * the hold's end, and at once when the row is left (its focus goes, its sheet closes, the
 * drill-in is left), so no step is lost. Both Font size and Minimum font size, through the
 * real rows (`fontsGroups`), the real control (`rows.tsx`) and the real draft (`useFontsDraft`).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

function unmount(): void {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
}

afterEach(() => {
  unmount()
  vi.useRealTimers()
})

/** The phone host's state as far as the group reads it: the fonts, no generic slots, the platform for the preview. */
function phoneState(fonts: PageFontSettings): UIState {
  return {
    platform: 'android',
    capabilities: { genericFontFamilies: false },
    settings: { fonts }
  } as unknown as UIState
}

const ctx = { open: () => undefined }

/**
 * The group on a page: the draft over `fonts` (the committed document), writing through `set`,
 * the rows in the phone layout. `leaveKey` stands for the section shown.
 */
function Fonts({
  fonts,
  set,
  leaveKey = 'look'
}: {
  fonts: PageFontSettings
  set: (patch: Partial<Settings>) => void
  leaveKey?: string | null
}): JSX.Element {
  const fontsDraft = useFontsDraft(fonts, set, leaveKey)
  const groups = onLayout(fontsGroups({ state: phoneState(fonts), set, fontsDraft }), 'phone')
  return <GroupList groups={groups} ctx={ctx} />
}

function rowOf(id: string): HTMLElement {
  const row = host?.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

function plusOf(id: string): HTMLButtonElement {
  const button = rowOf(id).querySelector<HTMLButtonElement>('button[aria-label^="Increase"]')
  if (!button) throw new Error(`no + on ${id}`)
  return button
}

function valueOf(id: string): string {
  return rowOf(id).querySelector('.zen-settings-slider-value')?.textContent ?? ''
}

function previewSize(): string {
  return rowOf('fonts-preview').style.getPropertyValue('--zen-settings-preview-size')
}

function pointer(target: Element, type: string): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 }))
}

/** A tap: the pointer down (the step), up 60 ms later, the click the tap sends after (not a step). */
function tap(target: Element): void {
  act(() => pointer(target, 'pointerdown'))
  act(() => {
    vi.advanceTimersByTime(60)
    pointer(target, 'pointerup')
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
  })
}

describe('the ± rows coalesce (the Android performance gate’s ruling for #350)', () => {
  it('seven presses on Minimum font size move the row on every press and commit once, one `settings.update` with 12 px, once the sequence is quiet', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />)
    const id = 'fonts-minimum-size-phone'
    expect(valueOf(id)).toBe('None')
    const plus = plusOf(id)
    const seen: string[] = []
    for (let i = 0; i < 7; i++) {
      tap(plus)
      seen.push(valueOf(id))
      // The taps land 100 ms apart, down to down – the hold's own cadence: inside the quiet
      // window, nothing commits.
      act(() => {
        vi.advanceTimersByTime(40)
      })
      expect(set).not.toHaveBeenCalled()
    }
    expect(seen).toEqual(['6 px', '7 px', '8 px', '9 px', '10 px', '11 px', '12 px'])
    // The slider reads the same value as the label, and the Reset row is listed off the defaults.
    expect(rowOf(id).querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('12 px')
    expect(host?.querySelector('[data-row="fonts-reset"]')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, minimumSize: 12 } })
    // The row keeps 12 px while the core's broadcast is on its way, and after it.
    expect(valueOf(id)).toBe('12 px')
    act(() =>
      root?.render(<Fonts fonts={{ ...DEFAULT_FONT_SETTINGS, minimumSize: 12 }} set={set} />)
    )
    expect(valueOf(id)).toBe('12 px')
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('three presses on Font size step the row and the preview together on each press; the commit is one, 20 px', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />)
    const id = 'fonts-size-phone'
    expect(valueOf(id)).toBe('16 px')
    expect(previewSize()).toBe('16px')
    const plus = plusOf(id)
    const expected = ['17 px', '18 px', '20 px']
    for (const value of expected) {
      tap(plus)
      expect(valueOf(id)).toBe(value)
      // The preview follows the row's own value, before any commit.
      expect(previewSize()).toBe(value.replace(' ', ''))
      expect(set).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(40)
      })
    }
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, size: 20 } })
    // A second sequence after the quiet is its own commit.
    tap(plus)
    expect(valueOf(id)).toBe('22 px')
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS + 60)
    })
    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenLastCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, size: 22 } })
  })

  it('presses 300 ms apart – a person’s repeated taps, the emulator’s injected ones in run 8 – are one sequence and one commit; a 500 ms pause ends the sequence, and the next press is a new one with its own commit', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />)
    const id = 'fonts-minimum-size-phone'
    const plus = plusOf(id)
    const seen: string[] = []
    for (let i = 0; i < 7; i++) {
      // 300 ms down to down: the tap's 60 ms, then 240 more before the next finger.
      if (i > 0) {
        act(() => {
          vi.advanceTimersByTime(240)
        })
      }
      tap(plus)
      seen.push(valueOf(id))
      expect(set).not.toHaveBeenCalled()
    }
    expect(seen).toEqual(['6 px', '7 px', '8 px', '9 px', '10 px', '11 px', '12 px'])
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS - 1)
    })
    expect(set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, minimumSize: 12 } })

    // A press, a 500 ms pause, a press: two sequences, two commits, each with its own value.
    set.mockClear()
    act(() =>
      root?.render(<Fonts fonts={{ ...DEFAULT_FONT_SETTINGS, minimumSize: 12 }} set={set} />)
    )
    tap(plus)
    expect(valueOf(id)).toBe('13 px')
    act(() => {
      vi.advanceTimersByTime(440)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, minimumSize: 13 } })
    act(() =>
      root?.render(<Fonts fonts={{ ...DEFAULT_FONT_SETTINGS, minimumSize: 13 }} set={set} />)
    )
    tap(plus)
    expect(valueOf(id)).toBe('14 px')
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS)
    })
    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenLastCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, minimumSize: 14 } })
  })

  it('a hold steps every 100 ms after the 400 ms delay and commits once, at its end', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />)
    const id = 'fonts-minimum-size-phone'
    const plus = plusOf(id)
    act(() => pointer(plus, 'pointerdown'))
    expect(valueOf(id)).toBe('6 px')
    // The press's own quiet passes under the hold's delay without a commit: the finger is down.
    act(() => {
      vi.advanceTimersByTime(399)
    })
    expect(valueOf(id)).toBe('6 px')
    expect(set).not.toHaveBeenCalled()
    // 400 ms: the delay is up and the repeat starts; 500, 600, 700, 800 ms: a step each, every
    // one its own task, so the row has rendered the last step when the next reads it.
    act(() => {
      vi.advanceTimersByTime(1)
    })
    for (const value of ['7 px', '8 px', '9 px', '10 px']) {
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(valueOf(id)).toBe(value)
      expect(set).not.toHaveBeenCalled()
    }
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(valueOf(id)).toBe('11 px')
    act(() => {
      pointer(plus, 'pointerup')
      plus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    })
    expect(valueOf(id)).toBe('11 px')
    expect(set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS - 1)
    })
    expect(set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, minimumSize: 11 } })
  })

  it('a hold to the ladder’s end disables the button under the finger and still commits once, the quiet window after the last step', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    // Four stops from the top: 18, 20, 22, 24 px.
    render(<Fonts fonts={{ ...DEFAULT_FONT_SETTINGS, minimumSize: 17 }} set={set} />)
    const id = 'fonts-minimum-size-phone'
    const plus = plusOf(id)
    act(() => pointer(plus, 'pointerdown'))
    expect(valueOf(id)).toBe('18 px')
    act(() => {
      vi.advanceTimersByTime(400)
    })
    for (const value of ['20 px', '22 px', '24 px']) {
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(valueOf(id)).toBe(value)
    }
    expect(plus.disabled).toBe(true)
    expect(set).not.toHaveBeenCalled()
    // No pointerup reaches a disabled button; the row commits all the same, once the hold has
    // ended with the button.
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, minimumSize: 24 } })
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('a press followed by the row’s close inside the quiet window is committed on the close – the unmount, the drill-in’s leave – and a press followed by the focus leaving the row likewise', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />)
    tap(plusOf('fonts-size-phone'))
    expect(set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(50)
    })
    unmount()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, size: 17 } })

    // The drill-in's leave: the section shown changes under the page's draft.
    set.mockClear()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} leaveKey="look" />)
    tap(plusOf('fonts-minimum-size-phone'))
    act(() => root?.render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} leaveKey={null} />))
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, minimumSize: 6 } })
    unmount()
    expect(set).toHaveBeenCalledTimes(1)

    // The focus leaving the row: a finger on another row's button.
    set.mockClear()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />)
    const plus = plusOf('fonts-size-phone')
    act(() => plus.focus())
    tap(plus)
    const other = plusOf('fonts-minimum-size-phone')
    act(() => {
      plus.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: other }))
      other.focus()
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, size: 17 } })
    // Within the row – the + to the − – is no leave.
    tap(plus)
    const minus = rowOf('fonts-size-phone').querySelector<HTMLButtonElement>(
      'button[aria-label^="Decrease"]'
    )!
    act(() => {
      plus.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: minus }))
    })
    expect(set).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS)
    })
    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenLastCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, size: 18 } })
  })

  it('the blur of another row – the Font size button the focus was left on, as a finger lands on Minimum font size’s + – does not commit the sequence that finger begins (run 8’s fault): the seven presses still commit once', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={{ ...DEFAULT_FONT_SETTINGS, size: 20 }} set={set} />)
    const left = plusOf('fonts-size-phone')
    act(() => left.focus())
    const plus = plusOf('fonts-minimum-size-phone')
    // The tap's down steps the row; the focus moves at the tap's end, the button left behind
    // blurring towards the one under the finger.
    act(() => pointer(plus, 'pointerdown'))
    act(() => {
      left.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: plus }))
      plus.focus()
    })
    act(() => {
      vi.advanceTimersByTime(60)
      pointer(plus, 'pointerup')
    })
    expect(valueOf('fonts-minimum-size-phone')).toBe('6 px')
    expect(set).not.toHaveBeenCalled()
    for (let i = 1; i < 7; i++) {
      act(() => {
        vi.advanceTimersByTime(40)
      })
      tap(plus)
    }
    expect(valueOf('fonts-minimum-size-phone')).toBe('12 px')
    expect(set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({
      fonts: { ...DEFAULT_FONT_SETTINGS, size: 20, minimumSize: 12 }
    })

    // The Font size row's own blur still commits the Font size step it has pending – with the
    // other row's, so no step is lost.
    set.mockClear()
    act(() =>
      root?.render(
        <Fonts fonts={{ ...DEFAULT_FONT_SETTINGS, size: 20, minimumSize: 12 }} set={set} />
      )
    )
    tap(left)
    tap(plus)
    expect(set).not.toHaveBeenCalled()
    act(() => {
      left.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: plus }))
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({
      fonts: { ...DEFAULT_FONT_SETTINGS, size: 22, minimumSize: 13 }
    })
  })

  it('a step back to the committed value inside the window commits nothing; a pick or Reset commits at once with the pending steps folded in; a change from outside ends what was committed', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={{ ...DEFAULT_FONT_SETTINGS, size: 20 }} set={set} />)
    const id = 'fonts-size-phone'
    const row = rowOf(id)
    const plus = plusOf(id)
    const minus = row.querySelector<HTMLButtonElement>('button[aria-label^="Decrease"]')!
    tap(plus)
    expect(valueOf(id)).toBe('22 px')
    tap(minus)
    expect(valueOf(id)).toBe('20 px')
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS)
    })
    expect(set).not.toHaveBeenCalled()

    // A step, then Reset before the quiet: one write, the defaults whole.
    tap(plus)
    const reset = rowOf('fonts-reset')
    const target = reset.tagName === 'BUTTON' ? reset : reset.querySelector('button')!
    act(() => target.click())
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS } })
    expect(valueOf(id)).toBe('16 px')
    act(() => {
      vi.advanceTimersByTime(FONTS_COMMIT_QUIET_MS)
    })
    expect(set).toHaveBeenCalledTimes(1)

    // The core's broadcast of the reset: the committed document is what shows from here on;
    // a later change from outside (another window, a sync merge) is followed too.
    act(() => root?.render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />))
    expect(valueOf(id)).toBe('16 px')
    act(() => root?.render(<Fonts fonts={{ ...DEFAULT_FONT_SETTINGS, size: 24 }} set={set} />))
    expect(valueOf(id)).toBe('24 px')
    expect(set).toHaveBeenCalledTimes(1)
  })

  /*
   * The single-press case the ruling's clarification (perf-program.md, RULING 4, 07:49) accepts
   * on a unit test in place of an emulator run: one press through the production coalescer
   * under a fake clock – no apply at 399 ms, exactly one at 400 ms, still one at 1000 ms – and
   * the hold's end as the window's start. `set` is the apply here: it is the one write the
   * commit makes (`settings.update`), and the host's `fonts.apply` follows each write once.
   */
  it('one press – a finger’s tap on Font size’s + – moves the row and the preview on the press itself and applies once: none at 399 ms from the tap’s end, one at 400 ms, still one at 1000 ms', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />)
    const id = 'fonts-size-phone'
    const plus = plusOf(id)
    // The down is the step: the row's value and the preview move here, before any commit.
    act(() => pointer(plus, 'pointerdown'))
    expect(valueOf(id)).toBe('17 px')
    expect(previewSize()).toBe('17px')
    expect(set).not.toHaveBeenCalled()
    // The finger lifts 60 ms on: the press's hold ends, and the quiet window starts here.
    act(() => {
      vi.advanceTimersByTime(60)
      pointer(plus, 'pointerup')
      plus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    })
    expect(valueOf(id)).toBe('17 px')
    expect(set).not.toHaveBeenCalled()
    // 400 ms from the down is 340 from the release: the window runs from the hold's end, not
    // from the step under the finger.
    act(() => {
      vi.advanceTimersByTime(340)
    })
    expect(set).not.toHaveBeenCalled()
    // 399 ms from the release: no apply.
    act(() => {
      vi.advanceTimersByTime(59)
    })
    expect(set).not.toHaveBeenCalled()
    // 400 ms: the one apply, with the press's value.
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, size: 17 } })
    // 1000 ms: still the one.
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(valueOf(id)).toBe('17 px')
    expect(previewSize()).toBe('17px')
  })

  it('one press from the keyboard – Minimum font size’s +, a click with no pointer under it – applies once: none at 399 ms from the step, one at 400 ms, still one at 1000 ms', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />)
    const id = 'fonts-minimum-size-phone'
    const plus = plusOf(id)
    // Enter or Space on the focused button: the click with `detail` 0 is the step, and with no
    // hold around it the window runs from the step.
    act(() => {
      plus.focus()
      plus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
    })
    expect(valueOf(id)).toBe('6 px')
    expect(set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(399)
    })
    expect(set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, minimumSize: 6 } })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(valueOf(id)).toBe('6 px')
  })

  it('a hold’s end starts the window: a hold on Font size’s + steps to 20 px, and from the release none at 399 ms, one apply at 400 ms with the hold’s last step, still one at 1000 ms', () => {
    vi.useFakeTimers()
    const set = vi.fn()
    render(<Fonts fonts={DEFAULT_FONT_SETTINGS} set={set} />)
    const id = 'fonts-size-phone'
    const plus = plusOf(id)
    act(() => pointer(plus, 'pointerdown'))
    expect(valueOf(id)).toBe('17 px')
    // The hold's 400 ms delay: the first step's own quiet passes under the finger, no commit.
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(valueOf(id)).toBe('17 px')
    expect(set).not.toHaveBeenCalled()
    for (const value of ['18 px', '20 px']) {
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(valueOf(id)).toBe(value)
      expect(previewSize()).toBe(value.replace(' ', ''))
      expect(set).not.toHaveBeenCalled()
    }
    // The release, 600 ms after the down: the hold's end, and the window's start.
    act(() => {
      pointer(plus, 'pointerup')
      plus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    })
    expect(valueOf(id)).toBe('20 px')
    expect(set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(399)
    })
    expect(set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ fonts: { ...DEFAULT_FONT_SETTINGS, size: 20 } })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(valueOf(id)).toBe('20 px')
  })
})

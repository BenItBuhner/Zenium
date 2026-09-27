// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RecedeHandle } from '@renderer/lib/motion/recede'
import { TOAST_UNDO_MS } from '@shared/toastCard'

/*
 * The phone's toasts and the sheet host (v2 draft §9.33, ruled on #637 and #651): a toast up
 * while a sheet stands – the Site settings review's "Permissions allowed again for <host> ·
 * Undo" on Allow again, "Review complete for N sites · Undo" on Got it, or a toast up already
 * as the sheet opened (Chrome's rule: whatever snackbar is showing is re-parented into an open
 * sheet) – stands above the sheet, its Undo in reach, for the rest of its clock; at the sheet's
 * landing the frame is seated normally again with the toast's element untouched (one
 * announcement, its clock running on); the message frame's own cards – the banner stack, and
 * the seat #641's hint bubble takes – stay where they were. The lifted frame's bottom edge
 * stands at the sheet's edge, or on the top edge of the footer band the top sheet publishes to
 * the recede registry (`RecedeHandle.footer`), so the toast never covers a footer's actions.
 * The sheet here is a layer on the recede registry, as every phone sheet is.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { PhoneMessages } = await import('../PhoneMessages')
const { pushToast, showBanner, uiStore } = await import('@renderer/lib/ui')
const { recedeDepth, registerRecedeLayer } = await import('@renderer/lib/motion/recede')

let root: Root | null = null
let host: HTMLDivElement | null = null
let frames: Array<(t: number) => void> = []
const sheets: RecedeHandle[] = []

beforeEach(() => {
  vi.useFakeTimers()
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })) as unknown as typeof window.matchMedia
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 44
  })
  uiStore.set({ toasts: [], banners: [], screenshotCards: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  for (const sheet of sheets.splice(0)) sheet.release()
  uiStore.set({ toasts: [], banners: [], screenshotCards: [] })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
  vi.useRealTimers()
})

/** The frames as the shell mounts them; `inert` is the chrome's non-sheet hold the shell passes. */
const mount = (inert = false): void => {
  act(() => root!.render(createElement(PhoneMessages, { edge: 'bottom', inert })))
}

/** A sheet comes up on the chassis: on the stack from its mount, at its first detent. */
const openSheet = (): RecedeHandle => {
  let handle!: RecedeHandle
  act(() => {
    handle = registerRecedeLayer()
    handle.progress(1)
  })
  sheets.push(handle)
  return handle
}

/** The sheet leaves: its spring runs down, and it is off the stack at the landing. */
const closeSheet = (handle: RecedeHandle): void => {
  act(() => handle.progress(0))
  act(() => handle.release())
}

const toastFrame = (): HTMLElement => {
  const el = host!.querySelector<HTMLElement>('.zen-toast-frame')
  if (!el) throw new Error('no toast frame')
  return el
}
const messageFrame = (): HTMLElement => {
  const el = host!.querySelector<HTMLElement>('.zen-message-frame[data-shell-chrome]')
  if (!el) throw new Error('no message frame')
  return el
}
const lifted = (): boolean => toastFrame().hasAttribute('data-lifted')
/** What the frame says its bottom edge stands over the inset's line by (`--zen-sheet-footer`). */
const foot = (): string => toastFrame().style.getPropertyValue('--zen-sheet-footer')

const allowAgain = (onPick: () => void): number =>
  pushToast('Permissions allowed again for meet.example', 'info', {
    duration: TOAST_UNDO_MS,
    action: { label: 'Undo', onPick }
  })
const reviewComplete = (onPick: () => void): number =>
  pushToast('Review complete for 3 sites', 'info', {
    duration: TOAST_UNDO_MS,
    action: { label: 'Undo', onPick }
  })

describe('a toast up while a sheet stands stands above the sheet', () => {
  it("lifts the toast frame over the sheet host for Allow again's toast, its Undo in reach", () => {
    mount()
    openSheet()
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    const frame = toastFrame()
    expect(lifted()).toBe(true)
    expect(frame.classList.contains('z-[60]')).toBe(true)
    expect(frame.classList.contains('z-[36]')).toBe(false)
    // Never shell chrome, never inert: the hold on the window chrome must not reach it, and its
    // Undo takes the press.
    expect(frame.hasAttribute('data-shell-chrome')).toBe(false)
    expect(frame.hasAttribute('inert')).toBe(false)
    const card = frame.querySelector<HTMLElement>('[role="status"]')
    expect(card?.textContent).toContain('Permissions allowed again for meet.example')
    // The toast is the toast: the Undo clock, the action, the announcement.
    expect(uiStore.get().toasts[0]?.duration).toBe(TOAST_UNDO_MS)
    const undo = frame.querySelector<HTMLButtonElement>('button.zen-message-button')
    expect(undo?.textContent).toBe('Undo')
    act(() => undo!.click())
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(uiStore.get().toasts[0]?.leaving).toBe(true)
    // The message frame under it is still the chassis's: chrome, under the sheet.
    expect(messageFrame().hasAttribute('data-shell-chrome')).toBe(true)
  })

  it("lifts a toast up before the sheet opened too, for the rest of its clock (Chrome's rule)", () => {
    mount()
    act(() => {
      pushToast('Saved to Bookmarks', 'info', { duration: TOAST_UNDO_MS })
    })
    expect(lifted()).toBe(false)
    expect(toastFrame().classList.contains('z-[36]')).toBe(true)
    act(() => vi.advanceTimersByTime(3000))
    openSheet()
    const frame = toastFrame()
    expect(lifted()).toBe(true)
    expect(frame.classList.contains('z-[60]')).toBe(true)
    expect(frame.hasAttribute('inert')).toBe(false)
    expect(frame.querySelector('[role="status"]')?.textContent).toContain('Saved to Bookmarks')
    // The rest of its clock, not a new one: 3 s of the 8 were spent under no sheet.
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS - 3000 - 1))
    expect(uiStore.get().toasts[0]?.leaving).toBeUndefined()
    act(() => vi.advanceTimersByTime(1))
    expect(uiStore.get().toasts[0]?.leaving).toBe(true)
    // Its leave runs in the lifted frame, the seat it stood in.
    expect(lifted()).toBe(true)
  })

  it('has nothing to lift with the slot empty: the frame stands at the normal seat under the sheet, and is never inert', () => {
    mount()
    openSheet()
    expect(lifted()).toBe(false)
    expect(toastFrame().classList.contains('z-[36]')).toBe(true)
    expect(toastFrame().hasAttribute('inert')).toBe(false)
    expect(foot()).toBe('')
  })

  it("re-seats at the sheet's landing with the toast's element untouched, its clock running", () => {
    mount()
    const sheet = openSheet()
    const onPick = vi.fn()
    act(() => {
      reviewComplete(onPick)
    })
    expect(lifted()).toBe(true)
    const card = toastFrame().querySelector('[role="status"]')
    expect(card).not.toBeNull()
    // The spring runs down: the sheet is still on the stack, the toast still over it.
    act(() => sheet.progress(0))
    expect(recedeDepth()).toBe(1)
    expect(lifted()).toBe(true)
    // Landed and off the stack: the normal seat, no hold, the same card – no remount, so the
    // status region is not announced again and the arrival does not replay.
    act(() => sheet.release())
    expect(lifted()).toBe(false)
    expect(toastFrame().classList.contains('z-[36]')).toBe(true)
    expect(toastFrame().hasAttribute('inert')).toBe(false)
    expect(foot()).toBe('')
    expect(toastFrame().querySelector('[role="status"]')).toBe(card)
    expect(uiStore.get().toasts[0]?.leaving).toBeUndefined()
    // The Undo is still there to take, on what is left of the 8 s.
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS - 1))
    expect(uiStore.get().toasts[0]?.leaving).toBeUndefined()
    act(() => vi.advanceTimersByTime(1))
    expect(uiStore.get().toasts[0]?.leaving).toBe(true)
  })

  it('lifts the re-seated toast again for a sheet that opens later while it is still up', () => {
    mount()
    const sheet = openSheet()
    act(() => {
      allowAgain(() => undefined)
    })
    closeSheet(sheet)
    expect(lifted()).toBe(false)
    openSheet()
    expect(lifted()).toBe(true)
    expect(toastFrame().hasAttribute('inert')).toBe(false)
  })

  it("stays lifted over the sheet under the one whose act raised it (§9.24's depth two)", () => {
    mount()
    openSheet()
    const upper = openSheet()
    act(() => {
      allowAgain(() => undefined)
    })
    expect(lifted()).toBe(true)
    closeSheet(upper)
    expect(recedeDepth()).toBe(1)
    expect(lifted()).toBe(true)
  })

  it("leaves the message frame's cards where they are: the banner stack stays under", () => {
    mount()
    openSheet()
    act(() => {
      showBanner({ title: 'Translate this page?' })
      allowAgain(() => undefined)
    })
    expect(lifted()).toBe(true)
    const banner = messageFrame().querySelector('.zen-banner')
    expect(banner?.textContent).toContain('Translate this page?')
    expect(toastFrame().querySelector('.zen-banner')).toBeNull()
    expect(messageFrame().querySelector('.zen-message-toast')).toBeNull()
    expect(toastFrame().querySelector('.zen-message-toast')).not.toBeNull()
  })

  it("keeps the slot lifted as the sheet's toast sends an earlier one off", () => {
    mount()
    act(() => {
      pushToast('Saved to Bookmarks')
    })
    openSheet()
    expect(lifted()).toBe(true)
    act(() => {
      allowAgain(() => undefined)
    })
    expect(uiStore.get().toasts.map((t) => Boolean(t.leaving))).toEqual([true, false])
    expect(lifted()).toBe(true)
    expect(toastFrame().querySelectorAll('.zen-message-toast')).toHaveLength(2)
  })
})

describe("the lifted frame's bottom edge: the sheet's edge, or its footer band's top edge (Q1)", () => {
  it("stands at the sheet's edge for a sheet without a footer band: the frame says 0", () => {
    mount()
    openSheet()
    act(() => {
      allowAgain(() => undefined)
    })
    expect(lifted()).toBe(true)
    expect(foot()).toBe('0px')
  })

  it('stands on the footer band the sheet publishes to the registry, and follows it', () => {
    mount()
    const sheet = openSheet()
    act(() => {
      allowAgain(() => undefined)
    })
    // The sheet measures: a 56 band on the chassis's 8.
    act(() => sheet.footer(64))
    expect(lifted()).toBe(true)
    expect(foot()).toBe('64px')
    // The band grows (a larger text scale): the frame follows.
    act(() => sheet.footer(72))
    expect(foot()).toBe('72px')
    // The sheet's actions go: the sheet's edge again.
    act(() => sheet.footer(0))
    expect(foot()).toBe('0px')
  })

  it("stands on the top sheet's band at depth two, and on the lower one's once the top has landed", () => {
    mount()
    const lower = openSheet()
    act(() => lower.footer(64))
    act(() => {
      allowAgain(() => undefined)
    })
    expect(foot()).toBe('64px')
    const upper = openSheet()
    expect(foot()).toBe('0px')
    act(() => upper.footer(40))
    expect(foot()).toBe('40px')
    closeSheet(upper)
    expect(lifted()).toBe(true)
    expect(foot()).toBe('64px')
    closeSheet(lower)
    expect(lifted()).toBe(false)
    expect(foot()).toBe('')
  })

  it('the stylesheet seats the lifted frame on the inset plus the band, and rides the sheet between that and the normal seat', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
    const at = css.indexOf(
      ":root[data-form-factor='phone'] .zen-message-frame[data-lifted][data-edge] {"
    )
    expect(at).toBeGreaterThan(0)
    const rule = css.slice(at, css.indexOf('\n}', at))
    expect(rule).toContain('bottom: calc(var(--zen-inset-bottom) + var(--zen-sheet-footer, 0px));')
    expect(rule.replace(/\s+/g, ' ')).toContain(
      'transform: translate3d( 0, calc((var(--zen-message-foot) - var(--zen-sheet-footer, 0px)) * (var(--zen-recede, 0) - 1)), 0 );'
    )
    // The normal seat's rules are #202's, untouched: the band is read on the lifted frame alone.
    expect(css).toContain(
      ":root[data-form-factor='phone'] .zen-message-frame[data-edge='bottom'] {\n  top: calc(var(--zen-inset-top) + var(--zen-padding));\n  bottom: calc(var(--zen-inset-bottom) + var(--zen-phone-band));\n}"
    )
  })
})

describe("the chrome's holds that are not a sheet's: a page's fullscreen, the capture overlay", () => {
  it('a toast up under a fullscreen page is inert with the rest of the chrome: no TalkBack stop, no focus', () => {
    // The shell holds the chrome for the page's fullscreen (MOT-32) and says so to the frames.
    mount(true)
    act(() => {
      pushToast('Saved to Bookmarks', 'info', { duration: TOAST_UNDO_MS })
    })
    expect(lifted()).toBe(false)
    expect(toastFrame().hasAttribute('inert')).toBe(true)
    // The hold goes (the page leaves its fullscreen): the frame is in reach again, the toast
    // still up on its clock.
    mount(false)
    expect(toastFrame().hasAttribute('inert')).toBe(false)
    expect(toastFrame().querySelector('[role="status"]')?.textContent).toContain(
      'Saved to Bookmarks'
    )
  })

  it('a sheet standing has the toast above it and in reach, whatever else holds the chrome (Q3)', () => {
    mount(true)
    const sheet = openSheet()
    act(() => {
      allowAgain(() => undefined)
    })
    expect(lifted()).toBe(true)
    expect(toastFrame().hasAttribute('inert')).toBe(false)
    // The sheet lands while the hold stands: back at the normal seat, the frame is inert again.
    closeSheet(sheet)
    expect(lifted()).toBe(false)
    expect(toastFrame().hasAttribute('inert')).toBe(true)
  })

  it("the hold the shell passes is the toast frame's alone: the message frame is shell chrome, the chrome hold's own", () => {
    mount(true)
    act(() => {
      showBanner({ title: 'Translate this page?' })
    })
    // `holdChromeInert` marks `data-shell-chrome` itself; the prop writes nothing on that frame.
    expect(messageFrame().hasAttribute('data-shell-chrome')).toBe(true)
    expect(messageFrame().hasAttribute('inert')).toBe(false)
    expect(toastFrame().hasAttribute('inert')).toBe(true)
  })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RecedeHandle } from '@renderer/lib/motion/recede'
import { TOAST_UNDO_MS } from '@shared/toastCard'

/*
 * The phone's toasts and the sheet host (v2 draft §9.33, ruled on #637): a toast raised by an
 * act taken in an open sheet – the Site settings review's "Permissions allowed again for
 * <host> · Undo" on Allow again, "Review complete for N sites · Undo" on Got it – stands above
 * the sheet, its Undo in reach; a toast raised before the sheet opened keeps its place under
 * it, inert with the rest of the chrome; at the sheet's landing the frame is seated normally
 * again with the toast's element untouched (one announcement, its clock running on); the
 * message frame's own cards – the banner stack, and the seat #641's hint bubble takes – stay
 * where they were. The sheet here is a layer on the recede registry, as every phone sheet is.
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
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 44 })
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

const mount = (): void => {
  act(() => root!.render(createElement(PhoneMessages, { edge: 'bottom' })))
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

describe('a toast a sheet raised stands above the sheet', () => {
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
    // Never shell chrome, never inert while lifted: the hold on the window chrome must not
    // reach it, and its Undo takes the press.
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

  it('keeps a toast raised before the sheet opened under it, inert with the chrome', () => {
    mount()
    act(() => {
      pushToast('Saved to Bookmarks')
    })
    expect(lifted()).toBe(false)
    expect(toastFrame().hasAttribute('inert')).toBe(false)
    openSheet()
    const frame = toastFrame()
    expect(lifted()).toBe(false)
    expect(frame.classList.contains('z-[36]')).toBe(true)
    expect(frame.hasAttribute('inert')).toBe(true)
    expect(frame.querySelector('[role="status"]')?.textContent).toContain('Saved to Bookmarks')
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
    expect(toastFrame().querySelector('[role="status"]')).toBe(card)
    expect(uiStore.get().toasts[0]?.leaving).toBeUndefined()
    // The Undo is still there to take, on what is left of the 8 s.
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS - 1))
    expect(uiStore.get().toasts[0]?.leaving).toBeUndefined()
    act(() => vi.advanceTimersByTime(1))
    expect(uiStore.get().toasts[0]?.leaving).toBe(true)
  })

  it('does not lift the re-seated toast again for a sheet that opens later', () => {
    mount()
    const sheet = openSheet()
    act(() => {
      allowAgain(() => undefined)
    })
    closeSheet(sheet)
    expect(lifted()).toBe(false)
    openSheet()
    expect(lifted()).toBe(false)
    expect(toastFrame().hasAttribute('inert')).toBe(true)
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

  it('follows the live toast: a sheet\'s toast lifts the slot as an earlier one leaves', () => {
    mount()
    act(() => {
      pushToast('Saved to Bookmarks')
    })
    openSheet()
    expect(lifted()).toBe(false)
    act(() => {
      allowAgain(() => undefined)
    })
    expect(uiStore.get().toasts.map((t) => Boolean(t.leaving))).toEqual([true, false])
    expect(lifted()).toBe(true)
  })
})

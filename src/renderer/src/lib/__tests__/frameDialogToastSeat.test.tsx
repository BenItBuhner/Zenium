// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useSyncExternalStore, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import type { RecedeHandle } from '@renderer/lib/motion/recede'
import { TOAST_UNDO_MS } from '@shared/toastCard'

/*
 * The frame dialog host's toast seat (v2 draft §9.33; W8-F16, the phone's lift of #651 as one
 * mechanism): a toast a dialog's act raises – the Site permissions dialog's "Permissions allowed
 * again for <host> · Undo" – rises above the standing dialog and its scrim, undimmed and in
 * reach, on the desktop and the tablet. The seat is a frame of the host's own box after the
 * dialogs' slot, so both of the host's inert holds leave it alone (`holdChromeInert` marks the
 * window chrome outside the hosts, `holdFrameInert` the host's siblings); it lifts by the host's
 * registry – a dialog stands, a panel on its way out included – while it holds a card, with the
 * card 8 inside the content frame's bottom edge (the layer's `--zen-message-inset`), never in
 * the dialog box, and on the top edge of a hosted sheet's footer band. While lifted the Undo is
 * the last stop of the dialog's Tab cycle (§9.22: the dialog and the toast are one modal
 * moment), and the stop leaves the cycle with the toast, the keyboard back on the dialog; and
 * Ctrl+Z – Cmd+Z – presses that Undo (§9.33's shortcut, the lead's pick was both), never from a
 * text field, never when the seat is not lifted or its top card offers no Undo. When
 * the dialog closes the toast keeps its seat and its clock (the orphan case), its element and
 * its one `role="status"` announcement untouched. One card per act (§9.33): the sidebar's foot
 * (`SidebarBottom`, the real one in both harnesses) draws no second copy of a toast the frame's
 * seat holds – not the desktop's plain column, not the tablet's message well. Rendered for real
 * in happy-dom: the desktop's frame with a real `SettingsDialog` (its own Tab wrap) and the
 * seat's cards (`FrameSeatToasts`); the tablet through `TabletShell`, its `MessageLayer` seating
 * the slot in the host's seat, the children that carry none of it stubbed.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

// --- the tablet shell's stubs: the parts that carry none of the seat ----------------------------

const stub = (name: string): (() => ReactElement) => {
  const Stub = (): ReactElement => createElement('div', { [`data-${name}-stub`]: '' })
  Stub.displayName = `${name}Stub`
  return Stub
}
// The sidebar as the tablet mounts it: a control of its own for the chrome hold's reading, and
// the real foot (`SidebarBottom`) with Android's message well in it – the well must draw none
// of a toast the frame's seat holds.
vi.mock('@renderer/components/sidebar/Sidebar', async () => {
  const { SidebarBottom } = await import('@renderer/components/sidebar/SidebarBottom')
  return {
    Sidebar: ({ state, isDark }: { state: UIState; isDark: boolean }) =>
      createElement(
        'div',
        null,
        createElement('button', { type: 'button', 'data-sidebar-button': '' }, 'New tab'),
        createElement(SidebarBottom, { state, compact: false, isDark })
      )
  }
})
vi.mock('@renderer/components/tablet/TabletToolbar', () => ({ TabletToolbar: stub('toolbar') }))
vi.mock('@renderer/components/content/ContentArea', () => ({
  ContentArea: () => createElement('button', { type: 'button', 'data-page-button': '' }, 'Page')
}))
vi.mock('@renderer/components/DragLayer', () => ({
  ChromeDropLayer: stub('drop'),
  DragLayer: stub('drag')
}))
vi.mock('@renderer/components/ModStyles', () => ({ ModStyles: () => null }))
vi.mock('@renderer/components/overlays/Onboarding', () => ({ Onboarding: stub('onboarding') }))
vi.mock('@renderer/components/phone/PhoneStage', () => ({ PhoneStage: stub('stage') }))
vi.mock('@renderer/components/phone/SpacesDrawer', () => ({ SpacesDrawer: stub('spaces') }))
vi.mock('@renderer/components/phone/useFullscreenReturn', () => ({
  useFullscreenReturn: () => undefined
}))
vi.mock('@renderer/components/urlbar/Urlbar', () => ({ Urlbar: stub('urlbar') }))
// The frame's host as the tablet shell mounts it, with the test's dialog in it.
vi.mock('@renderer/components/TabDialogs', () => ({
  TabDialogs: () => createElement(TabletDialogs)
}))

const { FrameDialogHost, chromeInertHeld, frameToastSeat, holdChromeInert, useFrameDialog } =
  await import('../portals')
const { pushToast, showBanner, uiStore } = await import('../ui')
const { viewportStore } = await import('../formFactor')
const { registerRecedeLayer } = await import('../motion/recede')
const { SettingsDialog } = await import('@renderer/components/pages/settings/dialogs')
const { FrameSeatToasts } = await import('@renderer/components/messages/FrameSeatToasts')
const { SidebarBottom } = await import('@renderer/components/sidebar/SidebarBottom')
const { TabletShell } = await import('@renderer/components/tablet/TabletShell')

// --- the dialog whose act raises the toast ------------------------------------------------------

/** Whether the tablet's dialog is up: the shell's stubbed `TabDialogs` reads it. */
let tabletDialogUp = false
const dialogListeners = new Set<() => void>()
const setTabletDialog = (up: boolean): void => {
  tabletDialogUp = up
  for (const l of dialogListeners) l()
}
const useTabletDialog = (): boolean =>
  useSyncExternalStore(
    (l) => {
      dialogListeners.add(l)
      return () => dialogListeners.delete(l)
    },
    () => tabletDialogUp
  )

const allowAgain = (onPick: () => void = () => undefined): number =>
  pushToast('Permissions allowed again for meet.example', 'info', {
    duration: TOAST_UNDO_MS,
    action: { label: 'Undo', onPick }
  })

/**
 * The Site permissions review as a v2 dialog on the host (`SettingsDialog`, with its own Tab
 * wrap): Allow again raises the Undo toast and keeps the dialog; Got it closes it. Between them
 * the three kinds of text field a dialog can hold – an input, a textarea, a contenteditable –
 * whose own undo Ctrl+Z is (no review has them; they stand for any dialog's fields).
 */
function SitePermissions({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <SettingsDialog
      name="site-permissions"
      title="Site permissions"
      description="meet.example"
      under={false}
      onClose={onClose}
    >
      <button type="button" data-allow-again onClick={() => allowAgain()}>
        Allow again
      </button>
      <input type="text" data-note aria-label="Note" />
      <textarea data-memo aria-label="Memo" />
      <div contentEditable tabIndex={0} role="textbox" data-scratch aria-label="Scratch" />
      <button type="button" data-got-it onClick={onClose}>
        Got it
      </button>
    </SettingsDialog>
  )
}

function TabletDialogs(): JSX.Element {
  const up = useTabletDialog()
  return (
    <FrameDialogHost frame>
      {up && <SitePermissions onClose={() => setTabletDialog(false)} />}
    </FrameDialogHost>
  )
}

/** A hosted sheet on its own chassis (`ownScrim`), as the Settings pickers are on a tablet. */
function HostedSheet(): JSX.Element {
  useFrameDialog({ onScrimPress: () => undefined, ownScrim: true })
  return (
    <div data-dialog="picker" data-sheet-layer="true">
      <button type="button">Pick</button>
    </div>
  )
}

/**
 * The desktop's frame: the window chrome (`data-surface="window"`) with the sidebar's real foot
 * and its plain toast column in it, the content frame's box with the page, the frame's host and
 * the seat's cards beside it, as `DesktopShell` mounts them.
 */
function Desktop({ dialog, sheet }: { dialog?: boolean; sheet?: boolean }): JSX.Element {
  return (
    <>
      <nav data-surface="window">
        <button type="button" data-sidebar-button>
          New tab
        </button>
        <SidebarBottom state={desktopState()} compact={false} isDark={false} />
      </nav>
      <div data-frame>
        <div data-page>
          <button type="button" data-page-button>
            Page
          </button>
        </div>
        <FrameDialogHost frame>
          {dialog && <SitePermissions onClose={() => rerender(<Desktop />)} />}
          {sheet && <HostedSheet />}
        </FrameDialogHost>
        <FrameSeatToasts />
      </div>
    </>
  )
}

// --- a profile, a window (the tablet shell's props) ---------------------------------------------

const SPACE = 'space'
const TAB = {
  id: 'a',
  spaceId: SPACE,
  containerId: 'default',
  url: 'https://a.example/',
  title: 'a',
  favicon: null,
  pinned: false,
  essential: false,
  pinnedUrl: null,
  customTitle: null,
  customIcon: null,
  windowId: null,
  folderId: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  discarded: false,
  frozen: false,
  cpuThrottle: 1,
  zoom: 1,
  splitGroupId: null,
  createdAt: 0,
  lastActiveAt: 0,
  errorCode: null,
  bookmarked: false,
  readerable: false,
  blockedCount: 0
} as Tab

function tabletState(): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: [TAB.id],
    activeTabId: TAB.id,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: { [TAB.id]: TAB },
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    essentialTabIds: [],
    agents: [],
    awayAgents: [],
    containers: [],
    settings: {
      colorScheme: 'light',
      sidebarSide: 'left',
      sidebarExpanded: true,
      phoneBarPosition: 'bottom',
      pinnedCloseBehavior: 'unload',
      containerSpecificEssentials: false,
      onboardingDone: true
    },
    window: { kind: 'normal', chrome: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    mods: [],
    boosts: [],
    extensions: [],
    bookmarks: [],
    closingTabIds: [],
    permissionRules: [],
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}
/** The same profile on the desktop: the foot draws its plain toast column, not the well. */
const desktopState = (): UIState => ({ ...tabletState(), platform: 'linux' })

// --- the harness --------------------------------------------------------------------------------

let root: Root | null = null
let mount: HTMLDivElement | null = null
const sheets: RecedeHandle[] = []

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}
function rerender(el: ReactElement): void {
  act(() => root!.render(el))
}
const mountTablet = (): void =>
  render(createElement(TabletShell, { state: tabletState(), ui: uiStore.get(), isDark: false }))

const host = (): HTMLElement => document.querySelector<HTMLElement>('.zen-frame-dialogs')!
const slot = (): HTMLElement => host().querySelector<HTMLElement>('.zen-frame-dialogs-slot')!
const seat = (): HTMLElement | null => document.querySelector<HTMLElement>('.zen-frame-toast-seat')
const lifted = (): boolean => seat()?.hasAttribute('data-lifted') ?? false
const foot = (): string => seat()?.style.getPropertyValue('--zen-sheet-footer') ?? ''
const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-dialog="site-permissions"]')
const card = (): HTMLElement | null => seat()?.querySelector<HTMLElement>('[role="status"]') ?? null
const undo = (): HTMLButtonElement | null =>
  seat()?.querySelector<HTMLButtonElement>('button.zen-message-button') ?? null
const control = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[${name}]`)!
const inert = (el: Element | null): boolean => el?.hasAttribute('inert') ?? false
/** Whether anything inert stands over `el`: an ancestor's hold reaches it too. */
const underInert = (el: Element | null): boolean => el?.closest('[inert]') !== null
const active = (): Element | null => document.activeElement
/** How many toast cards announce (`role="status"`): one per toast, through lift and re-seat. */
const statuses = (): number => document.querySelectorAll('.zen-message-toast[role="status"]').length
/** The cards in the Android sidebar's message well (`SidebarBottom`): none of the frame's. */
const wellCards = (): number =>
  document.querySelectorAll('.zen-message-well .zen-message-toast').length
/** The desktop column's plain rows (`SidebarBottom`): none of the frame's. */
const columnRows = (): number => document.querySelectorAll('.zen-toast[role="status"]').length
/** Every drawing of a toast in the document – a card or a plain row: one per act (§9.33). */
const drawings = (): number =>
  document.querySelectorAll('.zen-message-toast[role="status"], .zen-toast[role="status"]').length
/** The layer's slot on the frame: the tablet's rest seat, inside the host's seat element. */
const layerSlot = (): HTMLElement | null =>
  seat()?.querySelector<HTMLElement>('.zen-message-layer > .zen-message-toasts') ?? null

/** End the way out on a mouse: every kept panel's exit animation reports its end. */
const endExit = (): void => {
  act(() => {
    for (const panel of document.querySelectorAll('.zen-frame-dialogs-slot > [data-leaving]')) {
      panel.dispatchEvent(new Event('animationend'))
    }
  })
}

/** A Tab press on the focused control, as the browser delivers it: bubbling from the target. */
const tab = (shift = false, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => {
    active()!.dispatchEvent(e)
  })
  return e
}
const focus = (el: Element | null): void => {
  act(() => (el as HTMLElement).focus())
}
/** A Z chord as the browser delivers it: bubbling from the focused element (the body when none). */
const chord = (init: KeyboardEventInit): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true, ...init })
  act(() => {
    ;(active() ?? document.body).dispatchEvent(e)
  })
  return e
}
const ctrlZ = (): KeyboardEvent => chord({ ctrlKey: true })
/** The focus left nowhere – a pointer's act, the window losing focus: the body. */
const unfocus = (): void => {
  act(() => (active() as HTMLElement | null)?.blur())
  expect(active()).toBe(document.body)
}

/** A hosted sheet comes up on the chassis: on the recede stack from its mount. */
const openSheet = (): RecedeHandle => {
  let handle!: RecedeHandle
  act(() => {
    handle = registerRecedeLayer()
    handle.progress(1)
  })
  sheets.push(handle)
  return handle
}

/**
 * Chromium's blur on removal: a focused node removed from the document gets `blur` and
 * `focusout` with a null `relatedTarget` as it goes – the same events a press on the scrim or
 * the window losing focus gives – where happy-dom, like Firefox, fires none. The desktop drive
 * of W8-F16 found the seat reading that blur as the keyboard leaving it, the focus left on the
 * body once the Undo went; the tests run under Chromium's rule.
 */
const removeChild = Node.prototype.removeChild
const blurOnRemoval = (): void => {
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    const focused = document.activeElement
    if (focused && focused !== document.body && child.contains(focused)) {
      focused.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }))
      focused.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    }
    return removeChild.call(this, child) as T
  }
}

beforeEach(() => {
  blurOnRemoval()
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', () => 1)
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
  uiStore.set({ toasts: [], banners: [], screenshotCards: [], frameDialogsOpen: 0 })
  viewportStore.set({
    formFactor: 'desktop',
    width: 1600,
    height: 1000,
    coarse: false,
    hover: true
  })
  tabletDialogUp = false
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  Node.prototype.removeChild = removeChild
  for (const sheet of sheets.splice(0)) sheet.release()
  uiStore.set({ toasts: [], banners: [], screenshotCards: [], frameDialogsOpen: 0 })
  viewportStore.set({
    formFactor: 'desktop',
    width: 1600,
    height: 1000,
    coarse: false,
    hover: true
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
  vi.useRealTimers()
})

describe('the seat: inside the host, outside both of its holds (desktop)', () => {
  it('stands after the slot in the host, under neither hold, and lifts the toast the dialog raised over the dialog', () => {
    render(<Desktop dialog />)
    // The holds are on: the window chrome and the frame's page are inert, the host and its seat
    // are not – `holdChromeInert` marks nothing under `.zen-frame-dialogs`, `holdFrameInert`
    // covers the host's siblings alone.
    expect(chromeInertHeld()).toBe(true)
    expect(inert(control('data-surface="window"'))).toBe(true)
    expect(inert(control('data-page'))).toBe(true)
    expect(underInert(host())).toBe(false)
    expect(underInert(dialog())).toBe(false)
    const seatEl = seat()!
    expect(host().contains(seatEl)).toBe(true)
    expect(seatEl.previousElementSibling).toBe(slot())
    expect(seatEl.closest('.zen-frame-dialogs-slot')).toBeNull()
    // Nothing to lift yet: at the normal seat it is inert with the chrome (§9.22 – nothing
    // focusable is left behind the scrim), and the shells read it from the registry.
    expect(lifted()).toBe(false)
    expect(inert(seatEl)).toBe(true)
    expect(frameToastSeat().element).toBe(seatEl)
    expect(frameToastSeat().standing).toBe(true)

    // Allow again: the toast is seated on the frame and the seat lifts – z 2 over the slot's 1
    // (main.css), undimmed – with the card in it and its Undo in reach.
    act(() => control('data-allow-again').click())
    const toast = uiStore.get().toasts[0]!
    expect(toast.seat).toBe('frame')
    expect(toast.duration).toBe(TOAST_UNDO_MS)
    expect(lifted()).toBe(true)
    expect(inert(seatEl)).toBe(false)
    expect(frameToastSeat().lifted).toBe(true)
    expect(card()?.textContent).toContain('Permissions allowed again for meet.example')
    expect(seatEl.contains(card())).toBe(true)
    expect(underInert(undo())).toBe(false)
    expect(undo()?.textContent).toBe('Undo')
    // Never inside the dialog box (§9.33's footer clause: no toast over an actions band).
    expect(dialog()!.contains(card())).toBe(false)
    // The dialog still stands, in reach, over its scrim.
    expect(host().getAttribute('data-open')).toBe('true')
    expect(underInert(dialog())).toBe(false)
    expect(statuses()).toBe(1)
  })

  it('takes the Undo by pointer: the act runs and the toast goes, the dialog standing on', () => {
    render(<Desktop dialog />)
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    expect(lifted()).toBe(true)
    act(() => undo()!.click())
    expect(onPick).toHaveBeenCalledTimes(1)
    // The desktop keeps no cards' semantics: the toast is forgotten at once, the seat drops.
    expect(uiStore.get().toasts).toEqual([])
    expect(card()).toBeNull()
    expect(lifted()).toBe(false)
    expect(dialog()).not.toBeNull()
    expect(underInert(dialog())).toBe(false)
  })

  it("keeps the toast's seat when the dialog closes – the orphan case: the same card, its clock running on, one announcement", () => {
    render(<Desktop dialog />)
    act(() => {
      allowAgain()
    })
    const node = card()!
    act(() => vi.advanceTimersByTime(3000))
    // Got it: the dialog closes. On a mouse the host keeps its panel through the pop out and
    // holds the chrome for it – the seat stays lifted over the panel on its way out.
    act(() => control('data-got-it').click())
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(host().getAttribute('data-leaving')).toBe('true')
    expect(lifted()).toBe(true)
    expect(card()).toBe(node)
    // The way out ends: the normal seat, no hold, the same element – no remount, so the status
    // region is not announced again; the frame's box is where it lands (the page).
    endExit()
    expect(host().hasAttribute('data-leaving')).toBe(false)
    expect(chromeInertHeld()).toBe(false)
    expect(lifted()).toBe(false)
    expect(inert(seat())).toBe(false)
    expect(card()).toBe(node)
    expect(seat()!.contains(node)).toBe(true)
    expect(statuses()).toBe(1)
    expect(uiStore.get().toasts[0]?.seat).toBe('frame')
    // The rest of its 8 s, not a new clock: 3 s were spent under the dialog.
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS - 3000 - 1))
    expect(uiStore.get().toasts).toHaveLength(1)
    expect(card()).toBe(node)
    act(() => vi.advanceTimersByTime(1))
    expect(uiStore.get().toasts).toEqual([])
  })

  it("lifts again for a dialog that opens while the orphaned toast is still up (Chrome's rule)", () => {
    render(<Desktop dialog />)
    act(() => {
      allowAgain()
    })
    act(() => control('data-got-it').click())
    endExit()
    expect(lifted()).toBe(false)
    rerender(<Desktop dialog />)
    expect(lifted()).toBe(true)
    expect(inert(seat())).toBe(false)
    expect(underInert(undo())).toBe(false)
  })

  it("a toast raised once the dialog has closed is the column's, not the frame's – the registry's count, not the way out", () => {
    render(<Desktop dialog />)
    act(() => control('data-got-it').click())
    // The panel is still on its way out, the chrome still held; the count is 0.
    expect(host().getAttribute('data-leaving')).toBe('true')
    act(() => {
      pushToast('Review complete for 3 sites', 'info', { duration: TOAST_UNDO_MS })
    })
    expect(uiStore.get().toasts[0]?.seat).toBeUndefined()
    expect(card()).toBeNull()
    expect(lifted()).toBe(false)
    endExit()
    act(() => {
      pushToast('Saved to Bookmarks')
    })
    expect(uiStore.get().toasts.map((t) => t.seat)).toEqual([undefined, undefined])
    expect(card()).toBeNull()
  })

  it("the sidebar's column draws no row for a toast the seat holds – one card per act (§9.33); a toast raised after the close is the column's row", () => {
    render(<Desktop dialog />)
    act(() => {
      allowAgain()
    })
    // The frame's card is the toast's one drawing: the plain column skips `seat === 'frame'`.
    expect(card()).not.toBeNull()
    expect(columnRows()).toBe(0)
    expect(drawings()).toBe(1)
    // Through the close and after it – the orphan keeps its seat, the column still none.
    act(() => control('data-got-it').click())
    endExit()
    expect(seat()!.contains(card())).toBe(true)
    expect(columnRows()).toBe(0)
    expect(drawings()).toBe(1)
    // A toast the frame does not hold is the column's, as it always was: a row, no card.
    act(() => {
      pushToast('Review complete for 3 sites', 'info', { duration: TOAST_UNDO_MS })
    })
    expect(uiStore.get().toasts.map((t) => t.seat)).toEqual(['frame', undefined])
    expect(columnRows()).toBe(1)
    expect(document.querySelector('.zen-toast')?.textContent).toContain('Review complete')
    expect(seat()!.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(drawings()).toBe(2)
  })

  it('at the normal seat it follows the chrome hold: inert under a hold that is no dialog of the host, in reach once it lifts', () => {
    render(<Desktop />)
    act(() => {
      pushToast('Saved to Bookmarks', 'info', { duration: TOAST_UNDO_MS })
    })
    expect(inert(seat())).toBe(false)
    // A capture overlay, a sheet on its own chassis: the chrome is held, no dialog stands.
    let release!: () => void
    act(() => {
      release = holdChromeInert()
    })
    expect(inert(seat())).toBe(true)
    act(() => release())
    expect(inert(seat())).toBe(false)
  })

  it('renders no seat on a phone: the phone has its own lift (#651)', () => {
    viewportStore.set({ formFactor: 'phone', width: 400, height: 800, coarse: true, hover: false })
    render(<Desktop dialog />)
    expect(seat()).toBeNull()
    expect(frameToastSeat().element).toBeNull()
  })
})

describe('the keyboard: the Undo is the last stop of the dialog’s Tab cycle (§9.22)', () => {
  it('Tab at the dialog’s last control goes to the Undo, Tab from the Undo to its first; Shift+Tab reverses', () => {
    render(<Desktop dialog />)
    act(() => {
      allowAgain()
    })
    // The dialog took the focus in as it opened: its first control.
    expect(active()).toBe(control('data-allow-again'))
    // Tab inside the dialog is the dialog's own: the seat leaves the key alone.
    expect(tab().defaultPrevented).toBe(false)
    focus(control('data-got-it'))
    let e = tab()
    expect(e.defaultPrevented).toBe(true)
    expect(active()).toBe(undo())
    // From the Undo: past the toast's last control to the dialog's first.
    e = tab()
    expect(e.defaultPrevented).toBe(true)
    expect(active()).toBe(control('data-allow-again'))
    // Shift+Tab at the dialog's first control: back to the Undo.
    e = tab(true)
    expect(e.defaultPrevented).toBe(true)
    expect(active()).toBe(undo())
    // Shift+Tab from the Undo: the dialog's last control.
    e = tab(true)
    expect(e.defaultPrevented).toBe(true)
    expect(active()).toBe(control('data-got-it'))
  })

  it('Ctrl+Tab and the other chords are not its: it takes the plain Tab, and Ctrl+Z alone', () => {
    render(<Desktop dialog />)
    act(() => {
      allowAgain()
    })
    focus(control('data-got-it'))
    // Ctrl+Tab at the dialog's last control: the seat is no stop for it – whatever the dialog's
    // own wrap does with the key, the focus does not reach the Undo.
    tab(false, { ctrlKey: true })
    expect(active()).not.toBe(undo())
    expect(dialog()!.contains(active())).toBe(true)
    // Ctrl+Y (redo elsewhere) is nothing of the seat's.
    const y = new KeyboardEvent('keydown', {
      key: 'y',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })
    act(() => {
      active()!.dispatchEvent(y)
    })
    expect(y.defaultPrevented).toBe(false)
    expect(card()).not.toBeNull()
  })

  it('the stop leaves the cycle with the toast: Undo pressed by keyboard, the focus returns to the dialog’s element', () => {
    render(<Desktop dialog />)
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    focus(control('data-got-it'))
    tab()
    expect(active()).toBe(undo())
    // Enter on the button is its click.
    act(() => undo()!.click())
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(card()).toBeNull()
    expect(lifted()).toBe(false)
    expect(active()).toBe(dialog())
    // From the dialog's element Tab enters at its first control: the dialog's own wrap.
    tab()
    expect(active()).toBe(control('data-allow-again'))
  })

  it('the toast timing out under the keyboard returns the focus the same way', () => {
    render(<Desktop dialog />)
    act(() => {
      allowAgain()
    })
    focus(control('data-got-it'))
    tab()
    expect(active()).toBe(undo())
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS))
    expect(uiStore.get().toasts).toEqual([])
    expect(active()).toBe(dialog())
  })

  it('a blur naming no place while the Undo stands – the window losing focus – returns nothing when other cards change; the Undo going does', () => {
    render(<Desktop dialog />)
    act(() => {
      allowAgain()
    })
    focus(control('data-got-it'))
    tab()
    expect(active()).toBe(undo())
    // The window loses focus: `blur` and `focusout` with no `relatedTarget`, the control standing.
    act(() => undo()!.blur())
    expect(active()).toBe(document.body)
    // Another card comes and goes: the Undo stands on, the focus is left where it is.
    act(() => {
      pushToast('Saved', 'info', { duration: 1000 })
    })
    expect(active()).toBe(document.body)
    act(() => vi.advanceTimersByTime(1000))
    expect(active()).toBe(document.body)
    // The Undo goes with its clock: the focus returns to the dialog.
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS))
    expect(uiStore.get().toasts).toEqual([])
    expect(active()).toBe(dialog())
  })

  it('with no dialog the seat is no stop of anything: Tab is left alone', () => {
    render(<Desktop dialog />)
    act(() => {
      allowAgain()
    })
    act(() => control('data-got-it').click())
    endExit()
    expect(lifted()).toBe(false)
    focus(control('data-page-button'))
    expect(tab().defaultPrevented).toBe(false)
  })
})

describe('Ctrl+Z: the Undo’s shortcut while the seat is lifted (§9.33; the lead’s pick was both)', () => {
  it('Ctrl+Z presses the lifted card’s Undo: the act runs once, the key is taken before anything below the window, the card goes, the focus is the dialog’s', () => {
    render(<Desktop dialog />)
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    expect(lifted()).toBe(true)
    // A pointer's act left the focus nowhere: the body.
    unfocus()
    // Whatever listens below the seat's window capture listener – a dialog's own on the
    // document, a page's – never sees the taken key.
    const below = vi.fn()
    document.addEventListener('keydown', below, true)
    const e = ctrlZ()
    document.removeEventListener('keydown', below, true)
    expect(e.defaultPrevented).toBe(true)
    expect(below).not.toHaveBeenCalled()
    expect(onPick).toHaveBeenCalledTimes(1)
    // The desktop keeps no cards' semantics: the toast is forgotten at once, the seat drops, the
    // dialog stands on with the keyboard on its element (the Enter path's landing).
    expect(uiStore.get().toasts).toEqual([])
    expect(card()).toBeNull()
    expect(lifted()).toBe(false)
    expect(dialog()).not.toBeNull()
    expect(underInert(dialog())).toBe(false)
    expect(active()).toBe(dialog())
    // From the dialog's element Tab enters at its first control: the dialog's own wrap.
    tab()
    expect(active()).toBe(control('data-allow-again'))
  })

  it('Cmd+Z is the same chord (a Mac); the key is one Z, whatever the case', () => {
    render(<Desktop dialog />)
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    expect(chord({ metaKey: true }).defaultPrevented).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(card()).toBeNull()
    // Caps Lock: the key reads 'Z' with no Shift.
    act(() => {
      allowAgain(onPick)
    })
    expect(chord({ ctrlKey: true, key: 'Z' }).defaultPrevented).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(2)
    expect(card()).toBeNull()
  })

  it('with Shift (redo), Alt, both modifiers or none the key is not its: it falls through, the toast standing', () => {
    render(<Desktop dialog />)
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    const chords: KeyboardEventInit[] = [
      { ctrlKey: true, shiftKey: true, key: 'Z' },
      { metaKey: true, shiftKey: true, key: 'Z' },
      { ctrlKey: true, altKey: true },
      { metaKey: true, altKey: true },
      { ctrlKey: true, metaKey: true },
      { altKey: true },
      {}
    ]
    for (const init of chords)
      expect(chord(init).defaultPrevented, JSON.stringify(init)).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
    expect(card()).not.toBeNull()
    expect(lifted()).toBe(true)
  })

  it('not while a text field has the focus – an input, a textarea, a contenteditable – whose own undo the chord is', () => {
    render(<Desktop dialog />)
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    for (const field of ['data-note', 'data-memo', 'data-scratch']) {
      focus(control(field))
      expect(active(), field).toBe(control(field))
      expect(ctrlZ().defaultPrevented, field).toBe(false)
    }
    expect(onPick).not.toHaveBeenCalled()
    expect(card()).not.toBeNull()
    // On a button again the chord is the Undo's.
    focus(control('data-got-it'))
    expect(ctrlZ().defaultPrevented).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(card()).toBeNull()
  })

  it('nothing when no card stands, when the top card offers no Undo, or when the seat is not lifted: the key falls through as it did', () => {
    render(<Desktop dialog />)
    const onPick = vi.fn()
    const view = vi.fn()
    // No card: the seat un-lifted under the standing dialog.
    expect(lifted()).toBe(false)
    expect(ctrlZ().defaultPrevented).toBe(false)
    // A card with no action, lifted.
    act(() => {
      pushToast('Saved to Bookmarks', 'info', { duration: TOAST_UNDO_MS })
    })
    expect(lifted()).toBe(true)
    expect(ctrlZ().defaultPrevented).toBe(false)
    expect(uiStore.get().toasts).toHaveLength(1)
    // A card whose action is not Undo.
    act(() => {
      pushToast('Saved to Bookmarks', 'info', {
        duration: TOAST_UNDO_MS,
        action: { label: 'View', onPick: view }
      })
    })
    expect(ctrlZ().defaultPrevented).toBe(false)
    expect(view).not.toHaveBeenCalled()
    expect(uiStore.get().toasts).toHaveLength(2)
    // The top card is the newest: an Undo under a newer card without one is not pressed.
    act(() => {
      allowAgain(onPick)
    })
    act(() => {
      pushToast('Review complete for 3 sites', 'info', { duration: 1000 })
    })
    expect(uiStore.get().toasts).toHaveLength(4)
    expect(ctrlZ().defaultPrevented).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
    // Its own clock takes the newest away: the Undo is the top card again, and pressed.
    act(() => vi.advanceTimersByTime(1000))
    expect(uiStore.get().toasts).toHaveLength(3)
    expect(uiStore.get().toasts.at(-1)?.action?.label).toBe('Undo')
    expect(ctrlZ().defaultPrevented).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(uiStore.get().toasts).toHaveLength(2)
    expect(seat()!.querySelector('[data-action="undo"]')).toBeNull()
    // The seat not lifted with an Undo toast on top: the orphan case, the dialog gone.
    act(() => {
      allowAgain(onPick)
    })
    act(() => control('data-got-it').click())
    endExit()
    expect(lifted()).toBe(false)
    expect(seat()!.querySelectorAll('.zen-message-toast[data-action="undo"]')).toHaveLength(1)
    focus(control('data-page-button'))
    expect(ctrlZ().defaultPrevented).toBe(false)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(seat()!.querySelectorAll('.zen-message-toast[data-action="undo"]')).toHaveLength(1)
  })

  it('the focus: from the Undo reached by Tab, or from the body, it returns to the dialog’s element as on the Enter path; a dialog control that has it keeps it', () => {
    render(<Desktop dialog />)
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    focus(control('data-got-it'))
    tab()
    expect(active()).toBe(undo())
    expect(ctrlZ().defaultPrevented).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(card()).toBeNull()
    expect(active()).toBe(dialog())
    // From the body (a pointer's act, the window back from elsewhere).
    act(() => {
      allowAgain(onPick)
    })
    unfocus()
    ctrlZ()
    expect(onPick).toHaveBeenCalledTimes(2)
    expect(active()).toBe(dialog())
    // From a control of the dialog: the user's place is kept.
    act(() => {
      allowAgain(onPick)
    })
    focus(control('data-got-it'))
    ctrlZ()
    expect(onPick).toHaveBeenCalledTimes(3)
    expect(card()).toBeNull()
    expect(active()).toBe(control('data-got-it'))
  })

  it('a hosted sheet on its own chassis: the chord presses the Undo lifted over the sheet too', () => {
    render(<Desktop sheet />)
    openSheet()
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    expect(lifted()).toBe(true)
    expect(ctrlZ().defaultPrevented).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(card()).toBeNull()
  })
})

describe("the lifted seat's bottom edge: the frame's inset, or a hosted sheet's footer band (Q1)", () => {
  it('stands at the frame’s inset over a dialog: the seat says nothing of a band', () => {
    render(<Desktop dialog />)
    act(() => {
      allowAgain()
    })
    expect(lifted()).toBe(true)
    expect(foot()).toBe('')
  })

  it('stands on the footer band a hosted sheet publishes to the registry, and follows it', () => {
    render(<Desktop sheet />)
    const sheet = openSheet()
    act(() => {
      allowAgain()
    })
    // The sheet holds the chrome itself (`ownScrim`); the seat lifts for the standing sheet.
    expect(uiStore.get().toasts[0]?.seat).toBe('frame')
    expect(lifted()).toBe(true)
    expect(foot()).toBe('')
    act(() => sheet.footer(64))
    expect(foot()).toBe('64px')
    act(() => sheet.footer(72))
    expect(foot()).toBe('72px')
    act(() => sheet.footer(0))
    expect(foot()).toBe('')
  })

  it('the stylesheet: the seat is the host’s box after the slot, z 2 over the slot’s 1 while lifted, its layer’s bottom on the band, the card 8 inside the frame’s edge', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at, selector).toBeGreaterThan(0)
      return css.slice(at, css.indexOf('}', at))
    }
    expect(rule('.zen-frame-toast-seat').replace(/\s+/g, ' ')).toContain(
      'position: absolute; inset: 0; pointer-events: none;'
    )
    expect(rule('.zen-frame-toast-seat[data-lifted]')).toContain('z-index: 2;')
    expect(rule('.zen-frame-dialogs-slot')).toContain('z-index: 1;')
    // Unlayered with the message layer's own rules, which it amends.
    expect(rule('.zen-frame-toast-seat[data-lifted] > .zen-message-layer')).toContain(
      'bottom: var(--zen-sheet-footer, 0px);'
    )
    expect(rule('.zen-message-toasts')).toContain('bottom: var(--zen-message-inset);')
    expect(css).toContain('--zen-message-inset: 8px;')
    // Several framed toasts on the desktop stack, 8 apart.
    expect(rule('.zen-frame-toasts')).toContain('row-gap: 8px;')
  })
})

describe('the tablet (§9.36): the shell seats the slot in the host’s seat, the host under no chrome mark', () => {
  beforeEach(() => {
    viewportStore.set({
      formFactor: 'tablet',
      width: 1280,
      height: 800,
      coarse: true,
      hover: false
    })
  })

  it('the host stands under no `data-shell-chrome`; the sidebar, the content area and the message frame carry the mark', () => {
    mountTablet()
    expect(host().closest('[data-shell-chrome]')).toBeNull()
    expect(control('data-sidebar-button').closest('[data-shell-chrome]')).not.toBeNull()
    expect(control('data-page-button').closest('[data-shell-chrome]')).not.toBeNull()
    const frame = document.querySelector('.zen-tablet-message-frame')!
    expect(frame.hasAttribute('data-shell-chrome')).toBe(true)
    // The seat is published for the shell, empty of cards.
    expect(frameToastSeat().element).toBe(seat())
  })

  it('a hosted dialog holds the chrome around it and stays in reach itself, its seat with it', () => {
    mountTablet()
    act(() => setTabletDialog(true))
    expect(chromeInertHeld()).toBe(true)
    expect(underInert(control('data-sidebar-button'))).toBe(true)
    expect(underInert(control('data-page-button'))).toBe(true)
    expect(underInert(document.querySelector('.zen-tablet-message-frame'))).toBe(true)
    // The regression the shell guards: the row that held these as one root held the host too,
    // and the hold made the dialog inert.
    expect(underInert(host())).toBe(false)
    expect(underInert(dialog())).toBe(false)
    expect(active()).toBe(control('data-allow-again'))
    // The seat holds nothing: inert with the chrome, as the phone's frame at its normal seat.
    expect(inert(seat())).toBe(true)
    expect(underInert(seat()!.parentElement)).toBe(false)
  })

  it("Allow again's toast: the layer's slot, portalled into the seat, lifts over the dialog with its Undo in reach; the banners stay on the frame", () => {
    mountTablet()
    act(() => {
      showBanner({ title: 'Translate this page?' })
    })
    act(() => setTabletDialog(true))
    act(() => control('data-allow-again').click())
    const frame = document.querySelector<HTMLElement>('.zen-tablet-message-frame')!
    expect(lifted()).toBe(true)
    expect(inert(seat())).toBe(false)
    expect(underInert(undo())).toBe(false)
    expect(seat()!.querySelector('.zen-message-toasts [role="status"]')).toBe(card())
    expect(card()?.textContent).toContain('Permissions allowed again for meet.example')
    expect(dialog()!.contains(card())).toBe(false)
    // The slot is the seat's alone; the message frame keeps the banner stack, under the dialog.
    expect(frame.querySelector('.zen-message-toast')).toBeNull()
    expect(frame.querySelector('.zen-banner')?.textContent).toContain('Translate this page?')
    expect(seat()!.querySelector('.zen-banner')).toBeNull()
    expect(underInert(frame)).toBe(true)
    expect(statuses()).toBe(1)
    // Tab from the dialog's last control reaches the Undo on a keyboard (DeX).
    focus(control('data-got-it'))
    expect(tab().defaultPrevented).toBe(true)
    expect(active()).toBe(undo())
    // The press: the act runs, the card leaves in the seat (the layer's cards' semantics), and
    // the keyboard is back on the dialog.
    act(() => undo()!.click())
    expect(uiStore.get().toasts[0]?.leaving).toBe(true)
    expect(active()).toBe(dialog())
  })

  it('the orphan case on the tablet: the dialog closes, the toast lands on the frame – the same card, its clock running on', () => {
    mountTablet()
    act(() => setTabletDialog(true))
    act(() => control('data-allow-again').click())
    const node = card()!
    act(() => vi.advanceTimersByTime(2000))
    act(() => control('data-got-it').click())
    expect(dialog()).not.toBeNull()
    expect(lifted()).toBe(true)
    endExit()
    expect(dialog()).toBeNull()
    expect(chromeInertHeld()).toBe(false)
    expect(lifted()).toBe(false)
    expect(inert(seat())).toBe(false)
    expect(card()).toBe(node)
    expect(statuses()).toBe(1)
    expect(uiStore.get().toasts[0]?.leaving).toBeUndefined()
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS - 2000 - 1))
    expect(uiStore.get().toasts[0]?.leaving).toBeUndefined()
    act(() => vi.advanceTimersByTime(1))
    expect(uiStore.get().toasts[0]?.leaving).toBe(true)
    expect(card()).toBe(node)
  })

  it('the well draws none of a toast the seat holds: the card is once in the document, in the seat, its Undo the one Undo (§9.33: one card per act)', () => {
    mountTablet()
    act(() => setTabletDialog(true))
    act(() => control('data-allow-again').click())
    expect(lifted()).toBe(true)
    // Every tablet toast is the frame's (`Toast.seat`: the shell shows the cards), so the
    // sidebar's well – the second copy the tablet drew – skips it as the desktop's rows do.
    expect(uiStore.get().toasts[0]?.seat).toBe('frame')
    expect(document.querySelector('.zen-message-well')).toBeNull()
    expect(wellCards()).toBe(0)
    expect(statuses()).toBe(1)
    expect(drawings()).toBe(1)
    expect(seat()!.contains(card())).toBe(true)
    expect(document.querySelectorAll('button.zen-message-button')).toHaveLength(1)
    expect(document.querySelector('button.zen-message-button')).toBe(undo())
    // The sidebar's own control is under the hold; the one Undo is not.
    expect(underInert(control('data-sidebar-button'))).toBe(true)
    expect(underInert(undo())).toBe(false)
  })

  it("the tablet's rest state as it is today: the dialog closes and the card is the layer's slot's on the frame – the seat un-lifted around it – the well none", () => {
    mountTablet()
    act(() => setTabletDialog(true))
    act(() => control('data-allow-again').click())
    const node = card()!
    act(() => control('data-got-it').click())
    endExit()
    expect(dialog()).toBeNull()
    expect(lifted()).toBe(false)
    expect(frameToastSeat().lifted).toBe(false)
    // The card returned to the slot: the layer's `.zen-message-toasts` on the frame, which the
    // tablet seats in the host's seat element for good (no remount) – the same node.
    expect(layerSlot()!.contains(node)).toBe(true)
    expect(card()).toBe(node)
    expect(wellCards()).toBe(0)
    expect(document.querySelector('.zen-message-well')).toBeNull()
    expect(statuses()).toBe(1)
    expect(drawings()).toBe(1)
    // A toast with no dialog at all rests the same way: the frame's slot, the well none.
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS + 1000))
    act(() => {
      pushToast('Saved to Bookmarks', 'info', { duration: TOAST_UNDO_MS })
    })
    expect(uiStore.get().toasts.map((t) => t.seat)).toEqual(['frame'])
    expect(lifted()).toBe(false)
    expect(layerSlot()!.contains(card())).toBe(true)
    expect(card()?.textContent).toContain('Saved to Bookmarks')
    expect(wellCards()).toBe(0)
    expect(drawings()).toBe(1)
  })

  it('a toast up before the dialog opened lifts too, for the rest of its clock', () => {
    mountTablet()
    act(() => {
      pushToast('Saved to Bookmarks', 'info', { duration: TOAST_UNDO_MS })
    })
    expect(lifted()).toBe(false)
    expect(inert(seat())).toBe(false)
    act(() => setTabletDialog(true))
    expect(lifted()).toBe(true)
    expect(inert(seat())).toBe(false)
    expect(card()?.textContent).toContain('Saved to Bookmarks')
  })

  it('a sheet on its own chassis with no dialog: the seat is inert with the chrome, the toast under the sheet', () => {
    mountTablet()
    act(() => {
      pushToast('Saved to Bookmarks', 'info', { duration: TOAST_UNDO_MS })
    })
    let release!: () => void
    act(() => {
      release = holdChromeInert()
    })
    expect(lifted()).toBe(false)
    expect(inert(seat())).toBe(true)
    act(() => release())
    expect(inert(seat())).toBe(false)
  })

  it('Ctrl+Z on a keyboard (DeX) presses the lifted Undo: the card leaves in the seat, the key taken, the focus the dialog’s; Cmd+Z too; Shift, a text field, an un-lifted seat fall through', () => {
    mountTablet()
    act(() => setTabletDialog(true))
    const onPick = vi.fn()
    act(() => {
      allowAgain(onPick)
    })
    expect(lifted()).toBe(true)
    const live = (): number => uiStore.get().toasts.filter((t) => !t.leaving).length
    // Ctrl+Shift+Z is redo, not the seat's; from a text field the chord is the field's own.
    expect(chord({ ctrlKey: true, shiftKey: true, key: 'Z' }).defaultPrevented).toBe(false)
    focus(control('data-note'))
    expect(ctrlZ().defaultPrevented).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
    expect(live()).toBe(1)
    // From the Undo reached by Tab: the act runs, the card leaves (the layer's cards'
    // semantics), and the keyboard is back on the dialog's element as on the Enter path.
    focus(control('data-got-it'))
    tab()
    expect(active()).toBe(undo())
    const e = ctrlZ()
    expect(e.defaultPrevented).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(uiStore.get().toasts[0]?.leaving).toBe(true)
    expect(live()).toBe(0)
    expect(active()).toBe(dialog())
    expect(dialog()).not.toBeNull()
    // Cmd+Z, from a control of the dialog: the same press, the control keeping the focus.
    act(() => {
      allowAgain(onPick)
    })
    expect(live()).toBe(1)
    focus(control('data-allow-again'))
    expect(chord({ metaKey: true }).defaultPrevented).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(2)
    expect(live()).toBe(0)
    expect(active()).toBe(control('data-allow-again'))
    // The seat un-lifted – the dialog closed under the toast (the orphan case): the key falls through.
    act(() => vi.advanceTimersByTime(1000))
    act(() => {
      allowAgain(onPick)
    })
    act(() => control('data-got-it').click())
    endExit()
    expect(dialog()).toBeNull()
    expect(lifted()).toBe(false)
    expect(live()).toBe(1)
    expect(ctrlZ().defaultPrevented).toBe(false)
    expect(onPick).toHaveBeenCalledTimes(2)
    expect(live()).toBe(1)
  })
})

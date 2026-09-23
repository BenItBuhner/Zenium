import type { Rect, Tab } from '@shared/types'
import { pushBackSurface } from './back'
import type { LevelId } from './siteInfoCopy'
import { createStore } from './store'
import {
  captureActiveTab,
  chromeNeedsKeyboard,
  invalidateSnapshot,
  returnFocusToPage,
  uiStore
} from './ui'
import { run } from './api'

export interface SiteInfoState {
  /** Tab whose site the sheet describes (null → nothing open). */
  tabId: string | null
  /** Where the site icon that opened it is (window coordinates); anchors the desktop popover. */
  anchor: Rect | null
  /** Bumped by actions so the sheet reads the site again. */
  revision: number
  /**
   * The level the surface opens on (omnibox-38): the overview from the site icon and the
   * shield; Permissions from the pill's in-use chip and its blocked-permission icons, which
   * speak of one permission and lead straight to its row. Read once, as the surface mounts.
   */
  level: LevelId
}

export const siteInfoStore = createStore<SiteInfoState>(
  { tabId: null, anchor: null, revision: 0, level: 'overview' },
  'site-info'
)

/** The chip that opened the sheet from the keyboard's point of view; it gets the focus back. */
let opener: HTMLElement | null = null

/**
 * What the mounted surface (the phone sheet on the `BottomSheet` chassis, or the desktop
 * popover) exposes to this module: the sheet's own motion lives in the chassis, the levels
 * inside it (certificate, cookies, permissions) in the component, so dismissal and the system
 * back gesture are routed through here to whichever of the two should answer.
 */
export interface SiteInfoSurface {
  /** Levels pushed above the root. */
  depth(): number
  /** Return one level (the back button, Escape). */
  pop(): void
  /** Slide the surface away; `finishClose` runs once it is gone. */
  dismiss(): void
  /** Predictive back on the top level: peek it away, commit, or spring back. */
  backProgress(p: number): void
  backCommit(): void
  backCancel(): void
}

let surface: SiteInfoSurface | null = null

export function registerSiteInfoSurface(next: SiteInfoSurface | null): void {
  surface = next
}

/** The chip the open surface hangs from, for the popover's light dismiss (§9.20). */
export function siteInfoOpener(): HTMLElement | null {
  return opener
}

export function siteInfoIsOpen(): boolean {
  return siteInfoStore.get().tabId !== null
}

/**
 * Open the site information for `tab`, from the site icon at `anchor`. The live page is
 * captured first so the dimmed snapshot can stand in behind the sheet (hosts hide page views
 * under chrome overlays). `from` is the chip that opened it: when the sheet closes, the
 * keyboard goes back there rather than to the page (design language v2 §9.22). `level` opens
 * the surface on one of its levels rather than the overview (the in-use chip and the blocked-
 * permission icons open it on Permissions, omnibox-38).
 */
export async function openSiteInfo(
  tab: Tab,
  anchor: Rect | null = null,
  from: HTMLElement | null = null,
  { level = 'overview' }: { level?: LevelId } = {}
): Promise<void> {
  if (siteInfoStore.get().tabId === tab.id) return
  await captureActiveTab(tab.id)
  run('focus.chrome', undefined)
  opener = from
  uiStore.set({ siteInfoOpen: true, drawerOpen: false })
  siteInfoStore.set({ tabId: tab.id, anchor, revision: 0, level })
}

/** Dismiss with the spring (a tap outside, the back gesture, Escape). */
export function closeSiteInfo(): void {
  if (!siteInfoIsOpen()) return
  if (surface) surface.dismiss()
  else finishClose()
}

/** Drop the sheet at once: another surface took over or the layout changed. */
export function dismissSiteInfo(): void {
  if (!siteInfoIsOpen()) return
  finishClose()
}

/** The surface has left the screen (its chassis reported the dismissal). */
export function siteInfoDismissed(): void {
  if (siteInfoIsOpen()) finishClose()
}

/** Escape, or the back button: one level up, or away. */
export function stepBackSiteInfo(): void {
  if (surface && surface.depth() > 0) surface.pop()
  else closeSiteInfo()
}

/** An action changed the site's state: read it again. */
export function refreshSiteInfo(): void {
  siteInfoStore.set((s) => ({ revision: s.revision + 1 }))
}

/**
 * Progress-driven dismissal for the system back gesture: the back-surface registry (`back.ts`)
 * drives the surface through these as the swipe advances, for as long as the sheet is open.
 * With a level pushed, the gesture peeks and pops that level; on the root it pulls the sheet.
 */
export const siteInfoBack = {
  isOpen: (): boolean => siteInfoIsOpen(),
  progress: (p: number): void => surface?.backProgress(p),
  commit: (): void => {
    if (surface) surface.backCommit()
    else finishClose()
  },
  cancel: (): void => surface?.backCancel()
}

function finishClose(): void {
  const from = opener
  opener = null
  siteInfoStore.set({ tabId: null, anchor: null, level: 'overview' })
  if (uiStore.get().siteInfoOpen) uiStore.set({ siteInfoOpen: false })
  invalidateSnapshot()
  // Escape, a click outside, the back gesture: the keyboard returns to the chip that opened the
  // sheet while it is still in the document and no other chrome surface has taken over (the
  // URL bar or a menu opening over the sheet dismisses it and keeps the keyboard); otherwise
  // the page gets it back, as after every other surface.
  if (from?.isConnected && !chromeNeedsKeyboard()) from.focus()
  else returnFocusToPage()
}

const flags = globalThis as unknown as { __zenSiteInfoWired?: boolean }
if (!flags.__zenSiteInfoWired) {
  flags.__zenSiteInfoWired = true
  // The open sheet is a back surface: the gesture peeks it away, commit dismisses, cancel presents.
  let popBackSurface: (() => void) | null = null
  siteInfoStore.subscribe(() => {
    const open = siteInfoIsOpen()
    if (open && !popBackSurface) {
      popBackSurface = pushBackSurface({
        name: 'site-info',
        onProgress: siteInfoBack.progress,
        onCommit: siteInfoBack.commit,
        onCancel: siteInfoBack.cancel
      })
    } else if (!open && popBackSurface) {
      popBackSurface()
      popBackSurface = null
    }
  })
  // Another chrome surface (URL bar, panel, drawer, menu) replaces the sheet outright.
  uiStore.subscribe(() => {
    const ui = uiStore.get()
    if ((ui.urlbar.open || ui.overlay !== 'none' || ui.drawerOpen || ui.menu) && siteInfoIsOpen())
      dismissSiteInfo()
  })
}

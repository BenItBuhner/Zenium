import type { Rect, Tab } from '@shared/types'
import { pushBackSurface } from './back'
import { SHEET_CLOSED, SheetMotion, type SheetState } from './motion/sheet'
import { createStore } from './store'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from './ui'
import { run } from './api'

export interface SiteInfoState {
  /** Tab whose site the sheet describes (null → nothing open). */
  tabId: string | null
  /** Where the site icon that opened it is (window coordinates); anchors the desktop popover. */
  anchor: Rect | null
  /** Motion of the phone sheet. */
  sheet: SheetState
  /** Bumped by actions so the sheet reads the site again. */
  revision: number
}

export const siteInfoStore = createStore<SiteInfoState>(
  { tabId: null, anchor: null, sheet: SHEET_CLOSED, revision: 0 },
  'site-info'
)

/** Height of the mounted sheet (px), reported by the component; the motion's travel. */
let sheetTravel = 0

export function setSiteInfoTravel(px: number): void {
  sheetTravel = px
}

const motion = new SheetMotion({
  travel: () => sheetTravel || Math.round(window.innerHeight * 0.6),
  onChange: (sheet) => siteInfoStore.set({ sheet }),
  onClosed: () => finishClose()
})

export function siteInfoIsOpen(): boolean {
  return siteInfoStore.get().tabId !== null
}

/**
 * Open the site information for `tab`, from the site icon at `anchor`. The live page is
 * captured first so the dimmed snapshot can stand in behind the sheet (hosts hide page views
 * under chrome overlays).
 */
export async function openSiteInfo(tab: Tab, anchor: Rect | null = null): Promise<void> {
  if (siteInfoStore.get().tabId === tab.id) return
  await captureActiveTab(tab.id)
  run('focus.chrome', undefined)
  uiStore.set({ siteInfoOpen: true, drawerOpen: false })
  siteInfoStore.set({ tabId: tab.id, anchor, revision: 0 })
  motion.present()
}

/** Dismiss with the spring (a tap outside, the back gesture, Escape). */
export function closeSiteInfo(): void {
  if (!siteInfoIsOpen()) return
  if (motion.isOpen) motion.dismiss()
  else finishClose()
}

/** Drop the sheet at once: another surface took over or the layout changed. */
export function dismissSiteInfo(): void {
  if (!siteInfoIsOpen()) return
  motion.close()
  if (siteInfoIsOpen()) finishClose()
}

/** An action changed the site's state: read it again. */
export function refreshSiteInfo(): void {
  siteInfoStore.set((s) => ({ revision: s.revision + 1 }))
}

/** The drag surface of the phone sheet reports through these; the motion does the physics. */
export const siteInfoDrag = {
  begin: (): boolean => motion.beginDrag(),
  move: (deltaPx: number): void => motion.drag(deltaPx),
  release: (velocity: number): void => motion.release(velocity)
}

/**
 * Progress-driven dismissal for the system back gesture: the back-surface registry (`back.ts`)
 * drives the sheet through these as the swipe advances, for as long as the sheet is open.
 */
export const siteInfoBack = {
  isOpen: (): boolean => siteInfoIsOpen(),
  progress: (p: number): void => motion.backProgress(p),
  commit: (): void => motion.backCommit(),
  cancel: (): void => motion.backCancel()
}

function finishClose(): void {
  siteInfoStore.set({ tabId: null, anchor: null, sheet: SHEET_CLOSED })
  if (uiStore.get().siteInfoOpen) uiStore.set({ siteInfoOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
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

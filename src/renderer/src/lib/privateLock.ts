import type { MediaState, Tab, UIState } from '@shared/types'
import { run } from './api'
import { activeTabIsPrivate, isPrivateTab } from './privateTabs'
import { createStore } from './store'
import { browserStore } from './ui'

/**
 * "Lock private tabs when you leave Zenium" (INC-05 / SET-17; Chrome's "Lock Incognito tabs when
 * you leave Chrome"), the chrome's half. The switch is the core's, device-local
 * (`UIState.privateLockOnLeave`, `private.setLockOnLeave`); the lock itself is the phone host's,
 * in memory (`PrivateLock.kt`): it goes on as the window leaves the screen with the switch on
 * and private tabs open, and comes off when the device's screen lock is passed, when the last
 * private tab closes, or when the switch is turned off. The host's word arrives as
 * `private.lock` and is kept here; while it says locked, the chrome draws the lock cover over
 * private content alone – a private tab in front (`PrivateLockCover` in the content frame, the
 * page view hidden under it), the overview's Private pane – with the mask, "Your private tabs
 * are locked" and one Unlock button, in the private theme; the regular tabs, Settings and the
 * bar stay as they are. Unlock asks the host for the system's prompt (`BiometricPrompt`,
 * `BIOMETRIC_WEAK or DEVICE_CREDENTIAL`); a pass lifts the cover, a cancel or an error leaves it
 * (the prompt carried its own message). The switch changes the same way, as Chrome's does: the
 * device confirms the user first, either way, else turning the lock off would be the way past it.
 */
export interface PrivateLockState {
  /** The host holds the private tabs locked: the cover is over private content. */
  locked: boolean
  /**
   * The device has a screen lock (or a biometric) to pass the prompt with. Without one the
   * switch is disabled (v2 §9.30) and the host never locks; the host tells at boot and on return.
   */
  screenLock: boolean
  /** The cover's Unlock has the system's prompt up: the button is busy, a second press asks nothing. */
  prompting: boolean
  /** The switch has the prompt up, on its way to the change. */
  confirming: boolean
  /**
   * The lock came off with the cover up over the tab in front, and the cover is lifting – its
   * veil and blur dissolving into the page's picture on the spring (`PrivateLockCover`). The page
   * view stays hidden under it until the lift lands (`useLayoutReporter`: the picture is where
   * the page then comes back, as under a sheet's close), so the lift is seen and not the page
   * cutting in over it; the cover clears the flag as it lands, and `LIFT_MAX_MS` clears it if no
   * cover was up to (the lock released with the cover under the omnibox or the gesture stage).
   */
  lifting: boolean
}

export const privateLockStore = createStore<PrivateLockState>(
  { locked: false, screenLock: false, prompting: false, confirming: false, lifting: false },
  'private-lock'
)

/** The longest a lift keeps the page hidden: the spring lands well before; a cover that never ran it is not waited on past this. */
export const LIFT_MAX_MS = 600
let liftDeadline: ReturnType<typeof setTimeout> | null = null

/**
 * The lock came off. With the cover up over the tab in front the cover lifts first: the flag
 * keeps the page hidden until the cover lands (or `LIFT_MAX_MS`), see `PrivateLockState.lifting`.
 */
function release(state: UIState | null = browserStore.get().state): void {
  const current = privateLockStore.get()
  if (!current.locked) return
  const lifting = state !== null && activeTabIsPrivate(state)
  privateLockStore.set({ locked: false, lifting })
  if (liftDeadline !== null) clearTimeout(liftDeadline)
  liftDeadline = lifting
    ? setTimeout(() => {
        liftDeadline = null
        privateLockStore.set({ lifting: false })
      }, LIFT_MAX_MS)
    : null
}

/** The cover has landed (or never ran its lift): the page may come back. */
export function liftLanded(): void {
  if (liftDeadline !== null) clearTimeout(liftDeadline)
  liftDeadline = null
  if (privateLockStore.get().lifting) privateLockStore.set({ lifting: false })
}

/** The prompt's line under the cover's Unlock (the host shows it as the sheet's subtitle). */
export const PRIVATE_UNLOCK_REASON = 'Unlock your private tabs'
/** The prompt's line for the switch, on or off. */
export const PRIVATE_LOCK_SWITCH_REASON = 'Confirm it’s you to change how private tabs lock'

/** The host that holds the lock (Android's bridge); hosts without one set none. */
export interface PrivateLockHost {
  /**
   * The cover's Unlock: the system's prompt with `reason` under its title. Resolves with the
   * lock as it stands after – off when the user passed, still on when they cancelled or the
   * prompt failed them (its own message shown).
   */
  unlock(reason: string): Promise<{ locked: boolean }>
  /** The switch's confirmation: the same prompt; resolves whether the user passed. */
  verify(reason: string): Promise<boolean>
}

let host: PrivateLockHost | null = null

export function setPrivateLockHost(next: PrivateLockHost | null): void {
  host = next
}

/**
 * `private.lock` from the host: the lock as it stands, and whether a screen lock is set. A lock
 * that came off (the screen lock passed, the last private tab closed, the switch turned off, a
 * screen lock removed while the app was away) lifts the cover if one is up.
 */
export function applyPrivateLock(payload: { locked?: unknown; screenLock?: unknown }): void {
  const patch: Partial<PrivateLockState> = {}
  if (typeof payload.screenLock === 'boolean') patch.screenLock = payload.screenLock
  if (payload.locked === true) {
    patch.locked = true
    patch.lifting = false
  }
  if (Object.keys(patch).length) privateLockStore.set(patch)
  if (payload.locked === false) release()
}

/**
 * The tab in front is private and locked: the cover is over it in the content frame, and its
 * page view is hidden under the cover (`useLayoutReporter`). A Settings tab opened from a
 * private tab is a regular one (the internal pages' container rule) and is not covered.
 */
export function privateTabLocked(
  state: UIState,
  locked: boolean = privateLockStore.get().locked
): boolean {
  return locked && activeTabIsPrivate(state)
}

/** The tab in front is private and locked, for a rendering component. */
export function usePrivateTabLocked(state: UIState): boolean {
  const locked = privateLockStore.use((s) => s.locked)
  return privateTabLocked(state, locked)
}

/**
 * The lock cover is over the tab in front – locked, or lifting after the lock came off – so its
 * page view is hidden under the cover's picture (`useLayoutReporter` reports it hidden).
 */
export function privateCoverUp(
  state: UIState,
  lock: Pick<PrivateLockState, 'locked' | 'lifting'> = privateLockStore.get()
): boolean {
  return (lock.locked || lock.lifting) && activeTabIsPrivate(state)
}

/** `privateCoverUp` for a rendering component. */
export function usePrivateCoverUp(state: UIState): boolean {
  const locked = privateLockStore.use((s) => s.locked)
  const lifting = privateLockStore.use((s) => s.lifting)
  return privateCoverUp(state, { locked, lifting })
}

/** What a masked private tab's card reads in place of its title (§9.19; the pill's word). */
export const PRIVATE_TAB_PLACEHOLDER = 'Private tab'

/** The private tabs' identity is masked: the lock stands, or is lifting with the cover still over the page. */
function masking(lock: Pick<PrivateLockState, 'locked' | 'lifting'>): boolean {
  return lock.locked || lock.lifting
}

/**
 * This tab's card shows nothing of its page: it is private and the private tabs are locked (or
 * the lock is lifting, the cover still over the page). Wherever a card is drawn – the overview's
 * Private pane and its hero, the swipe track's neighbours, a card leaving or in the hand – the
 * picture is masked (`TabPreview`), and the title row reads the placeholder behind the mask in
 * place of the favicon and the title (§9.19: nothing of the page's identity leaks before the
 * unlock). For a rendering component.
 */
export function useTabMasked(tab: Pick<Tab, 'containerId'>): boolean {
  const locked = privateLockStore.use((s) => s.locked)
  const lifting = privateLockStore.use((s) => s.lifting)
  return masking({ locked, lifting }) && isPrivateTab(tab)
}

/**
 * This media says nothing of its page: it is a private tab's (`MediaState.private`, the core's
 * flag, #279 – the core blanks its title, artist, album and artwork already, and the player's
 * fallbacks would read the page's title and site) and the private tabs are locked (or the lock
 * is lifting). The in-app player and the site-information media row read the placeholder behind
 * the mask, as the tab's card does (§9.19). Only the identity is masked; the state (playing or
 * paused, the seek, the transport) is not, as the host's notification keeps its controls under
 * "A site is playing media". Nothing masks a regular tab's media, nor none.
 */
export function mediaMasked(
  media: Pick<MediaState, 'private'> | null | undefined,
  lock: Pick<PrivateLockState, 'locked' | 'lifting'> = privateLockStore.get()
): boolean {
  return masking(lock) && media?.private === true
}

/** `mediaMasked` for a rendering component. */
export function useMediaMasked(media: Pick<MediaState, 'private'> | null | undefined): boolean {
  const locked = privateLockStore.use((s) => s.locked)
  const lifting = privateLockStore.use((s) => s.lifting)
  return mediaMasked(media, { locked, lifting })
}

/**
 * The cover's Unlock: the host's prompt, once at a time. The lock as the host answers it is
 * what is kept: a pass lifts the cover (the host announces the same through `private.lock`), a
 * cancel or a failure leaves it. Without a host (a desktop, the tests) nothing is asked.
 */
export async function unlockPrivateTabs(): Promise<void> {
  const current = privateLockStore.get()
  if (!current.locked || current.prompting || !host) return
  privateLockStore.set({ prompting: true })
  try {
    const { locked } = await host.unlock(PRIVATE_UNLOCK_REASON)
    if (!locked) release()
  } catch {
    // The bridge failed the call: the lock stands as it was.
  } finally {
    privateLockStore.set({ prompting: false })
  }
}

/**
 * The Settings switch: the device confirms the user (the host's prompt), then the core keeps
 * the choice (`private.setLockOnLeave`, device-local). Resolves whether the change was made –
 * not without a screen lock (the row is disabled then), not while a confirmation is up, not
 * when the user cancelled. A host that cannot ask (the preview, a test) is taken at its word.
 */
export async function setPrivateLockOnLeave(enabled: boolean): Promise<boolean> {
  const current = privateLockStore.get()
  if (!current.screenLock || current.confirming) return false
  privateLockStore.set({ confirming: true })
  try {
    const passed = host ? await host.verify(PRIVATE_LOCK_SWITCH_REASON) : true
    if (!passed) return false
    run('private.setLockOnLeave', { enabled })
    return true
  } catch {
    return false
  } finally {
    privateLockStore.set({ confirming: false })
  }
}

/** The tests' reset. */
export function resetPrivateLock(): void {
  host = null
  if (liftDeadline !== null) clearTimeout(liftDeadline)
  liftDeadline = null
  privateLockStore.set({
    locked: false,
    screenLock: false,
    prompting: false,
    confirming: false,
    lifting: false
  })
}

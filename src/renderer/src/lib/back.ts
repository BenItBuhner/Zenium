import { useEffect, useRef } from 'react'
import { isChromePageUrl } from '@shared/internalPages'
import type { Tab, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import { run } from './api'
import { SPRING_SNAPPY, SpringAnimation, type SpringConfig } from './motion/spring'
import { closeAllPopovers, openPopoverCount, subscribePopovers } from './popoverStore'
import { activeSpace, activeTab, tabOrderOf } from './selectors'
import { createStore } from './store'
import {
  browserStore,
  closeDrawer,
  closeFindBar,
  closeMenu,
  closeOverlay,
  closeUrlbar,
  uiStore,
  type UiState
} from './ui'

/**
 * The system back gesture on mobile hosts.
 *
 * Android drives it predictively: the host reports the gesture as it happens – `start`, a stream
 * of `progress` values while the finger moves, then `commit` or `cancel` – and expects the chrome
 * to move with the finger, finish on commit and spring back on cancel. Chrome UI that back
 * dismisses registers itself as a {@link BackSurface}; the registry is a stack and the topmost
 * surface owns the gesture. With no surface registered the legacy chain in
 * {@link handleSystemBack} closes what it can, and when even that has nothing left the host lets
 * the system's own back-to-home animation run – which is why the chrome keeps the host informed
 * through {@link backStore} about whether it would handle a back at all.
 *
 * Adopting it in a sheet or panel is one hook call: {@link useBackDismissal} paints a 0…1 value
 * onto the element through a `render` callback and closes the surface when the value reaches 1;
 * anything needing more (the tab overview) registers a {@link BackSurface} of its own.
 */

export type BackEdge = 'left' | 'right'

export interface BackSurface {
  /** For logs and debugging (`menu`, `urlbar`, `overview`, …). */
  name: string
  /**
   * A gesture began on this surface. Not every commit is preceded by one: the back *button* and
   * hosts without predictive back go straight to `onCommit`.
   */
  onStart?(edge: BackEdge): void
  /** The finger moved: 0 at the edge it started from, 1 at the far end. Move the surface with it. */
  onProgress?(progress: number, edge: BackEdge): void
  /** Go the rest of the way from wherever the surface is now and close it. */
  onCommit(): void
  /** The finger let go before the threshold: spring back to fully shown. */
  onCancel?(): void
}

const stack: BackSurface[] = []

/** The gesture in flight: which surface took it at `start` (null → the legacy chain). */
let gesture: { surface: BackSurface | null; edge: BackEdge } | null = null

/** Put a surface on top of the stack; the returned function takes it off again. */
export function pushBackSurface(surface: BackSurface): () => void {
  stack.push(surface)
  refreshBackState()
  return () => {
    const index = stack.lastIndexOf(surface)
    if (index >= 0) stack.splice(index, 1)
    refreshBackState()
  }
}

export function topBackSurface(): BackSurface | null {
  return stack.length ? stack[stack.length - 1] : null
}

/**
 * Register `surface` for as long as the component is mounted (pass null while it has nothing to
 * dismiss). The object may be recreated on every render; the registry always calls the latest.
 */
export function useBackSurface(surface: BackSurface | null): void {
  const latest = useRef<BackSurface | null>(null)
  useEffect(() => {
    latest.current = surface
  })
  const enabled = surface !== null
  const name = surface?.name ?? ''
  useEffect(() => {
    if (!enabled) return
    return pushBackSurface({
      name,
      onStart: (edge) => latest.current?.onStart?.(edge),
      onProgress: (progress, edge) => latest.current?.onProgress?.(progress, edge),
      onCommit: () => latest.current?.onCommit(),
      onCancel: () => latest.current?.onCancel?.()
    })
  }, [enabled, name])
}

export type BackPhase = 'start' | 'progress' | 'commit' | 'cancel'

export interface BackEventPayload {
  edge?: BackEdge
  progress?: number
}

/**
 * Host → chrome. Returns whether the chrome had something for the gesture; on `commit` a false
 * answer tells the host nothing was left to pop.
 */
export function dispatchBackEvent(phase: BackPhase, payload?: BackEventPayload | null): boolean {
  switch (phase) {
    case 'start': {
      const edge = payload?.edge ?? 'left'
      const surface = topBackSurface()
      gesture = { surface, edge }
      surface?.onStart?.(edge)
      return surface !== null
    }
    case 'progress': {
      if (!gesture) return false
      const progress = clamp01(payload?.progress ?? 0)
      gesture.surface?.onProgress?.(progress, gesture.edge)
      return gesture.surface !== null
    }
    case 'cancel': {
      const current = gesture
      gesture = null
      current?.surface?.onCancel?.()
      return current?.surface != null
    }
    case 'commit': {
      const current = gesture
      gesture = null
      if (current) {
        // The surface the gesture moved is the one that closes – unless it went away meanwhile,
        // in which case the gesture has nothing left to finish.
        if (current.surface) {
          if (stack.includes(current.surface)) current.surface.onCommit()
          return true
        }
        return handleSystemBack()
      }
      const surface = topBackSurface()
      if (surface) {
        surface.onCommit()
        return true
      }
      return handleSystemBack()
    }
  }
}

/**
 * Back without a surface (and for hosts that deliver back as one event): closes the topmost
 * piece of chrome UI ({@link closeChromeForBack}), then navigates the active tab back. Returns
 * false when nothing was left to do (the host may background the app).
 */
export function handleSystemBack(): boolean {
  if (closeChromeForBack()) return true
  const state = browserStore.get().state
  const tab = state ? activeTab(state) : null
  if (!tab || !state) return false
  if (tab.canGoBack) {
    run('tab.back', { tabId: tab.id })
    return true
  }
  return performRootBack(tab, state)
}

/**
 * The chrome's part of the legacy chain: closes the topmost piece of chrome UI that stands
 * without a {@link BackSurface} of its own – a popover, the menu, the urlbar, an overlay, the
 * drawer, a glance, the find bar, in the shell's order – and says whether it closed one. What a
 * surface that stands over the page but under that chrome (the page-edge band) yields to on
 * its commit, so the shell's order holds with it up. Never navigates the page.
 */
export function closeChromeForBack(): boolean {
  const ui = uiStore.get()
  const state = browserStore.get().state
  // A §9.20 popover (the star bubble, site information, an extension's popup) is the touch
  // layout's topmost chrome while it is up: the system back is its light dismiss, as a press
  // outside it is – never a navigation of the page it hangs over (a tablet's popovers register
  // no back surface of their own; the phone's sheets do).
  if (openPopoverCount() > 0) {
    closeAllPopovers()
    return true
  }
  if (ui.menu) {
    closeMenu()
    return true
  }
  if (ui.urlbar.open) {
    closeUrlbar()
    return true
  }
  if (ui.overlay !== 'none' && ui.overlay !== 'onboarding') {
    closeOverlay()
    return true
  }
  if (ui.drawerOpen) {
    closeDrawer()
    return true
  }
  if (state?.glance) {
    run('glance.close', undefined)
    return true
  }
  if (ui.findOpen && ui.findTabId) {
    closeFindBar()
    return true
  }
  return false
}

/**
 * Perform Chrome's back at the first page of `tab`'s history ({@link rootBackAction}): false
 * when the action is to leave the app, which the caller does its own way – the Back key lets the
 * system's back-to-home run, the history drag ({@link ../lib/historyNav}) minimizes the window.
 */
export function performRootBack(tab: Tab, state: UIState): boolean {
  switch (rootBackAction(tab, state)) {
    case 'opener':
      if (tab.openerTabId) run('tab.activate', { tabId: tab.openerTabId })
      run('tab.close', { tabId: tab.id })
      return true
    case 'caller': {
      // Background the app first, which returns to the app that sent the URL; the tab goes once
      // the app is out of sight (Chrome's 500 ms), so the tab taking its place is never glimpsed.
      // The sent tab was an interruption: coming back to Zenium resumes the tab the user was on.
      const resume = lastActiveOther(tab, state)
      const sentId = tab.id
      run('window.minimize', undefined)
      setTimeout(() => {
        if (resume) run('tab.activate', { tabId: resume.id })
        run('tab.close', { tabId: sentId })
      }, CLOSE_AFTER_LEAVE_MS)
      return true
    }
    case 'newTabPage':
      // A fresh tab takes the page's place (same group, same container) and the page moves to
      // the recently closed list – the tab is back where it started, with nothing behind it.
      run('tab.create', {
        url: BLANK_URL,
        active: true,
        afterTabId: tab.id,
        containerId: tab.containerId
      })
      run('tab.close', { tabId: tab.id })
      return true
    case 'closeTab':
      run('tab.close', { tabId: tab.id })
      return true
    case 'previousTab': {
      const previous = lastActiveOther(tab, state)
      if (previous) run('tab.activate', { tabId: previous.id })
      run('tab.close', { tabId: tab.id })
      return true
    }
    case 'background':
      return false
  }
}

/** What a back at the first page of `tab`'s history does. */
export type RootBackAction =
  /** Close the tab and return to the tab whose link opened it. */
  | 'opener'
  /**
   * Leave the app and close the tab: it was opened by another app, which gets the user back;
   * Zenium resumes the tab the user was on when it is next in front.
   */
  | 'caller'
  /** The page leaves and the tab starts over as a new tab (Chrome's new-tab page history entry). */
  | 'newTabPage'
  /** A blank tab has nothing to go back to: close it and show the previous tab. */
  | 'closeTab'
  /**
   * Close the tab and return to the tab the user was on before it (the most recently active
   * other tab of the space): a page tab whose opener is gone.
   */
  | 'previousTab'
  /** The last tab of the space (or a pinned one) stays; the app goes to the background. */
  | 'background'

/**
 * Chrome's back at a tab's root, in Zenium's model: a child tab closes back to its opener, a tab
 * another app opened closes back to that app, any other page gives way to a new-tab page, and a
 * new-tab page closes – unless it is the last tab the space has, or a pinned one, which stay.
 *
 * A chrome page tab (Settings) at its landing is the one more case: it was opened from a tab and
 * closes back to it through the opener rule, or came from another app's deep link and leaves
 * through the caller rule; with neither left (the opener closed meanwhile, a restored session) it
 * closes back to the tab the user was on before it (`previousTab`), never to a new-tab page –
 * Settings is a place one visits, not a page one browses – and stays when it is all the space
 * has, or is pinned.
 */
export function rootBackAction(tab: Tab, state: UIState): RootBackAction {
  const others = tabOrderOf(state, activeSpace(state)).filter((t) => t.id !== tab.id)
  if (tab.openerTabId && state.tabs[tab.openerTabId]) return 'opener'
  if (tab.fromIntent) return 'caller'
  if (tab.pinned || tab.essential) return 'background'
  if (isChromePageUrl(tab.url)) return others.length > 0 ? 'previousTab' : 'background'
  if (tab.url && tab.url !== BLANK_URL) return 'newTabPage'
  return others.length > 0 ? 'closeTab' : 'background'
}

/**
 * What the history drag's bubble says a back would close (Chrome's `NavigationBubble.CloseTarget`,
 * read by `NavigationHandler.getCloseIndicator` off the `BackActionDelegate`'s type): the tab
 * when the tab goes ('Close tab', Chrome's `CLOSE_TAB`); the app when it goes to the background,
 * with the tab or without ('Close Zenium', `EXIT_APP_AND_CLOSE_TAB` / `EXIT_APP_ONLY`); nothing
 * when the back turns a page – the page's own history, or the tab starting over as a new-tab
 * page, which is Chrome's back onto the new-tab page's own history entry.
 */
export type CloseTarget = 'none' | 'tab' | 'app'

export function closeTargetOf(action: RootBackAction): CloseTarget {
  switch (action) {
    case 'opener':
    case 'closeTab':
    case 'previousTab':
      return 'tab'
    case 'caller':
    case 'background':
      return 'app'
    case 'newTabPage':
      return 'none'
  }
}

/** The caption a back drag on `tab` shows past the threshold right now: none while the page itself has a back. */
export function dragCloseTarget(tab: Tab, state: UIState): CloseTarget {
  return tab.canGoBack ? 'none' : closeTargetOf(rootBackAction(tab, state))
}

/**
 * The history drag's back on `tab`, as Chrome's `NavigationHandler.navigate(back)` goes through
 * the `BackActionDelegate.onBackGesture`: the page's own back; else Chrome's back at the root
 * ({@link performRootBack}); else – the last tab of the space staying – the app to the background
 * (`mSendToBackground(null)`).
 */
export function dragBack(tab: Tab, state: UIState): void {
  if (tab.canGoBack) {
    run('tab.back', { tabId: tab.id })
    return
  }
  if (!performRootBack(tab, state)) run('window.minimize', undefined)
}

/**
 * How long after backgrounding the app a tab closed on the way out is actually closed
 * (`ChromeTabbedActivity.CLOSE_TAB_ON_MINIMIZE_DELAY_MS`): late enough that the tab taking its
 * place is not seen before the app is out of sight.
 */
export const CLOSE_AFTER_LEAVE_MS = 500

/**
 * The tab the user was on before `tab` took the screen: the most recently active other tab of the
 * space (`activateTab` stamps the tab it leaves as well as the one it enters), or null when `tab`
 * is alone. What a tab another app sent resumes when it closes.
 */
export function lastActiveOther(tab: Tab, state: UIState): Tab | null {
  let latest: Tab | null = null
  for (const other of tabOrderOf(state, activeSpace(state))) {
    if (other.id === tab.id) continue
    if (!latest || other.lastActiveAt > latest.lastActiveAt) latest = other
  }
  return latest
}

// ---------------------------------------------------------------------------
// What the host needs to know ahead of the gesture
// ---------------------------------------------------------------------------

export interface BackHostState {
  /** The chrome has a surface (or legacy UI) a back would dismiss. */
  chrome: boolean
  /** The tab whose page a back would navigate when the chrome has nothing. */
  tabId: string | null
  /**
   * At the first page of that tab's history the chrome still has a back to perform (close the
   * tab to its opener, start over as a new tab, …) rather than leaving the app.
   */
  root: boolean
}

/**
 * Mirrored to the host (`back.update` on Android) whenever it changes: the host registers its
 * back callback only while the chrome or the page can use the gesture, so that otherwise the
 * system's back-to-home animation runs untouched.
 */
export const backStore = createStore<BackHostState>(
  { chrome: false, tabId: null, root: false },
  'back'
)

function chromeHandlesBack(ui: UiState, state: UIState | null): boolean {
  // A chrome page tab's history is its sections, which the host cannot see (the tab has no
  // WebView to ask): while one sits over the landing the chrome has the back.
  const tab = state ? activeTab(state) : null
  const pageHistory = tab !== null && tab.canGoBack && isChromePageUrl(tab.url)
  return (
    pageHistory ||
    stack.length > 0 ||
    openPopoverCount() > 0 ||
    ui.menu !== null ||
    ui.urlbar.open ||
    (ui.overlay !== 'none' && ui.overlay !== 'onboarding') ||
    ui.drawerOpen ||
    ui.siteInfoOpen ||
    ui.barEditorOpen ||
    Boolean(state?.glance) ||
    (ui.findOpen && ui.findTabId !== null)
  )
}

export function refreshBackState(): void {
  const ui = uiStore.get()
  const state = browserStore.get().state
  const chrome = chromeHandlesBack(ui, state)
  const tab = state ? activeTab(state) : null
  const tabId = tab?.id ?? null
  const root = tab !== null && state !== null && rootBackAction(tab, state) !== 'background'
  const prev = backStore.get()
  if (prev.chrome !== chrome || prev.tabId !== tabId || prev.root !== root)
    backStore.set({ chrome, tabId, root })
}

const flags = globalThis as unknown as { __zenBackWired?: boolean }
if (!flags.__zenBackWired) {
  flags.__zenBackWired = true
  uiStore.subscribe(refreshBackState)
  browserStore.subscribe(refreshBackState)
  // A popover opening or closing changes the answer without touching either store.
  subscribePopovers(refreshBackState)
}

// ---------------------------------------------------------------------------
// Dismissal of a sheet or panel as one animated value
// ---------------------------------------------------------------------------

export interface BackDismissalOptions {
  /**
   * Paint `value` (0 = fully shown … 1 = gone) onto the surface. Runs every frame: write DOM
   * styles through refs rather than setting React state.
   */
  render(value: number): void
  /** The surface has been animated all the way out: close it (unmounting is fine). */
  dismissed(): void
  /**
   * The gesture committed (or a back was pressed) with the surface at `value` (0 when nothing
   * was pulled: a back key): return true to take the dismissal over at once – another motion of
   * the surface's own runs it out, and neither the spring to 1 nor `dismissed` follows. A
   * surface whose departure is a motion of its own (the new tab page's field running back along
   * its line, lib/fakeboxMorph.ts) answers here rather than at the end of a spring it never
   * showed.
   */
  committed?(value: number): boolean
  /** How far (px) the surface travels between 0 and 1 – sets the spring's pace. */
  travel?: number
  spring?: SpringConfig
}

/**
 * Drives one surface's dismissal as a 0…1 value. The gesture sets it directly; `commit` and
 * `cancel` spring it to 1 or 0 (carrying the finger's velocity), and a gesture that begins while
 * a spring is still running simply takes over from wherever the motion is – every animation is
 * interruptible. `surface()` adapts it to the registry.
 */
export class BackDismissal {
  private value = 0
  private committing = false
  private velocity = 0
  private lastAt = 0
  private readonly travel: number
  private readonly spring: SpringAnimation

  constructor(private readonly options: BackDismissalOptions) {
    this.travel = options.travel ?? 400
    this.spring = new SpringAnimation(
      options.spring ?? SPRING_SNAPPY,
      (x) => this.paint(x / this.travel),
      (x) => {
        this.paint(x / this.travel)
        if (this.committing && this.value >= 1) {
          this.committing = false
          this.options.dismissed()
        }
      }
    )
  }

  /** Where the surface is: 0 shown … 1 gone. */
  get progress(): number {
    return this.value
  }

  /** A gesture began: hold whatever motion was running and let the finger take it from here. */
  start(): void {
    this.spring.stop()
    this.committing = false
    this.lastAt = 0
    this.velocity = 0
  }

  /** The finger moved to `progress` (0…1). */
  setProgress(progress: number): void {
    this.spring.stop()
    this.committing = false
    const next = clamp01(progress)
    const now = performance.now()
    if (this.lastAt) {
      const dt = (now - this.lastAt) / 1000
      if (dt > 0) this.velocity = ((next - this.value) / dt) * this.travel
    }
    this.lastAt = now
    this.paint(next)
  }

  /** Spring back to fully shown. */
  cancel(): void {
    this.committing = false
    this.spring.start(this.value * this.travel, Math.min(0, this.recentVelocity()), 0)
  }

  /** Spring the rest of the way out, then report `dismissed` – unless `committed` took the dismissal over. */
  commit(): void {
    if (this.options.committed?.(this.value)) {
      this.spring.stop()
      this.committing = false
      return
    }
    this.committing = true
    this.spring.start(
      this.value * this.travel,
      Math.max(this.recentVelocity(), MIN_COMMIT_VELOCITY),
      this.travel
    )
  }

  /** Stop any motion (the component unmounted). */
  dispose(): void {
    this.spring.stop()
    this.committing = false
  }

  /** The surface a component registers for this dismissal. */
  surface(name: string): BackSurface {
    return {
      name,
      onStart: () => this.start(),
      onProgress: (progress) => this.setProgress(progress),
      onCommit: () => this.commit(),
      onCancel: () => this.cancel()
    }
  }

  private recentVelocity(): number {
    return this.lastAt && performance.now() - this.lastAt < VELOCITY_MEMORY_MS ? this.velocity : 0
  }

  private paint(value: number): void {
    this.value = Math.max(0, value)
    this.options.render(this.value)
  }
}

/**
 * Register the mounted component as a back surface whose dismissal is one animated value: e.g.
 *
 *     const sheet = useRef<HTMLDivElement>(null)
 *     useBackDismissal('menu', {
 *       render: (v) => sheet.current && (sheet.current.style.transform = `translateY(${v * 100}%)`),
 *       dismissed: () => closeMenu()
 *     })
 *
 * `render` and `dismissed` are always the latest ones passed; refs are only read inside them.
 */
export function useBackDismissal(name: string, options: BackDismissalOptions): void {
  const latest = useRef(options)
  const dismissal = useRef<BackDismissal | null>(null)
  useEffect(() => {
    latest.current = options
  })
  useEffect(() => {
    const created = new BackDismissal({
      travel: latest.current.travel,
      spring: latest.current.spring,
      render: (value) => latest.current.render(value),
      dismissed: () => latest.current.dismissed(),
      committed: (value) => latest.current.committed?.(value) ?? false
    })
    dismissal.current = created
    return () => {
      created.dispose()
      dismissal.current = null
    }
  }, [])
  useBackSurface({
    name,
    onStart: () => dismissal.current?.start(),
    onProgress: (progress) => dismissal.current?.setProgress(progress),
    onCommit: () => dismissal.current?.commit(),
    onCancel: () => dismissal.current?.cancel()
  })
}

/** px/s: even a slow release leaves at a pace that reads as a decision. */
const MIN_COMMIT_VELOCITY = 900
const VELOCITY_MEMORY_MS = 120

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

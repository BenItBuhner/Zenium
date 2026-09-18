import { useEffect, useRef } from 'react'
import type { Tab, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import { run } from './api'
import { SPRING_SNAPPY, SpringAnimation, type SpringConfig } from './motion/spring'
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
 * piece of chrome UI, then navigates the active tab back. Returns false when nothing was left to
 * do (the host may background the app).
 */
export function handleSystemBack(): boolean {
  const ui = uiStore.get()
  const state = browserStore.get().state
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
  const tab = state ? activeTab(state) : null
  if (!tab || !state) return false
  if (tab.canGoBack) {
    run('tab.back', { tabId: tab.id })
    return true
  }
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
  /** The last tab of the space (or a pinned one) stays; the app goes to the background. */
  | 'background'

/**
 * Chrome's back at a tab's root, in Zenium's model: a child tab closes back to its opener, a tab
 * another app opened closes back to that app, any other page gives way to a new-tab page, and a
 * new-tab page closes – unless it is the last tab the space has, or a pinned one, which stay.
 */
export function rootBackAction(tab: Tab, state: UIState): RootBackAction {
  const others = tabOrderOf(state, activeSpace(state)).filter((t) => t.id !== tab.id)
  if (tab.openerTabId && state.tabs[tab.openerTabId]) return 'opener'
  if (tab.fromIntent) return 'caller'
  if (tab.pinned || tab.essential) return 'background'
  if (tab.url && tab.url !== BLANK_URL) return 'newTabPage'
  return others.length > 0 ? 'closeTab' : 'background'
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
  return (
    stack.length > 0 ||
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

  /** Spring the rest of the way out, then report `dismissed`. */
  commit(): void {
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
      dismissed: () => latest.current.dismissed()
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import {
  PRIVATE_THEME,
  blendResolvedThemes,
  resolveTheme,
  resolveWallpaper,
  rgbToHex,
  themeCssVariables,
  type RGB,
  type ResolvedTheme
} from '@shared/theme'
import { contentRadius } from '@renderer/lib/contentRadius'
import { isTouchLayout, type FormFactor } from '@renderer/lib/formFactor'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { usePrivateSurface } from '@renderer/lib/privateSurface'
import { activeSpace, isDarkScheme } from '@renderer/lib/selectors'

/**
 * The theme blend's length (design language v2 §11.6). When the phone's window family changes
 * colour as a whole – a private tab coming into view or going (MOT-14), a Space switch, the
 * colour scheme changing – the root's tokens run from the theme as painted to the new one in one
 * blend over 240 ms on one value, linear, so that the midpoint of the colours is the midpoint of
 * the time: there the colour scheme flips (`blendResolvedThemes`) and the status bar follows
 * (`zen-theme-painted`). Every window surface reads the tokens, so nothing tweens per element
 * (the phone window's own background transition is off, `main.css`). Under reduced motion the
 * blend is a cut, and so is one the document cannot show: a blend has no frames while the
 * document is hidden (the app in the background), so it settles at its end as the document
 * hides, and one still pending on return settles as the document shows again – the colours it
 * froze on are never the first thing seen back. The desktop paints its theme at once, as it
 * always has.
 */
export const THEME_BLEND_MS = 240

/**
 * The private accent, the desktop private window's (`.zen-window[data-window-kind='private']`
 * in main.css, `PRIVATE_ACCENT` in the new tab page script; `useTheme.test` keeps them in step).
 * The phone has no private window to take that override, so its private theme carries the
 * accent itself: the theme's own `#5b3fa0` stands at 2.2:1 on the private backdrop, this one at
 * 6.5:1 (5.9–7.0 against the gradient's stops), above the 3:1 floor for the segment's line
 * (v2 §9.34), the primary button and the on switch's mix, which all draw in it.
 */
export const PRIVATE_ACCENT_RGB: RGB = [169, 139, 255]

/**
 * The phone's private theme: Zen's deep purple, dark whatever the colour scheme (Chrome's
 * Incognito and Edge's InPrivate are dark in a light app too); the window surfaces blend to it.
 */
export const PRIVATE_RESOLVED: ResolvedTheme = {
  ...resolveTheme(PRIVATE_THEME, true),
  accent: PRIVATE_ACCENT_RGB
}

/**
 * Fired on `window` once the painted theme has flipped its polarity (the `isDark` side of the
 * blend, at its midpoint) or come to rest: the Android host sets the status bar's icons and the
 * window background from it (`boot.ts`), so the bar follows the chrome's blend and not a guess.
 */
export const THEME_PAINTED_EVENT = 'zen-theme-painted'

export interface ThemePaintedDetail {
  dark: boolean
  /** The solid colour of the painted theme, `#rrggbb`. */
  background: string
}

/** Whether two resolved themes paint the same root: the same variables, the same polarity. */
export function sameResolvedTheme(a: ResolvedTheme, b: ResolvedTheme): boolean {
  if (a === b) return true
  if (a.isDark !== b.isDark) return false
  const va = themeCssVariables(a)
  const vb = themeCssVariables(b)
  return Object.keys(va).every((key) => va[key] === vb[key])
}

/** A blend in flight: its pending frame and the theme it is heading for. */
interface BlendRun {
  frame: number
  to: ResolvedTheme
}

/**
 * The frame the chrome keeps around the content (`--zen-padding`, CSS px): none borderless,
 * slimmer on a phone. The one rule for it, so code that needs the number (the bar that hides on
 * scroll takes the band minus this gutter as its travel, `lib/barHide.ts`) reads what the theme
 * writes rather than the stylesheet's default it may find on the root before the theme has run.
 */
export function chromeGutter(formFactor: FormFactor, borderless: boolean): number {
  return borderless ? 0 : formFactor === 'phone' ? 6 : 8
}

/**
 * Applies the active space's gradient theme to the document root. On the phone every change of
 * the window family's colour – the private theme while a private tab is in view (MOT-14), a
 * Space switch, the scheme – is the one 240 ms blend of §11.6, painted straight to the root's
 * variables per frame; React only hears about the polarity flipping at the midpoint, through
 * the returned `isDark`.
 */
export function useTheme(state: UIState, formFactor: FormFactor = 'desktop'): ResolvedTheme {
  // The host's reading of the OS scheme wins (it flips the moment the OS does); the media query
  // serves hosts that have none.
  const [mediaDark, setMediaDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (e: MediaQueryListEvent): void => setMediaDark(e.matches)
    mq.addEventListener('change', listener)
    return () => mq.removeEventListener('change', listener)
  }, [])

  const space = activeSpace(state)
  const systemDark = state.systemDark ?? mediaDark
  const dark = state.settings.colorScheme === 'system' ? systemDark : isDarkScheme(state)
  const resolved = useMemo(() => resolveTheme(space.theme, dark), [space.theme, dark])
  // The space's gradient at full strength, for surfaces that show it as a wallpaper (the new tab page).
  const wallpaper = useMemo(() => resolveWallpaper(space.theme, dark), [space.theme, dark])

  // The touch layouts only – the phone's and the tablet's, whose private tabs share the window
  // with the others: on the desktop private browsing is a window, and the core gives it its theme.
  const privateActive = usePrivateSurface(state) && isTouchLayout(formFactor)
  const target = privateActive ? PRIVATE_RESOLVED : resolved
  // The blend is the touch chassis's (§11 is its motion); the desktop cuts to its theme.
  const blends = isTouchLayout(formFactor)

  // The theme as painted on the root last – where the next blend starts from; null before the
  // first paint.
  const painted = useRef<ResolvedTheme | null>(null)
  const [paintedDark, setPaintedDark] = useState(target.isDark)
  const paintedDarkRef = useRef(paintedDark)

  const paint = useCallback((theme: ResolvedTheme, settled: boolean): void => {
    painted.current = theme
    const root = document.documentElement
    for (const [key, value] of Object.entries(themeCssVariables(theme)))
      root.style.setProperty(key, value)
    root.dataset.theme = theme.isDark ? 'dark' : 'light'
    root.style.colorScheme = theme.isDark ? 'dark' : 'light'
    const flipped = theme.isDark !== paintedDarkRef.current
    if (flipped) {
      paintedDarkRef.current = theme.isDark
      setPaintedDark(theme.isDark)
    }
    if (flipped || settled) {
      const detail: ThemePaintedDetail = {
        dark: theme.isDark,
        background: rgbToHex(theme.averageColor)
      }
      window.dispatchEvent(new CustomEvent(THEME_PAINTED_EVENT, { detail }))
    }
  }, [])

  const run = useRef<BlendRun | null>(null)
  const cancel = useCallback((): void => {
    if (run.current) cancelAnimationFrame(run.current.frame)
    run.current = null
  }, [])

  /**
   * One blend from the theme as painted to `to`: the value is the time elapsed over
   * `THEME_BLEND_MS`, so a blend caught mid-run turns around from the colours on the root and
   * takes the full 240 ms to its new end.
   */
  const blendTo = useCallback(
    (to: ResolvedTheme): void => {
      cancel()
      const from = painted.current ?? to
      const startedAt = performance.now()
      const tick = (now: number): void => {
        const k = (now - startedAt) / THEME_BLEND_MS
        if (k >= 1) {
          run.current = null
          paint(to, true)
          return
        }
        paint(blendResolvedThemes(from, to, Math.max(0, k)), false)
        run.current = { frame: requestAnimationFrame(tick), to }
      }
      run.current = { frame: requestAnimationFrame(tick), to }
    },
    [cancel, paint]
  )

  // The theme to paint changed. The first paint is at once (a chrome mounting on a private tab
  // is private from its first frame), and so is the desktop's; under reduced motion the phone
  // cuts as well (§11.6), and so does a hidden document (nothing would show the blend, and its
  // rAF would not run: the app in the background as the private session ends from services'
  // notification). Otherwise the phone blends – unless the root already shows the theme, or a
  // blend is already heading there.
  useEffect(() => {
    const before = painted.current
    if (before === null || !blends || reducedMotion() || document.visibilityState === 'hidden') {
      cancel()
      paint(target, true)
      return
    }
    if (run.current ? run.current.to === target : sameResolvedTheme(before, target)) return
    blendTo(target)
  }, [target, blends, blendTo, cancel, paint])

  // A blend has no frames while the document is hidden (rAF pauses with it), and the colours it
  // froze on would be the first thing seen on return – up to the blend's whole length of the
  // private theme after a private tab was left for a regular one just before Home. So a blend
  // in flight settles at its end as the document hides, and one still pending as it shows again
  // (started while hidden, or hidden between its frames) settles then.
  useEffect(() => {
    const settle = (): void => {
      const pending = run.current
      if (!pending) return
      cancel()
      paint(pending.to, true)
    }
    document.addEventListener('visibilitychange', settle)
    return () => document.removeEventListener('visibilitychange', settle)
  }, [cancel, paint])

  // A blend in flight stops with the chrome.
  useEffect(() => cancel, [cancel])

  // The frame's radius: the desktop's 10, the phone's 14, none borderless – and none while a
  // developer toolbox is docked in the frame (§9.29, `lib/contentRadius.ts`); the layout
  // reporter reads the same rule for the page views, so the two never disagree.
  const radius = contentRadius(state, formFactor)
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--zen-wallpaper', wallpaper)
    root.dataset.material = state.window.material
    root.style.setProperty('--zen-sidebar-width', `${state.settings.sidebarWidth}px`)
    const borderless = state.settings.borderless || state.window.fullscreen
    // Phones keep a slimmer frame around the content card; the bottom bar sits right under it.
    root.style.setProperty('--zen-padding', `${chromeGutter(formFactor, borderless)}px`)
    root.style.setProperty('--zen-content-radius', `${radius}px`)
  }, [
    wallpaper,
    formFactor,
    radius,
    state.settings.sidebarWidth,
    state.settings.borderless,
    state.window.fullscreen,
    state.window.material
  ])

  // What the chrome shows: the theme it is heading for, with the polarity as painted so far.
  return useMemo(
    () => (target.isDark === paintedDark ? target : { ...target, isDark: paintedDark }),
    [target, paintedDark]
  )
}

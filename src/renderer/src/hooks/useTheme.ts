import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import type { SpringConfig } from '@shared/spring'
import {
  PRIVATE_THEME,
  blendResolvedThemes,
  resolveTheme,
  resolveWallpaper,
  rgbToHex,
  themeCssVariables,
  type ResolvedTheme
} from '@shared/theme'
import type { FormFactor } from '@renderer/lib/formFactor'
import { SpringAnimation } from '@renderer/lib/motion/spring'
import { usePrivateSurface } from '@renderer/lib/privateSurface'
import { activeSpace, isDarkScheme } from '@renderer/lib/selectors'

/**
 * The private blend's spring (MOT-14): SNAPPY's damping (ζ ≈ 0.98, no visible overshoot) on a
 * 0…1 track, stiff enough that the colours have all but arrived (99 %) about 240 ms after a
 * private tab comes into view or goes. The rest thresholds are under a colour step (1/255), so
 * the frames after that change nothing the eye can see.
 */
export const SPRING_THEME_BLEND: SpringConfig = {
  stiffness: 900,
  damping: 59,
  mass: 1,
  restDelta: 0.002,
  restSpeed: 0.06
}

/**
 * The phone's private theme: Zen's deep purple, dark whatever the colour scheme (Chrome's
 * Incognito and Edge's InPrivate are dark in a light app too); the window surfaces blend to it.
 */
export const PRIVATE_RESOLVED: ResolvedTheme = resolveTheme(PRIVATE_THEME, true)

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

/**
 * Applies the active space's gradient theme to the document root. On the phone the window
 * surfaces blend to the private theme while a private tab is in view (MOT-14): the colours lerp
 * through `blendResolvedThemes` on a spring, painted straight to the root's variables per frame;
 * React only hears about the polarity flipping at the midpoint, through the returned `isDark`.
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

  // Phones only: on the desktop private browsing is a window, and the core gives it its theme.
  const privateActive = usePrivateSurface(state) && formFactor === 'phone'
  const target = privateActive ? PRIVATE_RESOLVED : resolved

  // Where the blend stands: 0 = the space theme, 1 = the private theme.
  const blend = useRef(privateActive ? 1 : 0)
  // The space theme the blend starts from, as the spring's frames read it.
  const latest = useRef(resolved)
  const [paintedDark, setPaintedDark] = useState(target.isDark)
  const paintedDarkRef = useRef(paintedDark)

  const paint = useCallback((t: number, settled: boolean): void => {
    const blended = blendResolvedThemes(latest.current, PRIVATE_RESOLVED, t)
    const root = document.documentElement
    for (const [key, value] of Object.entries(themeCssVariables(blended)))
      root.style.setProperty(key, value)
    root.dataset.theme = blended.isDark ? 'dark' : 'light'
    root.style.colorScheme = blended.isDark ? 'dark' : 'light'
    const flipped = blended.isDark !== paintedDarkRef.current
    if (flipped) {
      paintedDarkRef.current = blended.isDark
      setPaintedDark(blended.isDark)
    }
    if (flipped || settled) {
      const detail: ThemePaintedDetail = {
        dark: blended.isDark,
        background: rgbToHex(blended.averageColor)
      }
      window.dispatchEvent(new CustomEvent(THEME_PAINTED_EVENT, { detail }))
    }
  }, [])

  // The spring lives for the hook's life; its frames write the blend and paint it.
  const spring = useRef<SpringAnimation | null>(null)
  useEffect(() => {
    const s = new SpringAnimation(
      SPRING_THEME_BLEND,
      (x) => {
        blend.current = x
        paint(x, false)
      },
      (x) => {
        blend.current = x
        paint(x, true)
      }
    )
    spring.current = s
    return () => {
      s.stop()
      spring.current = null
    }
  }, [paint])

  // A private tab came into view (or went): the blend runs to its new end from wherever it
  // stands, catching a run still in flight. A spring's first run only places it at rest (a
  // fresh spring after StrictMode's remount included, so no blend runs on mount).
  const placed = useRef<SpringAnimation | null>(null)
  useEffect(() => {
    const s = spring.current
    if (!s) return
    const to = privateActive ? 1 : 0
    if (placed.current !== s) {
      placed.current = s
      s.start(to, 0, to)
      s.stop()
      return
    }
    s.retarget(to)
  }, [privateActive, paint])

  useEffect(() => {
    const root = document.documentElement
    latest.current = resolved
    // A blend in flight paints the new space theme itself on its next frame.
    if (!spring.current?.running) paint(blend.current, true)
    root.style.setProperty('--zen-wallpaper', wallpaper)
    root.dataset.material = state.window.material
    root.style.setProperty('--zen-sidebar-width', `${state.settings.sidebarWidth}px`)
    const borderless = state.settings.borderless || state.window.fullscreen
    // Phones keep a slimmer frame around the content card; the bottom bar sits right under it.
    const phone = formFactor === 'phone'
    root.style.setProperty('--zen-padding', borderless ? '0px' : phone ? '6px' : '8px')
    root.style.setProperty('--zen-content-radius', borderless ? '0px' : phone ? '14px' : '10px')
  }, [
    resolved,
    wallpaper,
    formFactor,
    paint,
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

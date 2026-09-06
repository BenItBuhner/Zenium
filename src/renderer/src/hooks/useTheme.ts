import { useEffect, useMemo, useState } from 'react'
import type { UIState } from '@shared/types'
import { resolveTheme, themeCssVariables, type ResolvedTheme } from '@shared/theme'
import type { FormFactor } from '@renderer/lib/formFactor'
import { activeSpace, isDarkScheme } from '@renderer/lib/selectors'

/** Applies the active space's gradient theme to the document root. */
export function useTheme(state: UIState, formFactor: FormFactor = 'desktop'): ResolvedTheme {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', listener)
    return () => mq.removeEventListener('change', listener)
  }, [])

  const space = activeSpace(state)
  const dark = state.settings.colorScheme === 'system' ? systemDark : isDarkScheme(state)
  const resolved = useMemo(() => resolveTheme(space.theme, dark), [space.theme, dark])

  useEffect(() => {
    const root = document.documentElement
    for (const [key, value] of Object.entries(themeCssVariables(resolved)))
      root.style.setProperty(key, value)
    root.dataset.theme = resolved.isDark ? 'dark' : 'light'
    root.style.colorScheme = resolved.isDark ? 'dark' : 'light'
    root.style.setProperty('--zen-sidebar-width', `${state.settings.sidebarWidth}px`)
    const borderless = state.settings.borderless || state.window.fullscreen
    // Phones keep a slimmer frame around the content card; the bottom bar sits right under it.
    const phone = formFactor === 'phone'
    root.style.setProperty('--zen-padding', borderless ? '0px' : phone ? '6px' : '8px')
    root.style.setProperty('--zen-content-radius', borderless ? '0px' : phone ? '14px' : '10px')
  }, [
    resolved,
    formFactor,
    state.settings.sidebarWidth,
    state.settings.borderless,
    state.window.fullscreen
  ])

  return resolved
}

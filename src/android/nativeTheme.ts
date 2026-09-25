import type { ColorScheme, UIState } from '@shared/types'
import { cssColorToHex, resolveTheme, rgbToHex } from '@shared/theme'
import { THEME_PAINTED_EVENT, type ThemePaintedDetail } from '@renderer/hooks/useTheme'
import type { Bridge } from './bridge'
import { schemeForPages } from './pageScheme'

/**
 * `chrome.setTheme`'s payload (`Host.applyTheme`): the polarity and the scheme for the system
 * bars and the pages' night mode, the solid colour behind the window, and the chrome's own
 * tokens for what the host draws natively – the scrim over a page behind an in-page back, a
 * native primary control's accent and its ink.
 */
export interface NativeTheme {
  dark: boolean
  scheme: ColorScheme
  background: string
  scrim: string
  accent: string
  onAccent: string
}

/** What the sync needs of the boot: the host's bridge, the core's state events, the state as it stands. */
export interface NativeThemeIo {
  /** `chrome.setTheme` goes out through `send`. */
  bridge: Pick<Bridge, 'send'>
  /** The core's `state` event: every commit, whatever changed; returns the unsubscribe. */
  onState(listener: (state: UIState) => void): () => void
  /** The state as it stands, for a change the state did not announce (the paint, the OS). */
  state(): UIState
}

/**
 * Keep the system bars and the window background in step with the theme the chrome has painted
 * – the active space's, or the private blend's once it has crossed to its dark side (MOT-14:
 * the status bar follows the chrome's own spring, not a guess at it) – so the gradient reaches
 * behind the status bar and its icons stay legible; and hand the chrome's `--zen-scrim` token
 * over, so what the host draws natively (the page behind an in-page back) dims with the same
 * space-tinted scrim as the chrome's own sheets, and `--v2-accent` / `--v2-on-accent`, so a native
 * primary control (the page dialog sheet's OK, PUI-27) is the chrome's own. `useTheme` announces
 * each paint that matters (`zen-theme-painted`); before its first one the space theme is worked
 * out from the state.
 *
 * The tokens are read back from the document, and that read is a forced style recalculation of
 * the chrome – 13 ms of the overview fold's first frame on thirty tabs when it ran on every
 * state event (#349). So it runs ON A CHANGE OF THE THEME and on nothing else: the theme's
 * inputs in the state – the colour-scheme setting and the active space's theme, which are what
 * `chrome.setTheme` carries before the first paint – compared on each state event and read a
 * frame later when they differ (React has written the theme's variables by then); the chrome's
 * own paint (`zen-theme-painted`, whose variables are on the root already: read at once); and
 * the OS's scheme (the `prefers-color-scheme` query, which `system` follows). A state event that
 * leaves the theme as it was reads nothing. One probe carries the three tokens, so a read is one
 * `getComputedStyle` – one recalculation, not three – and the message last handed over is kept:
 * a read that computes the same theme sends nothing. Returns the uninstall (the test's).
 */
export function syncNativeTheme(io: NativeThemeIo): () => void {
  // The theme last handed over, as a key: the same theme is never sent twice.
  let last = ''
  // The theme's inputs in the state as last seen (`themeInputs`): a state event that leaves them
  // as they were is not a theme change.
  let inputs = ''
  let frame: number | null = null
  let painted: ThemePaintedDetail | null = null
  // The scheme the host has for the pages' night mode (`schemeForPages`).
  let handed: ColorScheme | null = null
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
  const fromState = (state: UIState): ThemePaintedDetail => {
    const space = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0]
    const scheme = state.settings.colorScheme
    const dark = scheme === 'system' ? systemDark.matches : scheme === 'dark'
    const resolved = resolveTheme(space?.theme ?? null, dark)
    return { dark, background: rgbToHex(resolved.averageColor) }
  }
  const themeInputs = (state: UIState): string => {
    const { dark, background } = fromState(state)
    return `${state.settings.colorScheme}|${dark}|${background}`
  }
  const read = (state: UIState): void => {
    const { dark, background } = painted ?? fromState(state)
    // `scheme` lets the host set the app's night mode, so pages' `prefers-color-scheme`
    // follows Zenium's own Light / Dark choice and not only the system's – handed over as the
    // chrome's paint crosses to the scheme's side, so the pages flip with the chrome and not
    // a blend ahead of it (`pageScheme.ts`).
    handed = schemeForPages(handed, state.settings.colorScheme, dark, systemDark.matches)
    const { scrim, accent, onAccent } = computedTokenColors()
    const key = `${handed}|${dark}|${background}|${scrim}|${accent}|${onAccent}`
    if (key === last) return
    last = key
    const theme: NativeTheme = { dark, scheme: handed, background, scrim, accent, onAccent }
    io.bridge.send('chrome.setTheme', theme)
  }
  const readNextFrame = (state: () => UIState): void => {
    // The tokens are read back from the document a frame later, once React has written the
    // theme's variables (`useTheme`); the state event this runs on precedes that render.
    if (frame !== null) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = null
      read(state())
    })
  }
  const offState = io.onState((state) => {
    const now = themeInputs(state)
    if (now === inputs) return
    inputs = now
    readNextFrame(() => state)
  })
  const onSystemDark = (): void => readNextFrame(io.state)
  const onPainted = (e: Event): void => {
    painted = (e as CustomEvent<ThemePaintedDetail>).detail
    // A paint is on the root already (`useTheme` writes the variables before it announces):
    // the host hears of the crossing in the same frame, and the pages flip with the chrome.
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    read(io.state())
  }
  systemDark.addEventListener('change', onSystemDark)
  window.addEventListener(THEME_PAINTED_EVENT, onPainted)
  return () => {
    offState()
    systemDark.removeEventListener('change', onSystemDark)
    window.removeEventListener(THEME_PAINTED_EVENT, onPainted)
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }
}

/**
 * The colours the chrome's `--zen-scrim`, `--v2-accent` and `--v2-on-accent` tokens currently
 * compute to, as `#rrggbbaa` each ('' when unreadable), off one probe and one computed style:
 * the tokens are plain colours (`--v2-accent` a `color-mix` of `--zen-accent`), so each reads
 * the same off any colour property, and three properties of one element cost one recalculation.
 */
function computedTokenColors(): { scrim: string; accent: string; onAccent: string } {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = 'var(--zen-scrim)'
  probe.style.backgroundColor = 'var(--v2-accent)'
  probe.style.borderColor = 'var(--v2-on-accent)'
  document.documentElement.appendChild(probe)
  try {
    const style = getComputedStyle(probe)
    return {
      scrim: cssColorToHex(style.color) ?? '',
      accent: cssColorToHex(style.backgroundColor) ?? '',
      onAccent: cssColorToHex(style.borderTopColor) ?? ''
    }
  } finally {
    probe.remove()
  }
}

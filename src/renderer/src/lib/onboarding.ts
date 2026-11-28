import type { HostCapabilities, UIState } from '@shared/types'

/**
 * Which steps the first run shows. Pure over the host's capabilities and the viewport, so the
 * tour can be reasoned about (and tested) without rendering it: a step about sync is only shown
 * where sync exists, and the phone's short flow only asks about the browser role where the host
 * has one to give.
 */

export type TourStep = 'welcome' | 'look' | 'search' | 'import' | 'essentials' | 'sync'

export type PhoneStep = 'welcome' | 'look' | 'search' | 'default'

/** Capabilities that shape the tour (a subset of `HostCapabilities`). */
export type TourCapabilities = Pick<HostCapabilities, 'sync'>

/**
 * Whether the tour is over this window's chrome – the terms `App.tsx` and `TabletShell.tsx`
 * mount it on: the profile's synced window before the tour is done; never a blank or private
 * window, a page's popup or a web app's window. Chrome that would open under it (the URL bar,
 * the new tab shortcut dialog) reads this and waits: the tour's last click ends in a new tab,
 * whose `newtab.opened` arrives after the state that puts the tour away (the core broadcasts
 * the state first). The phone's first run is its shell's own flow and is not asked about here.
 */
export function onboardingCovers(state: Pick<UIState, 'settings' | 'window'>): boolean {
  const { chrome, kind } = state.window
  return (
    !state.settings.onboardingDone && kind === 'synced' && chrome !== 'popup' && chrome !== 'app'
  )
}

/**
 * Whether the phone's first run stands over the window – the one term `PhoneShell.tsx` mounts
 * its flow on (`PhoneOnboarding`): the profile before the tour is done, whatever the window (the
 * phone has one). The flow is the whole window, drawn in the chrome, and on Android the pages
 * lie ABOVE the chrome's WebView: a page view placed while it stands covers it – a fresh
 * profile's first launch from a link (a VIEW intent's tab, active and loaded, is a page to
 * place). So the layout reporter reads this and reports the content hidden while it holds
 * (`useLayoutReporter`: no placement, the view stays hidden under the tour), and the boot's
 * READY waits for no placement under it (`src/android/startup.ts`, `bootNeedsPlacement`, on the
 * core's copy of the same flag). The tour's end puts the flag up (`onboarding.complete`), and
 * the first layout after it places whatever the state then shows, by the ordinary path.
 */
export function phoneOnboardingCovers(state: Pick<UIState, 'settings'>): boolean {
  return !state.settings.onboardingDone
}

/**
 * The desktop tour, Zen's: welcome, look, search engine, Essentials, and sync where the host has
 * it; plus the import offer after the search engine when another browser's profile was found on
 * this computer (`importable`; the probe is `import.sources`, so the step joins the tour once it
 * answers – files alone are no offer).
 */
export function tourSteps(caps: TourCapabilities, importable = false): TourStep[] {
  const steps: TourStep[] = ['welcome', 'look', 'search']
  if (importable) steps.push('import')
  steps.push('essentials')
  if (caps.sync) steps.push('sync')
  return steps
}

/**
 * The phone's first run: welcome, look, search engine, and – where the host has a browser role
 * that Zenium does not hold yet – set as default.
 */
export function phoneSteps(options: {
  defaultBrowser: boolean
  /** The host's live answer; `true` skips the step (nothing to ask), `null` still asks. */
  isDefault: boolean | null
}): PhoneStep[] {
  const steps: PhoneStep[] = ['welcome', 'look', 'search']
  if (options.defaultBrowser && options.isDefault !== true) steps.push('default')
  return steps
}

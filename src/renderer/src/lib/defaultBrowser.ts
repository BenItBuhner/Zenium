import type { DefaultBrowserRequestSource, UIState } from '@shared/types'
import { cmd, run } from './api'
import { pushToast } from './ui'

/** Version as `major.minor`: the granularity at which the default-browser strip returns. */
export function featureVersion(version: string): string {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim())
  return match ? `${match[1]}.${match[2]}` : version.trim()
}

/**
 * Whether the "Make Zenium your default browser" strip may show. Like Chrome's periodic prompt,
 * an answer is remembered for the release it happened in and for its patch releases; the next
 * feature release (a new `major.minor`) asks once more.
 */
export function shouldShowDefaultBrowserPrompt(
  dismissedVersion: string | null,
  currentVersion: string
): boolean {
  if (dismissedVersion === null) return true
  return featureVersion(dismissedVersion) !== featureVersion(currentVersion)
}

/**
 * Whether the strip belongs on this window: the OS said another browser has the role (the core's
 * `DefaultBrowserService` asked the host), the user has not answered for this release, and the
 * window is a regular one (private windows never ask). Not on Android, whatever the form factor:
 * there the core's campaign asks – the promo sheet and the top banner
 * (`components/defaultbrowser`, `PhoneShell`) – and two campaigns on one window would nag twice.
 */
export function wantsDefaultBrowserBanner(state: UIState): boolean {
  const dismissed = state.settings.defaultBrowserPromptDismissed
  return (
    state.platform !== 'android' &&
    state.capabilities.defaultBrowser &&
    state.defaultBrowser.isDefault === false &&
    state.window.kind !== 'private' &&
    state.settings.onboardingDone &&
    shouldShowDefaultBrowserPrompt(typeof dismissed === 'string' ? dismissed : null, state.version)
  )
}

/** Either answer on the strip takes it down until the next feature release. */
export function dismissDefaultBrowserBanner(state: UIState): void {
  run('settings.update', { defaultBrowserPromptDismissed: state.version })
}

/**
 * "Make default" from the strip or the Settings section: the core asks the OS and re-reads the
 * role; the status row repaints on its own. `false` is a refusal on the spot (nothing registered,
 * the system tool failed), the one case the user needs a word about.
 */
export async function requestDefaultBrowser(source: DefaultBrowserRequestSource): Promise<void> {
  const result = await cmd('defaultBrowser.request', { source }).catch(() => false)
  if (result === false) {
    pushToast(
      'Zenium could not be made the default browser. Choose it in your system settings.',
      'error'
    )
  }
}

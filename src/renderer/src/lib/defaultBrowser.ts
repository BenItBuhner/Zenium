import type { UIState } from '@shared/types'
import { shouldShowDefaultBrowserPrompt } from '@shared/defaultBrowser'
import { cmd } from './api'
import { pushToast } from './ui'

/**
 * Whether the "Make Zenium your default browser" strip belongs on this window: the OS said
 * another browser has the role, the user has not said "Not now" for this release, and the
 * window is a regular one (private windows never ask).
 */
export function wantsDefaultBrowserBanner(state: UIState): boolean {
  return (
    state.capabilities.defaultBrowser &&
    state.defaultBrowser.isDefault === false &&
    state.window.kind !== 'private' &&
    state.settings.onboardingDone &&
    shouldShowDefaultBrowserPrompt(state.settings.defaultBrowserPromptDismissed, state.version)
  )
}

/** Runs the request from the strip or the Settings row; the status row repaints on its own. */
export async function requestDefaultBrowser(): Promise<void> {
  const outcome = await cmd('defaultBrowser.makeDefault', undefined).catch(() => 'failed' as const)
  if (outcome === 'failed') {
    pushToast(
      'Zenium could not be made the default browser. Choose it in your system settings.',
      'error'
    )
  }
}

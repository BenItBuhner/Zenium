import type { SafetyCheckResult, SafetyState, UIState } from '@shared/types'

/**
 * The words and the rows of Settings > Safety check (`components/overlays/SafetyCheckSection`),
 * from one `privacy.safetyCheck` result: what the card says, and one row per area with the
 * action that answers it, described here and rendered there.
 */

export function headline(
  result: SafetyCheckResult | null,
  running: boolean,
  error: string | null,
  worst: SafetyState | null
): string {
  if (running && !result) return 'Checking…'
  if (error && !result) return 'Safety check could not run'
  if (!result) return 'Safety check'
  switch (worst) {
    case 'warning':
      return 'Some things need your attention'
    case 'info':
      return 'A few things to look at'
    default:
      return 'Everything looks safe'
  }
}

const RANK: Record<SafetyState, number> = { safe: 0, unavailable: 0, info: 1, warning: 2 }

/** The card's state: the most pressing of the rows', an unavailable row counting as fine. */
export function worstState(result: SafetyCheckResult): SafetyState {
  const states: SafetyState[] = [
    result.updates.state,
    result.safeBrowsing.state,
    result.passwords.state,
    result.permissions.state,
    result.notifications.state,
    result.extensions.state
  ]
  return states.reduce<SafetyState>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), 'safe')
}

/** What a row's button does: a core command, the password checkup, or another Settings section. */
export type SafetyAction =
  | {
      kind: 'command'
      command: 'updates.download' | 'updates.install' | 'updates.openRelease' | 'updates.check'
    }
  | { kind: 'passwords-checkup' }
  | { kind: 'section'; section: 'site-settings' | 'extensions' }

export interface SafetyRow {
  id: keyof Omit<SafetyCheckResult, 'checkedAt'>
  label: string
  state: SafetyState
  summary: string
  action: { label: string; ariaLabel?: string; act: SafetyAction } | null
}

/**
 * One row per area, in Chrome's order, each with the action that answers it where there is one:
 * an update to download, install or look for; the password checkup while the vault is open and
 * holds logins; a review of the sites holding permissions or sending notifications; a look at
 * the flagged extensions on a host that runs them.
 */
export function safetyRows(result: SafetyCheckResult, state: UIState): SafetyRow[] {
  const command = (
    label: string,
    command: Extract<SafetyAction, { kind: 'command' }>['command']
  ): SafetyRow['action'] => ({ label, act: { kind: 'command', command } })
  const section = (
    label: string,
    target: Extract<SafetyAction, { kind: 'section' }>['section'],
    ariaLabel: string
  ): SafetyRow['action'] => ({ label, ariaLabel, act: { kind: 'section', section: target } })

  const updateAction = (): SafetyRow['action'] => {
    if (result.updates.state === 'unavailable') return null
    const phase = state.updates.phase
    if (phase === 'available') return command('Download', 'updates.download')
    if (phase === 'ready') return command('Restart', 'updates.install')
    if (phase === 'error' || phase === 'idle')
      return state.updates.mode === 'manual'
        ? command('Release page', 'updates.openRelease')
        : command('Check', 'updates.check')
    return null
  }
  const passwordAction = (): SafetyRow['action'] =>
    state.passwords.locked || state.passwords.count === 0
      ? null
      : {
          label: 'Check passwords',
          ariaLabel: 'Run the password checkup',
          act: { kind: 'passwords-checkup' }
        }

  return [
    {
      id: 'updates',
      label: 'Updates',
      state: result.updates.state,
      summary: result.updates.summary,
      action: updateAction()
    },
    {
      id: 'safeBrowsing',
      label: 'Safe Browsing',
      state: result.safeBrowsing.state,
      summary: result.safeBrowsing.summary,
      action: null
    },
    {
      id: 'passwords',
      label: 'Passwords',
      state: result.passwords.state,
      summary: result.passwords.summary,
      action: passwordAction()
    },
    {
      id: 'permissions',
      label: 'Site permissions',
      state: result.permissions.state,
      summary: result.permissions.summary,
      action:
        result.permissions.grantedSites > 0
          ? section('Review', 'site-settings', 'Review site permissions')
          : null
    },
    {
      id: 'notifications',
      label: 'Notifications',
      state: result.notifications.state,
      summary: result.notifications.summary,
      action:
        result.notifications.sites.length > 0
          ? section('Review', 'site-settings', 'Review notification permissions')
          : null
    },
    {
      id: 'extensions',
      label: 'Extensions',
      state: result.extensions.state,
      summary: result.extensions.summary,
      action:
        result.extensions.flagged.length > 0 && state.capabilities.extensions
          ? section('Review', 'extensions', 'Review extensions')
          : null
    }
  ]
}

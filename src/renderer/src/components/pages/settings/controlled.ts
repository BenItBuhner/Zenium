import { run } from '@renderer/lib/api'
import type { UIState } from '@shared/types'
import type { RowControl } from './model'

/**
 * The row control for a setting an extension holds (`UIState.extensionControls`, keyed by the
 * setting's path – `fonts.standard`, `fonts.size` – or a name for a setting kept elsewhere):
 * Chrome's extension-controlled indicator as a row property (`RowBase.controlled`), for any
 * builder whose setting an extension API may hold. Nothing while no extension holds the key.
 * Disable goes through the host's own path, the one the Extensions page's switch takes
 * (`extension.setEnabled`); the host drops the extension's layer and the row re-enables
 * through the same state that disabled it.
 */
export function extensionControlled(state: UIState, key: string): RowControl | undefined {
  const control = state.extensionControls[key]
  if (!control) return undefined
  const { extensionId, name } = control
  return {
    extensionId,
    name,
    onDisable: () => run('extension.setEnabled', { id: extensionId, enabled: false })
  }
}

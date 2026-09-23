import type { ExtensionPromptRequest } from '@shared/types'
import { fromSource } from './storeInput'

/** The words of an install, update or permission prompt: its title, its description, its verb. */
export interface PromptCopy {
  title: string
  subtitle: string | null
  accept: string
}

/**
 * The prompt's copy per kind, the same on every surface that asks: the renderer's dialog and
 * sheet (`ExtensionPromptDialog`) and the Android host's native fallback sheet
 * (`src/android/extensionPromptPlan.ts`, drawn when no live window can show the renderer's).
 */
export function promptCopy(
  prompt: Pick<ExtensionPromptRequest, 'kind' | 'name' | 'source'>
): PromptCopy {
  switch (prompt.kind) {
    case 'request':
      return {
        title: `"${prompt.name}" wants additional permissions`,
        subtitle: null,
        accept: 'Allow'
      }
    case 'permissions':
      return {
        title: `"${prompt.name}" needs new permissions`,
        subtitle: 'It was updated and stays off until you allow them',
        accept: 'Allow'
      }
    case 'update':
      return {
        title: `Update "${prompt.name}"?`,
        subtitle: prompt.source ? fromSource(prompt.source) : null,
        accept: 'Update extension'
      }
    default:
      return {
        title: `Add "${prompt.name}"?`,
        subtitle: prompt.source ? fromSource(prompt.source) : null,
        accept: 'Add extension'
      }
  }
}

/** The one line under "It can:" when there is nothing to warn of, per kind. */
export function noWarningsLine(kind: ExtensionPromptRequest['kind']): string {
  return kind === 'permissions' || kind === 'request'
    ? 'No new permissions are needed'
    : 'This extension requires no special permissions'
}

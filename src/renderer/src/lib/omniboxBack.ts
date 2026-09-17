import { createStore } from './store'
import { closeUrlbar, uiStore } from './ui'

/**
 * Predictive back for the phone's omnibox sheet. A host drives the progress (0…1) while a back
 * gesture is in flight – the sheet retreats towards the bar – and then commits or cancels it.
 *
 * `omniboxBackSurface` has the shape of the predictive-back registry's `BackSurface`
 * (`{ name, onStart?, onProgress?, onCommit, onCancel? }`), so registering the sheet there is one
 * `useBackSurface(urlbar.open ? omniboxBackSurface : null)` once the registry is on main;
 * `omniboxBack` keeps the same operations under the `siteInfoBack` names for callers that use
 * those.
 */
export const omniboxBackStore = createStore<{ progress: number }>({ progress: 0 }, 'omnibox-back')

function setProgress(value: number): void {
  omniboxBackStore.set({ progress: Math.min(1, Math.max(0, value)) })
}

function commit(): void {
  omniboxBackStore.set({ progress: 0 })
  closeUrlbar()
}

function cancel(): void {
  omniboxBackStore.set({ progress: 0 })
}

export const omniboxBackSurface = {
  name: 'urlbar',
  onProgress: (progress: number): void => setProgress(progress),
  onCommit: (): void => commit(),
  onCancel: (): void => cancel()
}

export const omniboxBack = {
  isOpen(): boolean {
    return uiStore.get().urlbar.open
  },
  progress: setProgress,
  commit,
  cancel
}

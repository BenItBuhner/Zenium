import { createStore } from './store'
import { closeUrlbar, uiStore } from './ui'

/**
 * Predictive back for the phone's omnibox sheet. A host drives `progress` (0…1) while a back
 * gesture is in flight – the sheet retreats towards the bar – and then commits or cancels it.
 * Same shape as `siteInfoBack`: one entry of a registry of dismissable surfaces, ready to be
 * registered there as is once such a registry exists.
 */
export const omniboxBackStore = createStore<{ progress: number }>({ progress: 0 }, 'omnibox-back')

export const omniboxBack = {
  isOpen(): boolean {
    return uiStore.get().urlbar.open
  },
  progress(value: number): void {
    omniboxBackStore.set({ progress: Math.min(1, Math.max(0, value)) })
  },
  commit(): void {
    omniboxBackStore.set({ progress: 0 })
    closeUrlbar()
  },
  cancel(): void {
    omniboxBackStore.set({ progress: 0 })
  }
}

import { openSettings } from '@renderer/lib/pages'
import { createStore } from '@renderer/lib/store'
import { browserStore, openOverlay } from '@renderer/lib/ui'

/**
 * A request to open one extension's details on the management surface next time it shows:
 * the phone's Settings › Extensions page opens the extension's details sheet, the desktop's
 * Add-ons page pushes its details level. Set by `manageExtension`, taken by the surface.
 */
export const extensionRevealStore = createStore<{ id: string | null }>(
  { id: null },
  'extensionReveal'
)

/**
 * "Manage extension": the management surface with `id`'s details open. Where Settings is a tab
 * (the phone) that is Settings › Extensions (`zen://settings/extensions`); elsewhere the Add-ons
 * overlay, over `activeTabId`'s page.
 */
export function manageExtension(id: string, activeTabId: string | null): void {
  extensionRevealStore.set({ id })
  if (browserStore.get().state?.capabilities.pageTabs) openSettings('extensions')
  else void openOverlay('addons', activeTabId)
}

/** The pending request, if it names an extension the surface can show; taken once. */
export function takeExtensionReveal(knownIds: readonly string[]): string | null {
  const { id } = extensionRevealStore.get()
  if (!id || !knownIds.includes(id)) return null
  extensionRevealStore.set({ id: null })
  return id
}

import type { TranslateStatus, TranslateTabState } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName, sortedByName } from '@shared/languageNames'
import { run } from './api'
import {
  captureActiveTab,
  invalidateSnapshot,
  returnFocusToPage,
  uiStore,
  type TranslateSelectionRequest
} from './ui'

/** The tab's translation state once it has left `idle`; null for tabs the core knows nothing about. */
export function translateStateOf(
  state: UIState,
  tabId: string | null | undefined
): TranslateTabState | null {
  if (!tabId || !state.translate.available) return null
  return state.translate.tabs[tabId] ?? null
}

/** The bar stands for these; `idle` and `detecting` show nothing. */
const BAR_STATUSES: ReadonlySet<TranslateStatus> = new Set<TranslateStatus>([
  'offered',
  'downloading',
  'translating',
  'translated',
  'error'
])

/** The state the translate bar should show for the tab, or null when the bar stays down. */
export function barStateOf(
  state: UIState,
  tabId: string | null | undefined
): TranslateTabState | null {
  const tab = translateStateOf(state, tabId)
  return tab && !tab.dismissed && BAR_STATUSES.has(tab.status) ? tab : null
}

/** A translation is on (or on its way) for the tab: the page shows, or will show, the target language. */
export function isTranslating(tab: TranslateTabState): boolean {
  return tab.status === 'downloading' || tab.status === 'translating' || tab.status === 'translated'
}

/**
 * Change the languages of a tab's translation: a running or finished translation is redone with
 * the new pair at once, an offer only changes what it would translate.
 */
export function retarget(
  tab: TranslateTabState,
  patch: { source?: string; target?: string }
): void {
  if (isTranslating(tab)) {
    run('translate.page', {
      tabId: tab.tabId,
      source: patch.source ?? tab.source ?? undefined,
      target: patch.target ?? tab.target ?? undefined
    })
  } else {
    run('translate.retarget', { tabId: tab.tabId, ...patch })
  }
}

/** "Spanish to English", or just the side that is known. */
export function pairLabel(source: string | null, target: string | null): string {
  const from = source ? languageName(source) : ''
  const to = target ? languageName(target) : ''
  if (from && to) return `${from} to ${to}`
  return from || to
}

export interface LanguageOption {
  value: string
  label: string
}

/** The registry's languages as menulist options, by name, without `except`. */
export function languageOptions(
  codes: readonly string[],
  except: string | null = null
): LanguageOption[] {
  return sortedByName(codes)
    .filter((code) => code !== except)
    .map((code) => ({ value: code, label: languageName(code) }))
}

// ---------------------------------------------------------------------------
// The selection popover
// ---------------------------------------------------------------------------

/**
 * The core asked (`translate.selection` event): put the popover up for the selection. The page
 * is captured first so its snapshot can stand in behind the popover, as under every overlay.
 */
export async function openTranslateSelection(
  request: TranslateSelectionRequest,
  activeTabId: string | null
): Promise<void> {
  if (uiStore.get().overlay === 'none') await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ translateSelection: request, drawerOpen: false })
}

export function closeTranslateSelection(): void {
  if (!uiStore.get().translateSelection) return
  uiStore.set({ translateSelection: null })
  invalidateSnapshot()
  returnFocusToPage()
}

const flags = globalThis as unknown as { __zenTranslateWired?: boolean }
if (!flags.__zenTranslateWired) {
  flags.__zenTranslateWired = true
  // Another chrome surface (URL bar, panel, drawer, menu, another sheet) replaces the popover.
  uiStore.subscribe(() => {
    const ui = uiStore.get()
    if (
      ui.translateSelection &&
      (ui.urlbar.open ||
        ui.overlay !== 'none' ||
        ui.drawerOpen ||
        ui.siteInfoOpen ||
        ui.stageActive)
    )
      closeTranslateSelection()
  })
}

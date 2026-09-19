import { useEffect, useState } from 'react'
import type { TranslateModelInfo, TranslateStatus, TranslateTabState } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName, sortedByName } from '@shared/languageNames'
import { cmd, run } from './api'
import { formatBytes } from './utils'
import { uiStore, type TranslateSelectionRequest } from './ui'

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

/** Reasons a host gives for a model download that never reached the server: network plumbing. */
const UNREACHABLE =
  /net::ERR_|Failed to fetch|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Unable to resolve host|UnknownHostException|SocketTimeoutException|Network is unreachable/i

/**
 * The caption of the bar's error state. The core hands over the reason the engine or the host
 * gave; for a download that never reached the model server that is the platform's network error
 * code, which all mean the same thing to the reader. Everything else is shown as a sentence.
 */
export function errorCaption(error: string | null | undefined): string | null {
  const reason = error?.trim() ?? ''
  if (!reason) return null
  if (UNREACHABLE.test(reason)) return 'The model server could not be reached.'
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

export interface LanguageOption {
  value: string
  label: string
  /**
   * A second line under the label – a model's size – which an anchored picker's row clamps to
   * one line (§9.13) and a phone sheet's row keeps to two (§9.2).
   */
  description?: string
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
// The translation models (Settings > Languages)
// ---------------------------------------------------------------------------

/** One key per language pair, the value a model picker hands back. */
export const pairKey = (m: { from: string; to: string }): string => `${m.from}:${m.to}`

/**
 * The registry's models, read from the core when the component mounts and again whenever `key`
 * changes (the set on the device moved); null until the first answer, empty when the core has
 * none to give.
 */
export function useRegistryModels(key: string): TranslateModelInfo[] | null {
  const [models, setModels] = useState<TranslateModelInfo[] | null>(null)
  useEffect(() => {
    let cancelled = false
    cmd('translate.models', undefined).then(
      (list) => {
        if (!cancelled) setModels(list)
      },
      () => {
        if (!cancelled) setModels([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [key])
  return models
}

/** The pairs neither on the device nor on their way, by name, as options with their size. */
export function modelOptions(models: readonly TranslateModelInfo[]): LanguageOption[] {
  return models
    .filter((m) => !m.installed && !m.downloading)
    .map((m) => ({
      value: pairKey(m),
      label: pairLabel(m.from, m.to),
      description: formatBytes(m.bytes)
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// ---------------------------------------------------------------------------
// The selection popover
// ---------------------------------------------------------------------------

/**
 * The core asked (`translate.selection` event): the selection popover goes up for the request
 * (`TranslateSelectionLayer`). A user-opened surface, it takes the keyboard (v2 draft §9.22), so
 * the chrome gets the focus the page had; the popover itself holds the page's capture behind it
 * while it is up (`useFloatingChrome`) and gives the focus back when it goes.
 */
export function openTranslateSelection(request: TranslateSelectionRequest): void {
  run('focus.chrome', undefined)
  uiStore.set({ translateSelection: request, drawerOpen: false })
}

export function closeTranslateSelection(): void {
  if (!uiStore.get().translateSelection) return
  uiStore.set({ translateSelection: null })
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

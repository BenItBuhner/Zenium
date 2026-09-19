import { useEffect, useState } from 'react'
import type { TranslateModelInfo, TranslateStatus, TranslateTabState } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName, sortedByName } from '@shared/languageNames'
import { cmd, run } from './api'
import { formatBytes } from './utils'
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
// Desktop popovers (v2 draft §9.20)
// ---------------------------------------------------------------------------

/** A popover keeps this much from the window's edges. */
export const POPOVER_MARGIN = 8
/** A popover is at most this share of the window tall. */
const POPOVER_HEIGHT_SHARE = 0.6

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

export interface Placement {
  left: number
  top: number
  maxHeight: number
}

/**
 * Where a popover `width` wide goes for a trigger at `anchor` inside `bar`, in a window of
 * `window` size, wanting to be `wanted` tall: its top border on the bar's bottom edge (gap 0 to
 * the bar), start-aligned with the trigger – end-aligned when the trigger is in the trailing
 * half of its bar – clamped 8 px inside the window; as tall as it wants up to 60% of the window
 * (never the window less 16); above the bar only when the space under it has no room for
 * `minHeight` and the space above has more.
 */
export function placePopover(
  anchor: Box,
  bar: Box,
  window: { width: number; height: number },
  size: { width: number; wanted: number; minHeight: number }
): Placement {
  const cap = Math.min(
    Math.floor(window.height * POPOVER_HEIGHT_SHARE),
    window.height - 2 * POPOVER_MARGIN
  )
  const below = window.height - bar.bottom - POPOVER_MARGIN
  const above = bar.top - POPOVER_MARGIN
  const flip = below < Math.min(size.wanted, size.minHeight) && above > below
  const maxHeight = Math.max(size.minHeight, Math.min(size.wanted, cap, flip ? above : below))
  const trailing = (anchor.left + anchor.right) / 2 > (bar.left + bar.right) / 2
  const left = trailing ? anchor.right - size.width : anchor.left
  return {
    left: Math.max(POPOVER_MARGIN, Math.min(left, window.width - size.width - POPOVER_MARGIN)),
    top: flip ? bar.top - maxHeight : bar.bottom,
    maxHeight
  }
}

/**
 * Where a popover `width` wide and `height` tall goes for a request at the point (`x`, `y`) in
 * window pixels (the selection popover, which opens from the page rather than a bar): its start
 * edge on the point and its top edge under it – above it when there is no room below – clamped
 * 8 px inside the window.
 */
export function placeAtPoint(
  x: number,
  y: number,
  window: { width: number; height: number },
  size: { width: number; height: number }
): { left: number; top: number } {
  const top = y + size.height > window.height - POPOVER_MARGIN ? y - size.height : y
  return {
    left: Math.max(POPOVER_MARGIN, Math.min(x, window.width - size.width - POPOVER_MARGIN)),
    top: Math.max(POPOVER_MARGIN, Math.min(top, window.height - size.height - POPOVER_MARGIN))
  }
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

// ---------------------------------------------------------------------------
// The menulists' lists
// ---------------------------------------------------------------------------

/**
 * A menulist is about to open its list. The list overhangs the content area, where the page
 * view is drawn above the chrome, so the page gives way to its snapshot while the list is up (as
 * under the sheets and the selection popover); a surface that already stands over the page has
 * the snapshot in place. Resolves once the list may show.
 */
export async function prepareMenulist(activeTabId: string | null): Promise<void> {
  if (uiStore.get().overlay === 'none') await captureActiveTab(activeTabId)
}

/** The list is up. */
export function menulistOpened(): void {
  uiStore.set({ menulistOpen: true })
}

/** The list is gone; the page comes back unless another surface still stands over it. */
export function menulistClosed(): void {
  if (!uiStore.get().menulistOpen) return
  uiStore.set({ menulistOpen: false })
  invalidateSnapshot()
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

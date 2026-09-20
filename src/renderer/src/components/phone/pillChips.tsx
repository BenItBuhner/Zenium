/* eslint-disable react-refresh/only-export-components -- the pill's chip kit: the run and the ruler ship with the chip models they draw, the fold hook that measures them and the store the site-information sheet reads */
import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AudioLines, Languages, Lock, Shield, ShieldOff } from 'lucide-react'
import { internalPageOf } from '@shared/internalPages'
import type { TranslateTabState } from '@shared/translate'
import type { Tab, UIState } from '@shared/types'
import { isWebPageUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { blockedChipLabel, siteBlockingState } from '@renderer/lib/blockingUi'
import { extensionPageChrome } from '@renderer/lib/extensions/pages'
import { mediaSession } from '@renderer/lib/media'
import { mediaTitle } from '@renderer/lib/mediaHub'
import { openSettings } from '@renderer/lib/pages'
import {
  PILL_CHIP_BOX,
  foldPillChips,
  pillChipCost,
  type PillChipSpec,
  type PillFold
} from '@renderer/lib/pillChips'
import { closeSiteInfo, dismissSiteInfo } from '@renderer/lib/siteInfo'
import { createStore } from '@renderer/lib/store'
import { barStateOf, isTranslating, translateStateOf } from '@renderer/lib/translate'
import { openMediaSheet, overlayAvailable } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BlockedChip } from '../urlbar/BlockedChip'
import { PillChip } from '../urlbar/PillChip'

/*
 * The phone pill's trailing chips as data (v2 §9.29, OMN-02): what each one is, what it says,
 * what it does, how it draws – built once from the browser state, then drawn by the pill (the
 * chips that fit), the ruler that measures them, the ghost that cross-fades a change, and the
 * site-information sheet's folded rows (the chips that did not fit), so the sheet carries the
 * same names, states and actions as the pill and nothing is lost, only moved. The fold itself
 * is `lib/pillChips.ts`'s pure model; this module measures the pill for it (once per change,
 * never per frame) and draws what it decides.
 */

/** The chips the phone pill can hold after the address, in the pill's order. */
export type PillChipId = 'blocked' | 'lock' | 'translate' | 'media'

/** The id the pill's leading glyph (the anchor the fold never touches) measures under. */
export const PILL_ANCHOR_ID = 'site-info'

/** The space label at the pill's end measures under this id: not a chip, but it takes room. */
export const PILL_SPACE_ID = 'space'

/** How long a chip's fold or unfold cross-fades, on opacity (v2 §11.4; the same under reduced motion). */
export const CHIP_FOLD_FADE_MS = 120

/** A folded chip's row in the site-information sheet: the same name, state and action. */
export interface PillChipRow {
  glyph: ReactNode
  label: string
  value?: string
  /** What the row does, sheet included: it leaves the sheet when what it opens replaces it. */
  activate: () => void
}

export interface PillChipModel {
  id: PillChipId
  /** The state TalkBack hears at the address once the chip folded (`foldedChipsSpoken`). */
  spoken: string
  /** The chip's flow width before the ruler measured it (its 44 box less the margins). */
  flow: number
  /** What can change the chip's width; the ruler measures again when it changes. */
  measureKey: string
  /** Draw the chip: a real button in the pill, an inert span for the ghost, the ruler and the carried pill. */
  render: (interactive: boolean) => ReactNode
  /** Its row in the sheet once folded; null when the sheet carries the state anyway (the lock: the Connection row). */
  row: PillChipRow | null
}

/** What the pill's chips need to know of the chrome around them. */
export interface PillChipContext {
  siteInfoOpen: boolean
  mediaSheetOpen: boolean
  /** The tab on screen: the media sheet takes its picture (`openMediaSheet`). */
  activeTabId: string | null
}

const CHIP_CLASS = '-mx-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-full'
const STANDARD_FLOW = PILL_CHIP_BOX - 24

function translateSpoken(translation: TranslateTabState): string {
  switch (translation.status) {
    case 'offered':
      return 'Translation offered'
    case 'downloading':
    case 'translating':
      return 'Translating'
    case 'translated':
      return 'Translated'
    case 'error':
      return 'Translation failed'
    default:
      return ''
  }
}

function blockedSpoken(tab: Tab, state: UIState): string {
  const siteState = siteBlockingState(tab, state.blocking, state.settings.blocking)
  switch (siteState) {
    case 'blocking':
      return tab.blockedCount > 0
        ? `${tab.blockedCount} ${tab.blockedCount === 1 ? 'request' : 'requests'} blocked`
        : 'Nothing blocked yet'
    case 'excepted':
      return 'Blocking off for this site'
    case 'off':
      return 'Blocking off'
    default:
      return ''
  }
}

/**
 * The chips the phone pill shows after the address for `tab`, in the pill's order: the blocked
 * count, the lock, the translate offer, the Now playing chip – each present on the same terms
 * as before the fold (see `PillContent`), the fold deciding afterwards which stay. Nothing for
 * an internal page, an extension's page or no tab.
 */
export function phonePillChips(
  state: UIState,
  tab: Tab | null,
  ctx: PillChipContext
): PillChipModel[] {
  if (!tab) return []
  const extension = extensionPageChrome(tab.url, state.extensions)
  // An internal page (Settings) has no site: no shield, no lock (v2 §10.1); an extension's page
  // is neither a secure site nor an insecure one (§10.1 applied to extension pages).
  const page = internalPageOf(tab.url) !== null
  const chips: PillChipModel[] = []

  // The blocked count: on every web page while the host blocks requests; opens the site
  // information from the pill. Folded, its row leads on to Settings › Privacy, where the
  // blocking lists live: the sheet it would open is the one the row is in.
  if (!page && !extension && state.capabilities.requestBlocking) {
    const siteState = siteBlockingState(tab, state.blocking, state.settings.blocking)
    if (siteState !== 'no-site') {
      const label = blockedChipLabel(siteState, tab.blockedCount)
      chips.push({
        id: 'blocked',
        spoken: blockedSpoken(tab, state),
        flow: PILL_CHIP_BOX - 8,
        measureKey: `${siteState}:${tab.blockedCount}`,
        render: (interactive) => (
          <BlockedChip tab={tab} state={state} variant="phone" interactive={interactive} />
        ),
        row: {
          glyph: siteState === 'blocking' ? <Shield /> : <ShieldOff />,
          label: label.replace(/ · Site information$/, ''),
          activate: () => {
            if (!overlayAvailable('settings')) dismissSiteInfo()
            openSettings('privacy')
          }
        }
      })
    }
  }

  // The lock: a secure connection – no lock over a certificate that failed verification (the
  // interstitial, or the page the user proceeded to). It opens the site information, whose
  // Connection row says the same – folded, it lands on that row and adds none of its own.
  const secure = tab.url.startsWith('https://') && !tab.certificateError && !extension && !page
  if (secure) {
    chips.push({
      id: 'lock',
      spoken: 'Connection is secure',
      flow: STANDARD_FLOW,
      measureKey: 'lock',
      render: (interactive) => (
        <PillChip
          inert={!interactive}
          label="Connection is secure"
          popup="dialog"
          expanded={ctx.siteInfoOpen}
          data-site-info
          className={CHIP_CLASS}
        >
          <Lock className="h-3.5 w-3.5 opacity-50" />
        </PillChip>
      ),
      row: null
    })
  }

  // Translation: there once the page has been offered or translated (in the accent while the
  // translation shows). The chip raises the translate bar or puts it away; the row does the
  // same from the sheet, which closes so the bar under the pill is seen.
  const translation = isWebPageUrl(tab.url) ? translateStateOf(state, tab.id) : null
  if (translation) {
    const barUp = barStateOf(state, tab.id) !== null
    const label = barUp ? 'Hide the translation bar' : 'Translate this page'
    const translating = isTranslating(translation)
    const toggle = (): void => {
      if (barUp) run('translate.dismiss', { tabId: tab.id })
      else run('translate.offer', { tabId: tab.id })
    }
    chips.push({
      id: 'translate',
      spoken: translateSpoken(translation),
      flow: STANDARD_FLOW,
      measureKey: 'translate',
      render: (interactive) => (
        <PillChip
          inert={!interactive}
          label={label}
          data-translate
          className={cn(CHIP_CLASS, translating ? 'text-[var(--zen-accent)]' : 'opacity-50')}
        >
          <Languages className="h-3.5 w-3.5" />
        </PillChip>
      ),
      row: {
        glyph: <Languages />,
        label,
        value: translating ? 'Translated' : undefined,
        activate: () => {
          closeSiteInfo()
          toggle()
        }
      }
    })
  }

  // Now playing (MW-16): while a tab holds the media session, whichever pill is up; in the
  // accent while it plays. Opens the in-app player; from the sheet the player takes over.
  const session = mediaSession(state)
  if (session) {
    const label = session.playing ? 'Now playing' : 'Media paused'
    const sessionTab = state.tabs[session.tabId]
    chips.push({
      id: 'media',
      spoken: label,
      flow: STANDARD_FLOW,
      measureKey: 'media',
      render: (interactive) => (
        <PillChip
          inert={!interactive}
          label={label}
          popup="dialog"
          expanded={ctx.mediaSheetOpen}
          data-media
          data-testid="media-chip"
          data-state={session.playing ? 'playing' : 'paused'}
          className={cn(CHIP_CLASS, session.playing ? 'text-[var(--zen-accent)]' : 'opacity-50')}
        >
          <AudioLines className="h-3.5 w-3.5" />
        </PillChip>
      ),
      row: {
        glyph: <AudioLines />,
        label,
        value: mediaTitle(session, sessionTab),
        activate: () => {
          dismissSiteInfo()
          void openMediaSheet(session.tabId, ctx.activeTabId)
        }
      }
    })
  }

  return chips
}

// ---------------------------------------------------------------------------
// What folded, for the sheet
// ---------------------------------------------------------------------------

export interface PillChipsFolded {
  /** The tab whose pill folded these. */
  tabId: string | null
  /** The ids of the chips folded out of the pill, the first to fold first. */
  folded: string[]
}

/** The docked pill publishes what it folded; the site-information sheet lists it. */
export const pillChipsStore = createStore<PillChipsFolded>(
  { tabId: null, folded: [] },
  'zen:pill-chips'
)

/** The folded chips of `tab`'s pill that have a row of their own in the sheet. */
export function foldedChipRows(
  state: UIState,
  tab: Tab,
  folded: PillChipsFolded,
  ctx: PillChipContext
): Array<PillChipModel & { row: PillChipRow }> {
  if (folded.tabId !== tab.id || folded.folded.length === 0) return []
  const set = new Set(folded.folded)
  return phonePillChips(state, tab, ctx).filter(
    (chip): chip is PillChipModel & { row: PillChipRow } => set.has(chip.id) && chip.row !== null
  )
}

// ---------------------------------------------------------------------------
// Measuring the pill
// ---------------------------------------------------------------------------

interface Measure {
  /** The pill's content width, in px: what the address and everything beside it share. */
  room: number
  /** Each item's flow width by id (`data-chip` on the ruler's wrappers). */
  flows: Record<string, number>
}

/** The last measure taken by any pill: the first render of a remounted pill folds from it. */
let lastMeasure: Measure = { room: 0, flows: {} }

function sameMeasure(a: Measure, b: Measure): boolean {
  if (a.room !== b.room) return false
  const ka = Object.keys(a.flows)
  const kb = Object.keys(b.flows)
  return ka.length === kb.length && ka.every((k) => a.flows[k] === b.flows[k])
}

function readRuler(span: HTMLElement, ruler: HTMLElement): Measure {
  const flows: Record<string, number> = {}
  for (const child of Array.from(ruler.children)) {
    const id = child.getAttribute('data-chip')
    if (id) flows[id] = (child as HTMLElement).offsetWidth
  }
  return { room: span.clientWidth, flows }
}

/**
 * Measure the pill and fold its chips. `spanRef` is the pill's content row (the address and
 * the chips share its width), `rulerRef` the hidden ruler holding an inert copy of every item
 * the fold has to account for – the leading glyph, each chip, the space label – each in a
 * wrapper carrying `data-chip=<id>` whose width is the item's flow (its box less the margins
 * that lay it over the pitch). One read of the layout per change: on mount and when the chip
 * set or a chip's content changes (`signature`), and through a ResizeObserver when the pill's
 * width changes (a rotation, the bar's buttons rearranged) or an item's does (the text zoom
 * growing a badge). Never per frame. An unmeasured item counts its estimate; an unlaid-out pill
 * (0 wide) folds nothing.
 */
export function usePillFold(
  spanRef: RefObject<HTMLElement | null>,
  rulerRef: RefObject<HTMLElement | null>,
  chips: readonly PillChipModel[],
  signature: string
): PillFold {
  const [measure, setMeasure] = useState<Measure>(lastMeasure)
  useLayoutEffect(() => {
    const span = spanRef.current
    const ruler = rulerRef.current
    if (!span || !ruler) return
    const read = (): void => {
      const next = readRuler(span, ruler)
      lastMeasure = next
      setMeasure((m) => (sameMeasure(m, next) ? m : next))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(span)
    observer.observe(ruler)
    return () => observer.disconnect()
  }, [spanRef, rulerRef, signature])

  const flowOf = (id: string, estimate: number): number => {
    const measured = measure.flows[id]
    return measured !== undefined && measured > 0 ? measured : estimate
  }
  const space = measure.flows[PILL_SPACE_ID]
  const room = measure.room - (space ? pillChipCost(space) : 0)
  const specs: PillChipSpec[] = [
    { id: PILL_ANCHOR_ID, tier: 'anchor', width: pillChipCost(flowOf(PILL_ANCHOR_ID, 18)) },
    ...chips.map((chip) => ({ id: chip.id, width: pillChipCost(flowOf(chip.id, chip.flow)) }))
  ]
  return foldPillChips(specs, room)
}

/**
 * The ruler: an inert copy of every item the fold accounts for, out of the flow and hidden,
 * laid out as the pill lays them out so their widths are what they take in it. `items` map an
 * id to the copy to measure.
 */
export function PillRuler({
  rulerRef,
  items
}: {
  rulerRef: RefObject<HTMLSpanElement | null>
  items: ReadonlyArray<[id: string, copy: ReactNode]>
}): JSX.Element {
  return (
    <span ref={rulerRef} className="zen-pill-ruler" aria-hidden="true">
      {items.map(([id, copy]) => (
        <span key={id} data-chip={id} className="inline-flex shrink-0 items-center">
          {copy}
        </span>
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The chip run and its cross-fade
// ---------------------------------------------------------------------------

/** Each chip's slot counted from the run's end, where the run is anchored. */
function slotsFromEnd(chips: readonly PillChipModel[]): Map<string, number> {
  const slots = new Map<string, number>()
  chips.forEach((chip, i) => slots.set(chip.id, chips.length - 1 - i))
  return slots
}

/**
 * The chips after the address, drawn in the pill. When the set changes – a chip folds or
 * unfolds, arrives or leaves – the run it showed until this commit is kept as a ghost over the
 * new one, anchored at the run's end like the run itself, and the change cross-fades on opacity
 * over {@link CHIP_FOLD_FADE_MS} in place (v2 §11.4; the same under reduced motion): a chip that
 * keeps its slot does not move or flicker (its ghost copy is hidden), a chip that leaves fades
 * out where it stood, a chip that arrives fades in where it stands. Never a slide. The carried
 * pill (`interactive` false) draws the run plain: it is a picture of the docked one.
 */
export function ChipRun({
  chips,
  interactive
}: {
  chips: readonly PillChipModel[]
  interactive: boolean
}): JSX.Element | null {
  const runRef = useRef<HTMLSpanElement | null>(null)
  const ghostRef = useRef<HTMLSpanElement | null>(null)
  const key = chips.map((c) => c.id).join('|')
  /** What the last commit drew: the run a change of set keeps as the ghost. */
  const shown = useRef<{ key: string; chips: readonly PillChipModel[] } | null>(null)
  const [ghost, setGhost] = useState<{ key: number; chips: readonly PillChipModel[] } | null>(null)
  useLayoutEffect(() => {
    const last = shown.current
    shown.current = { key, chips }
    if (interactive && last && last.key !== key) {
      setGhost((g) => ({ key: (g?.key ?? 0) + 1, chips: last.chips }))
    }
  }, [key, chips, interactive])
  useLayoutEffect(() => {
    if (!ghost) return
    // Started before the paint, so the first frame already has the ghost over the new run.
    const fade = (el: Element | null | undefined, to: 0 | 1): Animation | null => {
      if (!(el instanceof HTMLElement) || typeof el.animate !== 'function') return null
      const rest = Number(getComputedStyle(el).opacity) || 1
      const anim = el.animate(
        to === 0 ? [{ opacity: rest }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: rest }],
        { duration: CHIP_FOLD_FADE_MS, easing: 'linear', fill: to === 0 ? 'forwards' : 'none' }
      )
      // A cancelled animation rejects its `finished`; nothing waits on it.
      anim.finished.catch(() => undefined)
      return anim
    }
    const live = slotsFromEnd(chips)
    const was = slotsFromEnd(ghost.chips)
    const anims: Animation[] = []
    ghost.chips.forEach((chip, i) => {
      const copy = ghostRef.current?.children[i]
      if (!(copy instanceof HTMLElement)) return
      if (live.get(chip.id) === was.get(chip.id)) copy.style.visibility = 'hidden'
      else anims.push(...[fade(copy, 0)].filter((a): a is Animation => a !== null))
    })
    chips.forEach((chip, i) => {
      if (was.get(chip.id) === live.get(chip.id)) return
      // The live chip itself: its wrapper is `display: contents` and paints nothing.
      const el = runRef.current?.children[i]?.firstElementChild
      anims.push(...[fade(el, 1)].filter((a): a is Animation => a !== null))
    })
    const timer = window.setTimeout(
      () => setGhost((g) => (g?.key === ghost.key ? null : g)),
      CHIP_FOLD_FADE_MS
    )
    return () => {
      window.clearTimeout(timer)
      for (const a of anims) a.cancel()
    }
  }, [ghost, chips])
  if (chips.length === 0 && !ghost) return null
  return (
    <span ref={runRef} className="zen-pill-run" data-testid="pill-chips">
      {chips.map((chip) => (
        <span key={chip.id} className="contents" data-chip={chip.id}>
          {chip.render(interactive)}
        </span>
      ))}
      {ghost && (
        <span
          key={ghost.key}
          ref={ghostRef}
          className="zen-pill-run zen-pill-run-ghost"
          aria-hidden="true"
        >
          {ghost.chips.map((chip) => (
            <span key={chip.id} className="inline-flex shrink-0 items-center">
              {chip.render(false)}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

/**
 * Publish what the docked pill folded for `tabId`, once per change: the site-information
 * sheet lists those chips. The carried pill and the tests' detached pills do not publish.
 */
export function usePublishFold(publish: boolean, tabId: string | null, folded: string[]): void {
  const key = folded.join('|')
  useEffect(() => {
    if (!publish) return
    const current = pillChipsStore.get()
    if (current.tabId === tabId && current.folded.join('|') === key) return
    pillChipsStore.set({ tabId, folded: key ? key.split('|') : [] })
  }, [publish, tabId, key])
}

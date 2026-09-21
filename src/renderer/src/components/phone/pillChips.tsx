/* eslint-disable react-refresh/only-export-components -- the pill's chip kit: the run that draws the chips ships with the chip models it draws and the rows the site-information sheet lists */
import type { JSX, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { AudioLines, Languages, Lock, Shield, ShieldOff } from 'lucide-react'
import { internalPageOf } from '@shared/internalPages'
import type { TranslateTabState } from '@shared/translate'
import type { Tab, UIState } from '@shared/types'
import { isWebPageUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { chipCount, requests, siteBlockingState } from '@renderer/lib/blockingUi'
import { extensionPageChrome } from '@renderer/lib/extensions/pages'
import { mediaSession } from '@renderer/lib/media'
import { openSettings } from '@renderer/lib/pages'
import { PRIVATE_TAB_PLACEHOLDER, mediaMasked } from '@renderer/lib/privateLock'
import {
  foldPillChips,
  liveArrival,
  pillChipFold,
  type PillChipFold,
  type PillFold
} from '@renderer/lib/pillChips'
import { closeSiteInfo, dismissSiteInfo } from '@renderer/lib/siteInfo'
import { barStateOf, isTranslating, pairLabel, translateStateOf } from '@renderer/lib/translate'
import { openMediaSheet, overlayAvailable } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { PillChip } from '../urlbar/PillChip'

/*
 * The phone pill's trailing chips as data (OMN-02; v2 §9.29 as amended on Bennett's ruling, see
 * `lib/pillChips.ts`): what each one is, what it says, what it does, how it draws – built once
 * from the browser state, then drawn by the pill (the lock, or the live state chip in its
 * slot), by the ghost that cross-fades a change, and listed by the site-information sheet (the
 * shield with its count, the translate offer, a state waiting behind a newer one) as rows with
 * the same names, states and actions the chips had (#115's shield, #106's translate offer,
 * #233's media chip re-hosted, not rewritten: their words and their commands are the services'
 * helpers), so nothing is lost, only moved.
 */

/**
 * The chips the phone pill knows after the address, in the pill's order. `save-prompt` is
 * §9.29's other state chip – a save-password or save-address key – for when the phone grows one
 * (the desktop has `AutofillChip`); the slot rule already holds for it.
 */
export type PillChipId = 'lock' | 'blocked' | 'translate' | 'media' | 'save-prompt'

/** How long a chip's arrival or departure cross-fades, on opacity (v2 §11.4; the same under reduced motion). */
export const CHIP_FOLD_FADE_MS = 120

/** A chip's row in the site-information sheet: the same name, state and action. */
export interface PillChipRow {
  glyph: ReactNode
  label: string
  value?: string
  /** What the row does, sheet included: it leaves the sheet when what it opens replaces it. */
  activate: () => void
}

export interface PillChipModel {
  id: PillChipId
  fold: PillChipFold
  /** The state TalkBack hears at the address for a chip in the sheet; '' for nothing to report. */
  spoken: string
  /** Draw the chip in the pill: a real button, or an inert span for the ghost and the carried pill. A sheet chip has none. */
  render?: (interactive: boolean) => ReactNode
  /** Its row in the sheet. The glyph has none; a state chip has both, for when it waits behind a newer state. */
  row?: PillChipRow
}

/** What the pill's chips need to know of the chrome around them. */
export interface PillChipContext {
  siteInfoOpen: boolean
  mediaSheetOpen: boolean
  /** The tab on screen, for a row that opens something over its picture. */
  activeTabId: string | null
  /**
   * The tab is a private tab under the lock (INC-05): nothing of the page's identity is drawn or
   * spoken – no lock, no shield, no translate offer – until the screen lock is passed. A live
   * state (Now playing) is not identity and stays, as Chrome's media notification does.
   */
  locked?: boolean
}

/** A §9.3 44 × 44 box laid over the pill's 28 pitch (#237): the negative margins carry the difference. */
const CHIP_CLASS = '-mx-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-full'

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

/** The translate row's value: the pair on offer in the bar's words, else where the translation is. */
function translateValue(translation: TranslateTabState): string | undefined {
  switch (translation.status) {
    case 'offered':
      return pairLabel(translation.source, translation.target) || undefined
    case 'downloading':
    case 'translating':
      return 'Translating…'
    case 'translated':
      return 'Translated'
    case 'error':
      return 'Failed'
    default:
      return undefined
  }
}

/**
 * The chips the phone pill has after the address for `tab`, in the pill's order: the lock, the
 * blocking shield with its count, the translate offer, the Now playing chip – each present on
 * the same terms as when the pill drew them all (#106, #115, #233), `lib/pillChips.ts`'s rule
 * deciding which the pill draws and which the sheet lists. Nothing for an internal page, an
 * extension's page or no tab.
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
  // A private tab under the lock says nothing of its page (§9.19): the identity chips wait for
  // the unlock; the media state alone is drawn.
  const identity = !ctx.locked
  const chips: PillChipModel[] = []

  // The lock: the pill's one site-information glyph after the host – a secure connection, and no
  // lock over a certificate that failed verification (the interstitial, or the page the user
  // proceeded to). It opens the site information, as the favicon ahead of the host does.
  const secure =
    identity && tab.url.startsWith('https://') && !tab.certificateError && !extension && !page
  if (secure) {
    chips.push({
      id: 'lock',
      fold: pillChipFold('lock'),
      spoken: '',
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
      )
    })
  }

  // The blocking shield and its count (#115): on every web page while the host blocks requests.
  // In the sheet it is the row the count goes on – the shield glyph, the count as the value (the
  // chip's own formatting), "Off for this site" or "Blocking off" when nothing is blocked here –
  // and it leads on to Settings › Privacy and security, where the lists and the site exceptions
  // are; the sheet leaves first, as its Site settings row does.
  if (identity && !page && !extension && state.capabilities.requestBlocking) {
    const siteState = siteBlockingState(tab, state.blocking, state.settings.blocking)
    if (siteState !== 'no-site') {
      const count = tab.blockedCount
      const value =
        siteState === 'blocking'
          ? chipCount(count)
          : siteState === 'excepted'
            ? 'Off for this site'
            : 'Blocking off'
      const spoken =
        siteState === 'blocking'
          ? count > 0
            ? `${requests(count)} blocked`
            : ''
          : siteState === 'excepted'
            ? 'Blocking off for this site'
            : 'Blocking off'
      chips.push({
        id: 'blocked',
        fold: pillChipFold('blocked'),
        spoken,
        row: {
          glyph: siteState === 'blocking' ? <Shield /> : <ShieldOff />,
          label: 'Requests blocked',
          value,
          activate: () => {
            if (!overlayAvailable('settings')) dismissSiteInfo()
            openSettings('privacy')
          }
        }
      })
    }
  }

  // The translate offer (#106): there once the page has been offered or translated. The chip
  // raised the translate bar or put it away; the row does the same from the sheet, which closes
  // so the bar under the pill is seen. The value is the pair on offer in the bar's words.
  const translation = identity && isWebPageUrl(tab.url) ? translateStateOf(state, tab.id) : null
  if (translation) {
    const barUp = barStateOf(state, tab.id) !== null
    const label = barUp ? 'Hide the translation bar' : 'Translate this page'
    const toggle = (): void => {
      if (barUp) run('translate.dismiss', { tabId: tab.id })
      else run('translate.offer', { tabId: tab.id })
    }
    chips.push({
      id: 'translate',
      fold: pillChipFold('translate'),
      spoken: translateSpoken(translation),
      row: {
        glyph: (
          <Languages
            className={isTranslating(translation) ? 'text-[var(--zen-accent)]' : undefined}
          />
        ),
        label,
        value: translateValue(translation),
        activate: () => {
          closeSiteInfo()
          toggle()
        }
      }
    })
  }

  // Now playing (MW-16, #233; §9.33): a transient state chip, in the pill while a tab holds the
  // media session – whichever pill is up – and gone otherwise; in the accent while it plays. It
  // takes the glyph's slot (§9.29: the lock gives way and returns when the media stops). Opens
  // the in-app player – from the pill, or from its sheet row while a newer state has the slot,
  // the sheet leaving for the player. The session a locked private tab's (`MediaState.private`
  // under the lock, INC-05): the state is said, the title is not – the row reads "Private tab"
  // (§9.19), as the player it opens does.
  const session = mediaSession(state)
  if (session) {
    const label = session.playing ? 'Now playing' : 'Media paused'
    const masked = mediaMasked(session)
    chips.push({
      id: 'media',
      fold: pillChipFold('media'),
      spoken: label,
      row: {
        glyph: <AudioLines className={session.playing ? 'text-[var(--zen-accent)]' : undefined} />,
        label,
        value: masked ? PRIVATE_TAB_PLACEHOLDER : session.title?.trim() || undefined,
        activate: () => {
          dismissSiteInfo()
          void openMediaSheet(session.tabId, ctx.activeTabId)
        }
      },
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
      )
    })
  }

  return chips
}

/*
 * The live states' order of arrival (`liveArrival`), oldest first, as the pill has seen them:
 * the one record the pill and the sheet both fold by, so they agree on which state has the
 * slot and which waits. Brought up to date from every set of chips built – idempotent for the
 * same set, so the pill, the carried pill and the sheet building the same state in one commit
 * leave it as they found it.
 */
let arrival: readonly string[] = []

/** Forget the states' order of arrival (tests). */
export function resetLiveArrival(): void {
  arrival = []
}

function arrivalOf(chips: readonly PillChipModel[]): readonly string[] {
  const live = chips.filter((c) => c.fold === 'live').map((c) => c.id)
  const next = liveArrival(arrival, live)
  if (next.length !== arrival.length || next.some((id, i) => id !== arrival[i])) arrival = next
  return arrival
}

/** The pill's chips folded by the rule and the states' record: what the pill draws, what the sheet lists, what gave way. */
export function foldPhonePillChips(chips: readonly PillChipModel[]): PillFold<PillChipModel> {
  return foldPillChips(chips, arrivalOf(chips))
}

/** The chips the pill draws after the address: the lock, or the live state chip in its slot. */
export function pillChipsDrawn(chips: readonly PillChipModel[]): PillChipModel[] {
  return foldPhonePillChips(chips).shown
}

/** The chips the sheet lists for `tab`, in the pill's order, each with its row. */
export function pillChipRows(
  state: UIState,
  tab: Tab,
  ctx: PillChipContext
): Array<PillChipModel & { row: PillChipRow }> {
  return foldPhonePillChips(phonePillChips(state, tab, ctx)).folded.filter(
    (chip): chip is PillChipModel & { row: PillChipRow } => chip.row !== undefined
  )
}

/**
 * What TalkBack hears of the sheet's chips at the pill's one stop, in the pill's order: their
 * states – "5 requests blocked", "Translation offered" – which `phoneAddressLabel` (#237's
 * address label, `lib/pillLabel.ts`) speaks after the connection's state. States rather than a
 * count: "2 more in site information" would send the user to the sheet to learn what a glance
 * at its rows tells a sighted user; the states say it here. A chip with nothing to report
 * (nothing blocked yet) says nothing, so the label on a quiet page is #237's alone. A live state
 * waiting in the sheet is spoken here too ("Now playing"); the one in the pill has its own stop.
 */
export function pillChipsSpoken(chips: readonly PillChipModel[]): string[] {
  return foldPhonePillChips(chips).folded.map((chip) => chip.spoken)
}

// ---------------------------------------------------------------------------
// The chip run and its cross-fade
// ---------------------------------------------------------------------------

/** Each chip's slot counted from the run's end, where the run is anchored. */
function slotsFromEnd(ids: readonly string[]): Map<string, number> {
  const slots = new Map<string, number>()
  ids.forEach((id, i) => slots.set(id, ids.length - 1 - i))
  return slots
}

interface Ghost {
  key: number
  /** The run the pill showed until the change: the ghost's copies. */
  chips: readonly PillChipModel[]
  /** The run it changed to, by id: what fades in, what keeps its slot. */
  live: readonly string[]
}

/**
 * The chips after the address, drawn in the pill. When the set changes – the lock arrives or
 * leaves on a navigation, a live state takes the lock's slot and gives it back (§9.29), one
 * state replaces another – the run it showed until this commit is kept as a ghost over the new
 * one, anchored at the run's end like the run itself, and the change cross-fades on opacity
 * over {@link CHIP_FOLD_FADE_MS} in place (v2 §11.4; the same under reduced motion): a chip
 * that keeps its slot does not move or flicker (its ghost copy is hidden), a chip that leaves
 * fades out where it stood, a chip that arrives fades in where it stands – the lock and the
 * media chip swap in the one slot. Never a slide. The carried pill (`interactive` false) draws
 * the run plain: it is a picture of the docked one.
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
  const [ghost, setGhost] = useState<Ghost | null>(null)
  useLayoutEffect(() => {
    const last = shown.current
    shown.current = { key, chips }
    if (interactive && last && last.key !== key) {
      const live = chips.map((c) => c.id)
      setGhost((g) => ({ key: (g?.key ?? 0) + 1, chips: last.chips, live }))
    }
  }, [key, chips, interactive])
  // Keyed on the ghost alone: the pill re-renders freely during the 120 ms (a blocked count
  // ticking up, a store change) without the fade starting over; a further set change makes a
  // new ghost of the run it interrupted.
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
    const live = slotsFromEnd(ghost.live)
    const was = slotsFromEnd(ghost.chips.map((c) => c.id))
    const anims: Animation[] = []
    ghost.chips.forEach((chip, i) => {
      const copy = ghostRef.current?.children[i]
      if (!(copy instanceof HTMLElement)) return
      if (live.get(chip.id) === was.get(chip.id)) copy.style.visibility = 'hidden'
      else anims.push(...[fade(copy, 0)].filter((a): a is Animation => a !== null))
    })
    ghost.live.forEach((id, i) => {
      if (was.get(id) === live.get(id)) return
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
  }, [ghost])
  if (chips.length === 0 && !ghost) return null
  return (
    <span ref={runRef} className="zen-pill-run" data-testid="pill-chips">
      {chips.map((chip) => (
        <span key={chip.id} className="contents" data-chip={chip.id}>
          {chip.render?.(interactive)}
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
              {chip.render?.(false)}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

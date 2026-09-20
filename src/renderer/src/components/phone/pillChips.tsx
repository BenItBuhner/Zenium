/* eslint-disable react-refresh/only-export-components -- the pill's chip kit: the run that draws the chips ships with the chip models it draws and the rows the site-information sheet lists */
import type { JSX, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { AudioLines, Languages, Lock, Shield, ShieldOff } from 'lucide-react'
import { internalPageOf } from '@shared/internalPages'
import type { TranslateTabState } from '@shared/translate'
import type { Tab, UIState } from '@shared/types'
import { isWebPageUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { chipCount, siteBlockingState } from '@renderer/lib/blockingUi'
import { extensionPageChrome } from '@renderer/lib/extensions/pages'
import { mediaSession } from '@renderer/lib/media'
import { openSettings } from '@renderer/lib/pages'
import { foldPillChips, pillChipFold, type PillChipFold } from '@renderer/lib/pillChips'
import { closeSiteInfo, dismissSiteInfo } from '@renderer/lib/siteInfo'
import { barStateOf, isTranslating, pairLabel, translateStateOf } from '@renderer/lib/translate'
import { overlayAvailable } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { PillChip } from '../urlbar/PillChip'

/*
 * The phone pill's trailing chips as data (OMN-02; Bennett's rule of 2026-09-20 over v2 §9.29
 * on the phone, see `lib/pillChips.ts`): what each one is, what it says, what it does, how it
 * draws – built once from the browser state, then drawn by the pill (the lock, a live state
 * chip), by the ghost that cross-fades a change, and listed by the site-information sheet (the
 * shield with its count, the translate offer) as rows with the same names, states and actions
 * the chips had (#115's shield, #106's translate offer re-hosted, not rewritten: their words and
 * their commands are the services' helpers), so nothing is lost, only moved.
 */

/** The chips the phone pill knows after the address, in the pill's order. */
export type PillChipId = 'lock' | 'blocked' | 'translate' | 'media'

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
  /** Its row in the sheet. A chip drawn in the pill has none. */
  row?: PillChipRow
}

/** What the pill's chips need to know of the chrome around them. */
export interface PillChipContext {
  siteInfoOpen: boolean
  mediaSheetOpen: boolean
  /** The tab on screen, for a row that opens something over its picture. */
  activeTabId: string | null
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
  const chips: PillChipModel[] = []

  // The lock: the pill's one site-information glyph after the host – a secure connection, and no
  // lock over a certificate that failed verification (the interstitial, or the page the user
  // proceeded to). It opens the site information, as the favicon ahead of the host does.
  const secure = tab.url.startsWith('https://') && !tab.certificateError && !extension && !page
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
  if (!page && !extension && state.capabilities.requestBlocking) {
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
            ? `${count} ${count === 1 ? 'request' : 'requests'} blocked`
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
  const translation = isWebPageUrl(tab.url) ? translateStateOf(state, tab.id) : null
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

  // Now playing (MW-16, #233): a transient state chip, in the pill while a tab holds the media
  // session – whichever pill is up – and gone otherwise; in the accent while it plays. Opens the
  // in-app player. Whether it folds is the lead's open question (`lib/pillChips.ts`).
  const session = mediaSession(state)
  if (session) {
    const label = session.playing ? 'Now playing' : 'Media paused'
    chips.push({
      id: 'media',
      fold: pillChipFold('media'),
      spoken: '',
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

/** The chips the pill draws after the address, in its order: the lock and the live state chips. */
export function pillChipsDrawn(chips: readonly PillChipModel[]): PillChipModel[] {
  return foldPillChips(chips).shown
}

/** The chips the sheet lists for `tab`, in the pill's order, each with its row. */
export function pillChipRows(
  state: UIState,
  tab: Tab,
  ctx: PillChipContext
): Array<PillChipModel & { row: PillChipRow }> {
  return foldPillChips(phonePillChips(state, tab, ctx)).folded.filter(
    (chip): chip is PillChipModel & { row: PillChipRow } => chip.row !== undefined
  )
}

/** What TalkBack hears of the sheet's chips at the address, in the pill's order (`foldedChipsSpoken`). */
export function pillChipsSpoken(chips: readonly PillChipModel[]): string[] {
  return foldPillChips(chips).folded.map((chip) => chip.spoken)
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
 * The chips after the address, drawn in the pill. When the set changes – a chip arrives or
 * leaves (the lock on a navigation, the media chip with its session) – the run it showed until
 * this commit is kept as a ghost over the new one, anchored at the run's end like the run
 * itself, and the change cross-fades on opacity over {@link CHIP_FOLD_FADE_MS} in place (v2
 * §11.4; the same under reduced motion): a chip that keeps its slot does not move or flicker
 * (its ghost copy is hidden), a chip that leaves fades out where it stood, a chip that arrives
 * fades in where it stands. Never a slide. The carried pill (`interactive` false) draws the run
 * plain: it is a picture of the docked one.
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

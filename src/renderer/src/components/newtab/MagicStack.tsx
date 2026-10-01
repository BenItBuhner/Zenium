import type { JSX, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Bookmark,
  CircleCheck,
  Download,
  EllipsisVertical,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileText,
  FileVideo,
  Globe,
  Group,
  History,
  Image,
  KeyRound,
  Lightbulb,
  ListChecks,
  Package,
  Palette,
  ShieldHalf,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import {
  educationalTipCardButton,
  educationalTipCardDescription,
  educationalTipCardTitle,
  interactEducationalTipCard,
  pickEducationalTipCard,
  sameEducationalTipMemory,
  showEducationalTipCard,
  type EducationalTipCardId,
  type EducationalTipInputs,
  type EducationalTipMemory
} from '@shared/educationalTips'
import {
  activeSafetyHubType,
  dismissSafetyHubCard,
  pickSafetyHubCard,
  safetyHubCardButton,
  safetyHubCardButtonLabel,
  safetyHubCardSummary,
  safetyHubCardTitle,
  sameSafetyHubCardMemories,
  type SafetyHubCardMemories,
  type SafetyHubCardType,
  type SafetyHubInputs,
  type SafetyHubPick
} from '@shared/safetyHubCard'
import type {
  BookmarkNode,
  ClosedEntrySummary,
  DownloadItem,
  MagicStackModuleId,
  PhoneBarPosition,
  Tab,
  UIState
} from '@shared/types'
import { getHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import { fileGlyphFor, type FileGlyph } from '@renderer/lib/downloadsView'
import { useFaviconSrc } from '@renderer/lib/favicons'
import { openOverview } from '@renderer/lib/gestures/stage'
import { requestOverviewGroupsHint } from '@renderer/lib/iph'
import { layoutRectUnder } from '@renderer/lib/layoutRect'
import { collectCells, FlipTracker } from '@renderer/lib/motion/flip'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { MOTION_STATE_MS } from '@renderer/lib/motion/tokens'
import { openCustomize } from '@renderer/lib/newtab'
import { openPage, openSettings } from '@renderer/lib/pages'
import { browserStore, openClearBrowsingData, openOverlay, showLocalMenu } from '@renderer/lib/ui'
import { cn, formatBytes, relativeTime } from '@renderer/lib/utils'
import { RowView, type RowContext } from '../pages/settings/rows'
import { PhoneSheet } from '../phone/PhoneSheet'
import {
  availableModules,
  buildCard,
  magicStackModule,
  pageAt,
  planMagicStack,
  type MagicStackCard,
  type MagicStackSources
} from './magicStackPlan'
import {
  closeMagicStackCustomize,
  magicStackCustomizeStore,
  openMagicStackCustomize
} from './magicStackCustomize'

/**
 * The new tab page's cards (NTP-16; Chrome's Magic Stack, `HomeModulesCoordinator` – the name
 * stays Chrome's, the surface is called Cards to the user): a horizontally paged strip of module
 * cards under the shortcut tiles – the newest recently closed tab, the last download, the newest
 * bookmarks, the Safety check card, the tip card – each on one card chassis with a title row
 * (the module's glyph, its name, the ⋮) and its content. The content rows act (the file opens,
 * the bookmark opens, the closed tab reopens), so a card carries at most one action its rows
 * cannot do: See all on Downloads and Bookmarks, the Safety check card's one button (Review, Go
 * to settings, Change passwords – NTP-19), the tip card's one button (Try it now, Set as
 * default, Show me how – NTP-20), none on Continue where you left off (§9.29). The ⋮ offers Hide This and
 * Customise; the Customise
 * sheet lists the modules with switches. Hidden modules are this device's
 * (`UIState.newTabHiddenModules`, never synced); a stack with no card to show is not drawn at
 * all, as Chrome draws none.
 *
 * Design language v2: the page is a window surface, and each card is a page surface on it
 * (§9.29: the field and the sheets are page surfaces; the cards join them) – `--v2-card` under a
 * `--v2-card-border` hairline at the card radius, no shadow (§3). The ⋮ is the shared 44 icon
 * button (§9.3), the action a hugging secondary button (§9.11's in-row form). The strip snaps a
 * card at a time with the next one peeking; the dots under it are indicators, not controls
 * (§9.3, §9.9: a 24 target is not a control) – the strip pages by swipe, TalkBack walks the
 * cards as list items, and a status line reads the page.
 *
 * Motion (§11.4): a hidden card leaves on a 120 ms fade as the cards after it close the gap on
 * the FLIP tracker's spring – from a card's Hide This, where the card is the one under the
 * finger and nothing pages, and from a switch of the Customise sheet turned off, where the dots
 * follow the strip closing the gap; a card a switch turns on arrives on the fade's mirror and
 * the strip pages to it on the same spring, so the card the sheet brought back is the card in
 * view (§9.29). Under reduced motion the card is cut, the others take their places on the
 * tracker's own 120 ms fade and the paging is a cut (§11.3). The strip comes in on the tiles'
 * fade, after the last tile.
 */
export function MagicStack({
  state,
  tab,
  dock
}: {
  state: UIState
  tab: Tab
  dock: PhoneBarPosition
}): JSX.Element | null {
  const hidden = state.newTabHiddenModules
  const safetyHub = useSafetyHub(state, hidden.includes('safety-hub'))
  const tips = useEducationalTips(state, hidden.includes('tips'), tab.id)
  const sources = useSources(state, safetyHub.source, tips.source)
  // A module hidden from a card's menu is kept as hidden here until the core's list has it, so
  // the card cannot come back between the command and the state; once the list has an id, the
  // id is dropped in the render that sees it (the previous-render pattern, no effect needed).
  const [pendingHidden, setPendingHidden] = useState<MagicStackModuleId[]>([])
  const settled = pendingHidden.filter((id) => hidden.includes(id))
  if (settled.length > 0) setPendingHidden(pendingHidden.filter((id) => !hidden.includes(id)))
  // The card on its way out: hidden already, drawn once more for the fade.
  const [leaving, setLeaving] = useState<MagicStackModuleId | null>(null)
  // The card a switch has just brought back: it arrives on its fade and the strip pages to it.
  const [arriving, setArriving] = useState<MagicStackModuleId | null>(null)
  // The hidden set as of the last render that read it (the previous-render pattern again): what
  // a switch of the Customise sheet did is the difference, and a switch changes one id. An id
  // that has come in for a card that is drawn – and not from the card's own menu, which
  // `pendingHidden` already carries – is a departure like Hide This's; an id gone for a module
  // with something to show is an arrival. A card without content comes and goes in the plan
  // alone, and nothing moves for it; a set that changed by more than one id is no switch's act
  // (a state loaded, a fixture) and cuts.
  const [seenHidden, setSeenHidden] = useState(hidden)
  if (!sameIds(seenHidden, hidden)) {
    setSeenHidden(hidden)
    const came = hidden.filter((id) => !seenHidden.includes(id))
    const went = seenHidden.filter((id) => !hidden.includes(id))
    if (came.length + went.length === 1) {
      const [gone] = came
      if (gone && !pendingHidden.includes(gone) && buildCard(gone, sources) && !reducedMotion())
        setLeaving(gone)
      const [back] = went
      if (back && buildCard(back, sources)) setArriving(back)
    }
  }
  const stripRef = useRef<HTMLUListElement>(null)

  const effectiveHidden = useMemo(() => {
    const all = new Set<MagicStackModuleId>([...hidden, ...pendingHidden])
    if (leaving) all.delete(leaving)
    return [...all]
  }, [hidden, pendingHidden, leaving])

  const cards = useMemo(() => planMagicStack(sources, effectiveHidden), [sources, effectiveHidden])
  const mounted = cards.length > 0

  useStackFlip(stripRef, mounted)
  const pageTo = useStripPager(stripRef, mounted)

  // The fade's end takes the card out (or the arriving one's attribute off); a timer stands in
  // for an `animationend` that never comes (the page not painted, the animation cut by a
  // stylesheet).
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(null), LEAVE_MS + 80)
    return () => window.clearTimeout(timer)
  }, [leaving])
  useEffect(() => {
    if (!arriving) return
    const timer = window.setTimeout(() => setArriving(null), LEAVE_MS + 80)
    return () => window.clearTimeout(timer)
  }, [arriving])

  // The strip pages to the card that has come back, once the commit has laid it out – after the
  // tracker's commit above it in the order, which reads the strip first.
  useLayoutEffect(() => {
    if (!arriving) return
    const strip = stripRef.current
    if (!strip) return
    const index = Array.prototype.indexOf.call(
      strip.children,
      strip.querySelector(`[data-cell="${arriving}"]`)
    )
    if (index >= 0) pageTo(index)
  }, [arriving, pageTo])

  if (cards.length === 0) return null

  const hide = (id: MagicStackModuleId): void => {
    setPendingHidden((p) => (p.includes(id) ? p : [...p, id]))
    if (!reducedMotion()) setLeaving(id)
    run('newtab.setModuleHidden', { id, hidden: true })
  }

  const openMenu = (id: MagicStackModuleId): void => {
    const module = magicStackModule(id)
    void showLocalMenu(
      'newtab',
      [
        { label: 'Hide This', onSelect: () => hide(id) },
        { label: 'Customise', onSelect: openMagicStackCustomize }
      ],
      tab.id,
      { title: module.title }
    )
  }

  return (
    <section
      className={cn('zen-mstack w-full max-w-[520px]', dock === 'bottom' ? 'mb-6' : 'mt-6')}
      aria-label="Cards"
    >
      <ul ref={stripRef} className="zen-mstack-strip" role="list" aria-roledescription="carousel">
        {cards.map((card) => (
          <li
            key={card.id}
            className="zen-mstack-card"
            data-surface="page"
            data-cell={card.id}
            data-leaving={leaving === card.id || undefined}
            data-arriving={arriving === card.id || undefined}
            aria-label={cardLabel(card)}
            onAnimationEnd={(e) => {
              if (e.target !== e.currentTarget) return
              if (leaving === card.id) setLeaving(null)
              if (arriving === card.id) setArriving(null)
            }}
          >
            <CardBody
              card={card}
              tabId={tab.id}
              onMenu={() => openMenu(card.id)}
              onSafetyHubAct={safetyHub.act}
              onTipAct={tips.act}
            />
          </li>
        ))}
      </ul>
      {cards.length > 1 && <PageDots strip={stripRef} cards={cards} />}
    </section>
  )
}

/**
 * The page indicator: a dot per card with the current one at full ink, and a status line
 * ("Page 2 of 3") the reader gets as the strip settles on a page – the dots themselves are
 * hidden from it and take no tap (the strip pages by swipe; a 24 target is not a control, §9.3,
 * §9.9). The dots follow the strip's scroll on their own subscription: a page change re-renders
 * the indicator alone, never the strip – a strip re-rendered as the finger crosses the half-way
 * mark would re-run the FLIP commit under it (a forced layout and a transform write per card, on
 * a snap container mid-swipe).
 */
function PageDots({
  strip,
  cards
}: {
  strip: RefObject<HTMLUListElement | null>
  cards: MagicStackCard[]
}): JSX.Element {
  const [page, setPage] = useState(0)
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const onScroll = (): void => {
      const first = el.firstElementChild as HTMLElement | null
      if (!first) return
      const pitch = first.getBoundingClientRect().width + CARD_GAP
      setPage(pageAt(el.scrollLeft, pitch, el.children.length))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [strip])

  const current = Math.min(page, cards.length - 1)
  return (
    <div className="zen-mstack-dots" role="status">
      <span className="sr-only">{`Page ${current + 1} of ${cards.length}`}</span>
      {cards.map((card, index) => (
        <span
          key={card.id}
          className="zen-mstack-dot"
          data-current={index === current || undefined}
          aria-hidden
        />
      ))}
    </div>
  )
}

/** The gap between two cards (the stylesheet's `.zen-mstack-strip` gap). */
const CARD_GAP = 8
/** The hidden card's fade (§11.4), the stylesheet's `zen-mstack-leave`. */
const LEAVE_MS = MOTION_STATE_MS

const MODULE_GLYPHS: Record<MagicStackModuleId, LucideIcon> = {
  continue: History,
  downloads: Download,
  bookmarks: Bookmark,
  // Lucide's `list-checks`, the Privacy and security hub's Safety check card (`privacyHub.ts`).
  'safety-hub': ListChecks,
  // A tip: Lucide's `lightbulb`, where Chrome's module has no glyph of its own (its cards carry
  // an illustration each, `educational_tip_module_layout.xml:28-36`).
  tips: Lightbulb
}

/**
 * The tip card's glyph per card, standing where Chrome draws a 72 dp illustration
 * (`educational_tip_module_layout.xml:28-36`, `dimens.xml:12-14`; `tab_group_promo_logo`,
 * `quick_delete_promo_logo`, `default_browser_promo_logo`, `ntp_theme_promo_logo`): the theme's
 * palette, the browser role's globe (the Default browser settings row's), the groups' group,
 * Quick Delete's bin (the Delete browsing data row's) – all Lucide, all at the accent (§9.29's
 * tile; §9.17 draws no illustration; the gate decides, `design-gate-requests.md`).
 */
const TIP_GLYPHS: Record<EducationalTipCardId, LucideIcon> = {
  'ntp-theme': Palette,
  'default-browser': Globe,
  'tab-groups': Group,
  'quick-delete': Trash2
}

/**
 * The Safety check card's icon tile per type (`SafetyHubMagicStackMediator.java:158-283`):
 * `ic_check_circle_filled_green_24dp` for the permissions already removed (a done thing, in the
 * success ink), `secured_by_brand_shield_24` for Safe Browsing and `ic_password_manager_key` for
 * the passwords, both at the accent.
 */
const SAFETY_HUB_GLYPHS: Record<SafetyHubCardType, LucideIcon> = {
  'revoked-permissions': CircleCheck,
  'safe-browsing': ShieldHalf,
  passwords: KeyRound
}

/** The desktop row's file-type glyphs (`fileGlyphFor`), as the Downloads sheet draws them. */
const FILE_GLYPHS: Record<FileGlyph, LucideIcon> = {
  text: FileText,
  image: Image,
  archive: FileArchive,
  video: FileVideo,
  audio: FileAudio,
  code: FileCode,
  package: Package,
  file: File
}

function useSources(
  state: UIState,
  safetyHub: MagicStackSources['safetyHub'],
  tips: MagicStackSources['tips']
): MagicStackSources {
  const { recentlyClosed, downloads, bookmarks } = state
  return useMemo(
    () => ({ recentlyClosed, downloads, bookmarks, safetyHub, tips }),
    [recentlyClosed, downloads, bookmarks, safetyHub, tips]
  )
}

/**
 * The Safety check card's impression (NTP-19; Chrome's `showModule()`,
 * `SafetyHubMagicStackMediator.java:65-108`): once per mount of the stack, the machine
 * (`shared/safetyHubCard.ts`) picks the type from the memory as published and the inputs as they
 * stand – on the first render, so the first paint has the card – and the memory it leaves is
 * written back once. The pick names the type for the mount; the persisted record names it too
 * (the winner is the one running type), which is what a stack whose module was hidden at its
 * mount reads after the Cards sheet's switch brings the module back: that switch is an
 * impression of its own, picked and written in an effect. The type ends – the card leaves and its
 * run is dismissed – on the card's own button for Safe Browsing and the passwords, and when Safe
 * Browsing comes back on or the compromised count reaches zero while the card is up (`:136-151`,
 * `dismissSafetyHubModule` / `dismissCompromisedPasswordsModule`); nothing re-picks in the mount
 * after that (`mHasBeenDismissed`). A module hidden on this device is not built at all: no pick,
 * no impression, no write (Chrome never constructs a hidden module).
 */
function useSafetyHub(
  state: UIState,
  hidden: boolean
): {
  source: MagicStackSources['safetyHub']
  act: (type: SafetyHubCardType, tabId: string) => void
} {
  const revoked = state.revokedUnusedPermissions
  const safeBrowsingEnabled = state.settings.privacy.safeBrowsingEnabled
  const compromised = state.passwords.checkupSummary.compromised
  const inputs = useMemo<SafetyHubInputs>(
    () => ({
      revokedOrigins: revoked.map((r) => r.origin),
      safeBrowsingEnabled,
      compromisedPasswords: compromised
    }),
    [revoked, safeBrowsingEnabled, compromised]
  )
  const memories = state.newTabSafetyHubCard
  // The mount's impression, made on the first render (a hidden module makes none).
  const [first] = useState<SafetyHubPick | null>(() =>
    hidden ? null : pickSafetyHubCard(inputs, memories, Date.now())
  )
  const [ended, setEnded] = useState(false)
  // The switch that brought the module back into the stack (the previous-render pattern): a new
  // impression, and a run the button ended is open to the machine again.
  const [seenHidden, setSeenHidden] = useState(hidden)
  const [reshown, setReshown] = useState(0)
  if (seenHidden !== hidden) {
    setSeenHidden(hidden)
    if (!hidden) {
      setReshown((n) => n + 1)
      setEnded(false)
    }
  }
  const written = useRef({ first: false, reshown: 0 })
  useEffect(() => {
    if (written.current.first) return
    written.current.first = true
    if (first && !sameSafetyHubCardMemories(first.memories, memories))
      run('newtab.setSafetyHubCardMemory', { memories: first.memories })
  }, [first, memories])
  useEffect(() => {
    if (reshown === 0 || written.current.reshown === reshown) return
    written.current.reshown = reshown
    const pick = pickSafetyHubCard(inputs, memories, Date.now())
    if (!sameSafetyHubCardMemories(pick.memories, memories))
      run('newtab.setSafetyHubCardMemory', { memories: pick.memories })
  }, [reshown, inputs, memories])

  // The mount's pick names the type; a module shown again reads the record its impression wrote.
  const live = first && reshown === 0 ? first.type : activeSafetyHubType(memories)
  // The run's memory to dismiss from: the record as written back, else the pick's own.
  const dismissFrom = useCallback(
    (t: SafetyHubCardType): SafetyHubCardMemories =>
      memories[t]?.activeSince != null ? memories : (first?.memories ?? memories),
    [memories, first]
  )
  // Safe Browsing back on, the compromised count gone: the run ends where Chrome's observers end
  // it – the card leaves for the rest of the mount (`ended` latches; the render that saw the
  // clearing is replaced by the one with the latch, so the dismissal reads `cleared` from the
  // live type, not from the card's) and the run is dismissed once.
  const cleared =
    live !== null &&
    ((live === 'safe-browsing' && inputs.safeBrowsingEnabled) ||
      (live === 'passwords' && inputs.compromisedPasswords === 0))
  if (cleared && !ended) setEnded(true)
  const type = ended ? null : live
  const dismissed = useRef<SafetyHubCardType | null>(null)
  useEffect(() => {
    if (!cleared || live === null || dismissed.current === live) return
    dismissed.current = live
    run('newtab.setSafetyHubCardMemory', {
      memories: dismissSafetyHubCard(dismissFrom(live), live)
    })
  })

  const act = useCallback(
    (t: SafetyHubCardType, tabId: string): void => {
      switch (t) {
        case 'revoked-permissions':
          // Chrome's Review opens the Safety Hub page and leaves the run to its own course.
          openSettings('privacy', { group: 'safety-check' })
          return
        case 'safe-browsing':
          openSettings('privacy', { group: 'safe-browsing' })
          break
        case 'passwords':
          // The manager's checkup view, the Safety check's own Review (`settingsRows.tsx`).
          void openOverlay('passwords', tabId, null, null, 'checkup')
          break
      }
      setEnded(true)
      dismissed.current = t
      run('newtab.setSafetyHubCardMemory', { memories: dismissSafetyHubCard(dismissFrom(t), t) })
    },
    [dismissFrom]
  )

  const source = useMemo(() => ({ type, inputs }), [type, inputs])
  return { source, act }
}

/**
 * The tip card's impression (NTP-20; Chrome's educational tip module: one ephemeral card of the
 * segmentation platform's ranking at the stack's last position, one per fetch of the stack,
 * `ephemeral_home_module_backend.cc:146-166`): once per mount of the stack the machine
 * (`shared/educationalTips.ts`) picks the card from the memory as published and the signals as
 * they stand – on the first render, so the first paint has the card – and the memory it leaves
 * (the card's impression counted, the three-day and the seven-day rests begun; Chrome's
 * `OnShow`, `default_browser_promo.cc:171-178`) is written back once. The signals are this
 * device's state as the page already has it: the background kind of the page's own settings,
 * the browser role as `DefaultBrowserService` refreshed it on start and on foreground (its host
 * verb is read there, never here – the card adds nothing to the boot path), the folders and the
 * tabs. The pick names the card for the page; the Cards sheet's switch bringing the module back
 * is an impression of its own, picked in the render that sees the switch and written in an
 * effect – and so is another tab's page under the same mounted stack: the chrome draws one new
 * tab page for whichever blank tab is active (`ContentArea.tsx`), so a new tab opened from a new
 * tab page keeps the component and changes its tab, where Chrome builds a Magic Stack per page.
 * The card's button is Chrome's interaction (`OnInteract`, `:180-183`): the card leaves the
 * ranking for good and the memory is written, while the card stays for the rest of the page as
 * Chrome's module stays under the sheet it opened – the next page has the next card. A module
 * hidden on this device is not built at all: no pick, no impression, no write.
 */
function useEducationalTips(
  state: UIState,
  hidden: boolean,
  pageId: string
): {
  source: MagicStackSources['tips']
  act: (card: EducationalTipCardId, tabId: string) => void
} {
  const customizedBackground = state.settings.newTab.background !== 'space'
  const canRequestDefault = state.capabilities.defaultBrowser
  const { isDefault, prompt } = state.defaultBrowser
  const groups = Object.keys(state.folders).length
  const tabs = Object.keys(state.tabs).length
  const inputs = useMemo<EducationalTipInputs>(
    () => ({
      customizedBackground,
      canRequestDefault,
      isDefault,
      defaultBrowserPromptUp: prompt !== null,
      groups,
      tabs
    }),
    [customizedBackground, canRequestDefault, isDefault, prompt, groups, tabs]
  )
  const memory = state.newTabEducationalTips
  // The mount's impression, made on the first render (a hidden module makes none).
  const [first] = useState<TipImpression>(() =>
    hidden ? { card: null, memory } : impress(inputs, memory)
  )
  // The switch that brought the module back into the stack, or another tab's page under the
  // same mounted stack (the previous-render pattern): a new impression, picked in the render
  // that sees the change – and read in that same render, so the stack's own previous-render
  // check finds the card and marks its arrival (§11.4). One impression when both change at once.
  const [seenHidden, setSeenHidden] = useState(hidden)
  const [seenPage, setSeenPage] = useState(pageId)
  const [reshownState, setReshown] = useState<{ n: number } & TipImpression>({
    n: 0,
    card: null,
    memory
  })
  let reshown = reshownState
  const switched = seenHidden !== hidden
  const turned = seenPage !== pageId
  if (switched) setSeenHidden(hidden)
  if (turned) setSeenPage(pageId)
  if ((switched || turned) && !hidden) {
    reshown = { n: reshownState.n + 1, ...impress(inputs, memory) }
    setReshown(reshown)
  }
  const written = useRef({ first: false, reshown: 0 })
  useEffect(() => {
    if (written.current.first) return
    written.current.first = true
    if (!sameEducationalTipMemory(first.memory, memory))
      run('newtab.setEducationalTipMemory', { memory: first.memory })
  }, [first, memory])
  useEffect(() => {
    if (reshown.n === 0 || written.current.reshown === reshown.n) return
    written.current.reshown = reshown.n
    if (!sameEducationalTipMemory(reshown.memory, memory))
      run('newtab.setEducationalTipMemory', { memory: reshown.memory })
  }, [reshown, memory])

  const card = hidden ? null : reshown.n === 0 ? first.card : reshown.card
  // The memory to retire the card from: the record as written back, else the impression's own.
  const interactFrom = useCallback(
    (c: EducationalTipCardId): EducationalTipMemory =>
      memory.cards[c]?.shownAt != null ? memory : reshown.n === 0 ? first.memory : reshown.memory,
    [memory, first, reshown]
  )
  const act = useCallback(
    (c: EducationalTipCardId, tabId: string): void => {
      switch (c) {
        case 'ntp-theme':
          // Chrome opens the page's customisation sheet (`ChromeTabbedActivity.java:3519-3531`):
          // the Customise sheet, where the background lives.
          openCustomize()
          break
        case 'default-browser':
          // Chrome's "Set default" (§9.29's "Set as default" here) asks the system for the
          // browser role (`DefaultBrowserPromoUtils.java`): the host's request, from the page.
          run('defaultBrowser.request', { source: 'newtab' })
          break
        case 'tab-groups':
          // Chrome's "Show me how" opens the Hub's tab switcher with the grouping IPH
          // (`ChromeTabbedActivity.java:3500-3508`): the overview, where a tab dropped on another
          // makes a group – no IPH dialog here, so the button reads "Try it now" (the lead's
          // fold on #695), and the teaching is the overview's hint bubble, shown once as the
          // overview comes to rest on this request (TB-19, `useOverviewGroupsHint`).
          requestOverviewGroupsHint()
          openOverview(state)
          break
        case 'quick-delete':
          // Chrome's "Show me how" highlights the menu's Delete browsing data (`:3511-3516`);
          // the phone's menu has no highlight, so the sheet itself opens.
          void openClearBrowsingData(tabId)
          break
      }
      run('newtab.setEducationalTipMemory', {
        memory: interactEducationalTipCard(interactFrom(c), c)
      })
    },
    [interactFrom, state]
  )

  const source = useMemo(() => ({ card, inputs }), [card, inputs])
  return { source, act }
}

/** One impression of the tip card: the card picked (null for none) and the memory it leaves. */
interface TipImpression {
  card: EducationalTipCardId | null
  memory: EducationalTipMemory
}

function impress(inputs: EducationalTipInputs, memory: EducationalTipMemory): TipImpression {
  const now = Date.now()
  const card = pickEducationalTipCard(inputs, memory, now)
  return { card, memory: card ? showEducationalTipCard(memory, card, now) : memory }
}

/** The same ids in the same order. */
function sameIds(a: readonly MagicStackModuleId[], b: readonly MagicStackModuleId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * The strip's FLIP set (`lib/motion/flip.ts`): every card glides to its new slot on the one
 * spring when a card leaves or arrives. The positions are read against the strip itself, which
 * is what scrolls here; listening for as long as the strip is mounted, as the tile grid does.
 *
 * A commit that changes the set of cards can move the strip's offset with its content: Chromium
 * keeps the snapped card through a layout change, so a card leaving or arriving before it moves
 * the offset by a pitch, and a strip grown shorter has its offset clamped. The cards on screen
 * did not move by any of that, while their content coordinates did – so the tracker's baseline
 * follows the offset (`shift`) before that commit is measured, and the glide is the layout's
 * own: the cards after a departure closing the gap, a card in view standing still. Between
 * commits that keep the cards the offset is the finger's, which content coordinates already
 * leave out; the last offset is read after each commit and on every scroll. The strip's
 * snapping is held off while the glide runs (`holdSnap`), as the pager holds it for its spring.
 */
function useStackFlip(stripRef: RefObject<HTMLElement | null>, mounted: boolean): void {
  // The cards are measured in layout space: the page stands inside the content frame, which
  // recedes 3 % under a sheet (§11.1) – and a switch's act comes from under one, where a painted
  // box against the baseline of a commit taken before the sheet rose would read the recede as
  // every card moving by it (a 6 px lift and a scale about the page's centre, glided).
  const tracker = useMemo(() => new FlipTracker(layoutBox), [])
  const last = useRef({ keys: '', scrollLeft: 0 })
  // The strip whose snapping the glide in flight holds off, until the glide has rested.
  const holding = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const el = stripRef.current
    const cells = collectCells(el)
    if (el) {
      const keys = [...cells.keys()].join(' ')
      // Reading the offset lays the strip out: what the browser did to it for this commit has
      // landed, before the tracker reads the cards against it.
      const scrollLeft = el.scrollLeft
      if (keys !== last.current.keys) tracker.shift(scrollLeft - last.current.scrollLeft)
      last.current = { keys, scrollLeft }
    } else last.current = { keys: '', scrollLeft: 0 }
    tracker.commit(cells, el, true)
    // A glide moves the cards by transform, and a mandatory container snaps to a snap area
    // where it is drawn – Chromium re-snaps the offset to the transformed card on every frame,
    // which holds the card at its snap position through the glide (the motion cancelled, the
    // card cut to the gap's edge and nudged the last of the way). The snap is off for the glide.
    if (el && tracker.gliding) {
      holding.current = el
      holdSnap(el, GLIDE)
    }
  })
  useEffect(() => {
    // The rest is drawn with no glide in flight: the snap comes back a frame after it, the
    // offset then a snap position the container has nothing to correct.
    const off = tracker.onFrame(() => {
      if (tracker.gliding || !holding.current) return
      releaseSnap(holding.current, GLIDE)
      holding.current = null
    })
    return () => {
      off()
      if (holding.current) releaseSnap(holding.current, GLIDE, true)
      holding.current = null
    }
  }, [tracker])
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onScroll = (): void => {
      last.current.scrollLeft = el.scrollLeft
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [stripRef, mounted])
  useEffect(() => {
    tracker.listen()
    return () => tracker.dispose()
  }, [tracker])
}

/** The two holders of a strip's snapping: the tracker's glide and the pager's spring. */
const GLIDE = 'glide'
const PAGER = 'pager'

/**
 * Who holds a strip's snapping off (`scroll-snap-type: none` inline, over the stylesheet's
 * mandatory): the pager while its spring runs the offset, the tracker while a glide moves the
 * cards. Chromium snaps a mandatory container at every programmatic write of its offset and,
 * on every frame, to a snap area a transform has moved – a spring on the offset would run as a
 * stair, and a glide would be cancelled by the offset following the card. The snap returns once
 * no one holds it, a frame after the last release (the rest's write has landed and the offset
 * is a snap position), or at once when a finger takes the strip.
 */
const snapHolds = new WeakMap<HTMLElement, Set<string>>()

function holdSnap(el: HTMLElement, holder: string): void {
  let holds = snapHolds.get(el)
  if (!holds) {
    holds = new Set()
    snapHolds.set(el, holds)
  }
  holds.add(holder)
  el.style.setProperty('scroll-snap-type', 'none')
}

function releaseSnap(el: HTMLElement, holder: string, atOnce = false): void {
  const holds = snapHolds.get(el)
  if (!holds?.delete(holder) || holds.size > 0) return
  if (atOnce) {
    el.style.removeProperty('scroll-snap-type')
    return
  }
  requestAnimationFrame(() => {
    if ((snapHolds.get(el)?.size ?? 0) === 0) el.style.removeProperty('scroll-snap-type')
  })
}

/**
 * A card's layout box: its painted one run back through the content frame's recede
 * (`.zen-content-frame`, `ContentArea`; the page has no frame in a test and is measured as painted).
 */
function layoutBox(el: HTMLElement): DOMRectReadOnly {
  const r = layoutRectUnder(el, el.closest('.zen-content-frame'))
  return new DOMRect(r.x, r.y, r.width, r.height)
}

/**
 * Pages the strip to the card at `index` on the FLIP's spring (`SPRING_SNAPPY`; §11.4's arrival
 * for a card a switch brings back): the offset runs to the card's snap position frame by frame
 * with the strip's snapping off meanwhile – Chromium snaps every programmatic write to a
 * mandatory container at its end, which would turn the spring into a stair – and on again a
 * frame after the rest, where the offset is a snap position and the container has nothing to
 * correct. A finger on the strip takes the motion over: the spring stops where it is and the
 * snap returns at once, so the swipe ends as every swipe does. Under reduced motion the spring
 * jumps (`SpringAnimation.start`): a cut to the card (§11.3).
 */
function useStripPager(
  stripRef: RefObject<HTMLUListElement | null>,
  mounted: boolean
): (index: number) => void {
  // The spring lives with the strip element: made when the strip is mounted, stopped and the
  // snap restored when it goes (a strip drawn again is a new element and gets a new one).
  const springRef = useRef<SpringAnimation | null>(null)
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const spring: SpringAnimation = new SpringAnimation(
      SPRING_SNAPPY,
      (x) => {
        el.scrollLeft = x
      },
      () => {
        el.scrollLeft = spring.destination
        releaseSnap(el, PAGER)
      }
    )
    springRef.current = spring
    const caught = (): void => {
      if (!spring.running) return
      spring.stop()
      releaseSnap(el, PAGER, true)
    }
    const types = ['pointerdown', 'touchstart', 'wheel']
    for (const type of types) el.addEventListener(type, caught, { passive: true })
    return () => {
      for (const type of types) el.removeEventListener(type, caught)
      spring.stop()
      releaseSnap(el, PAGER, true)
      springRef.current = null
    }
  }, [stripRef, mounted])
  return useCallback(
    (index: number) => {
      const el = stripRef.current
      const spring = springRef.current
      const card = el?.children[index] as HTMLElement | undefined
      if (!el || !spring || !card) return
      // The snap position is the card's start less the strip's scroll padding: `index` pitches,
      // the pitch read off the card itself – a lone card grown to the strip's width shrinks over
      // 120 ms as a second arrives, while the arriving card, new, has its width at once. Its
      // layout width, not its client rect: the entrance scales the card from .96 for 120 ms, and
      // a rect read in that window puts the pitch 4 % short (the spring then settles short and
      // the snap's return cuts the rest). The last card's snap position is where the strip
      // stops, the tail of the card before it still showing – its extent bounds the target
      // (a strip not laid out reports no extent and bounds nothing).
      const pitch = (parseFloat(getComputedStyle(card).width) || card.offsetWidth) + CARD_GAP
      const extent = el.scrollWidth - el.clientWidth
      const target = extent > 0 ? Math.min(index * pitch, extent) : index * pitch
      const from = el.scrollLeft
      if (Math.abs(target - from) < 1) return
      holdSnap(el, PAGER)
      spring.start(from, spring.running ? spring.stop().v : 0, target)
    },
    [stripRef]
  )
}

/** What TalkBack reads for the card: the module, then what it holds. */
function cardLabel(card: MagicStackCard): string {
  const title = magicStackModule(card.id).title
  switch (card.id) {
    case 'continue':
      return `${title}: ${closedTitle(card.entry)}`
    case 'downloads':
      return `${title}: ${card.item.finalName || card.item.filename}`
    case 'bookmarks':
      return `${title}: ${card.items.map((b) => b.title || getHost(b.url ?? '')).join(', ')}`
    case 'safety-hub': {
      const summary = safetyHubCardSummary(card.type, card.inputs)
      const text = safetyHubCardTitle(card.type, card.inputs)
      return `${title}: ${summary ? `${text}. ${summary}` : text}`
    }
    case 'tips':
      return `${title}: ${educationalTipCardTitle(card.card)}. ${educationalTipCardDescription(card.card)}`
  }
}

function closedTitle(entry: ClosedEntrySummary): string {
  if (entry.kind === 'window') return `Window with ${entry.tabCount} tabs`
  return entry.title || (entry.url ? getHost(entry.url) : 'Closed tab')
}

function CardBody({
  card,
  tabId,
  onMenu,
  onSafetyHubAct,
  onTipAct
}: {
  card: MagicStackCard
  tabId: string
  onMenu: () => void
  onSafetyHubAct: (type: SafetyHubCardType, tabId: string) => void
  onTipAct: (card: EducationalTipCardId, tabId: string) => void
}): JSX.Element {
  const module = magicStackModule(card.id)
  const Glyph = MODULE_GLYPHS[card.id]
  return (
    <>
      <div className="zen-mstack-head">
        <Glyph className="zen-mstack-glyph" aria-hidden />
        <h3 className="zen-mstack-title">{module.title}</h3>
        <button
          type="button"
          className="zen-v2-icon-button zen-mstack-more"
          aria-label={`More options for ${module.title}`}
          onClick={onMenu}
        >
          <EllipsisVertical />
        </button>
      </div>
      {card.id === 'continue' && <ContinueContent entry={card.entry} />}
      {card.id === 'downloads' && <DownloadContent item={card.item} />}
      {card.id === 'bookmarks' && <BookmarksContent items={card.items} tabId={tabId} />}
      {card.id === 'safety-hub' && <SafetyHubContent type={card.type} inputs={card.inputs} />}
      {card.id === 'tips' && <TipContent card={card.card} />}
      {/*
        One action a card, and only one its rows do not already do (§9.29): the rows open the
        file, the bookmark, the closed tab, so the row at the foot carries the page the card
        stands for – or the Safety check's and the tip's primary – and the Continue card, whose
        row is its whole act, carries none. The foot is pinned: the cards share the tallest one's
        height.
      */}
      {card.id === 'downloads' && (
        <div className="zen-mstack-actions">
          <Action onClick={() => openPage('downloads')}>See all</Action>
        </div>
      )}
      {card.id === 'bookmarks' && (
        <div className="zen-mstack-actions">
          <Action onClick={() => openPage('bookmarks')}>See all</Action>
        </div>
      )}
      {card.id === 'safety-hub' && (
        <div className="zen-mstack-actions">
          {/* Chrome's one `FilledButton` (`safety_hub_magic_stack_view.xml:77-82`): the primary. */}
          <Action
            primary
            label={safetyHubCardButtonLabel(card.type)}
            onClick={() => onSafetyHubAct(card.type, tabId)}
          >
            {safetyHubCardButton(card.type)}
          </Action>
        </div>
      )}
      {card.id === 'tips' && (
        <div className="zen-mstack-actions">
          {/* Chrome's one button (`educational_tip_module_layout.xml:107-117`): the primary. */}
          <Action
            primary
            label={`${educationalTipCardButton(card.card)}: ${educationalTipCardTitle(card.card)}`}
            onClick={() => onTipAct(card.card, tabId)}
          >
            {educationalTipCardButton(card.card)}
          </Action>
        </div>
      )}
    </>
  )
}

function Action({
  children,
  primary,
  label,
  onClick
}: {
  children: ReactNode
  primary?: boolean
  /** The accessible name where it says more than the button (Chrome's content description). */
  label?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-button zen-mstack-action"
      data-primary={primary || undefined}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * One line of content (§9.2's two-line row): a 20 glyph or favicon, the name at 15, the detail
 * at 13 in the deemphasised ink. As a button it opens what it names.
 */
function ContentRow({
  glyph,
  title,
  detail,
  onClick,
  label
}: {
  glyph: ReactNode
  title: string
  detail?: string
  onClick?: () => void
  label?: string
}): JSX.Element {
  const inner = (
    <>
      <span className="zen-mstack-row-glyph" aria-hidden>
        {glyph}
      </span>
      <span className="zen-mstack-row-text">
        <span className="zen-mstack-row-title">{title}</span>
        {detail && <span className="zen-mstack-row-detail">{detail}</span>}
      </span>
    </>
  )
  if (!onClick) return <div className="zen-mstack-row">{inner}</div>
  return (
    <button
      type="button"
      className="zen-v2-row zen-mstack-row"
      aria-label={label}
      onClick={onClick}
    >
      {inner}
    </button>
  )
}

function Favicon({
  favicon,
  url
}: {
  favicon: string | null | undefined
  url: string | null
}): JSX.Element {
  const src = useFaviconSrc(favicon, url)
  if (!src) return <Globe />
  return <img src={src} alt="" className="zen-mstack-favicon" />
}

/**
 * The closed tab's row: the host, then when it was closed ("en.wikipedia.org · 5 min ago") – the
 * Downloads card's register ("2.3 MB · 3 h ago"), one across the cards; a closed window has no
 * host, so its detail is the time alone.
 */
function ContinueContent({ entry }: { entry: ClosedEntrySummary }): JSX.Element {
  const detail = [
    entry.kind === 'tab' && entry.url ? getHost(entry.url) : null,
    relativeTime(entry.closedAt)
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ContentRow
      glyph={<Favicon favicon={entry.favicon} url={entry.url} />}
      title={closedTitle(entry)}
      detail={detail}
      label={`Reopen ${closedTitle(entry)}`}
      onClick={() => run('session.restoreClosed', { id: entry.id })}
    />
  )
}

function DownloadContent({ item }: { item: DownloadItem }): JSX.Element {
  const name = item.finalName || item.filename
  const Glyph = FILE_GLYPHS[fileGlyphFor(name, item.mimeType)]
  const when = item.completedAt ?? item.endedAt
  const detail = [
    formatBytes(item.totalBytes || item.receivedBytes),
    when ? relativeTime(when) : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ContentRow
      glyph={<Glyph />}
      title={name}
      detail={detail}
      label={`Open ${name}`}
      onClick={() => run('download.open', { id: item.id })}
    />
  )
}

function BookmarksContent({ items, tabId }: { items: BookmarkNode[]; tabId: string }): JSX.Element {
  return (
    <div className="zen-mstack-list">
      {items.map((b) => (
        <BookmarkRow key={b.id} node={b} tabId={tabId} />
      ))}
    </div>
  )
}

function BookmarkRow({ node, tabId }: { node: BookmarkNode; tabId: string }): JSX.Element {
  const url = node.url ?? ''
  const title = node.title || getHost(url)
  return (
    <ContentRow
      glyph={<Favicon favicon={node.favicon} url={url} />}
      title={title}
      detail={getHost(url)}
      label={`Open ${title}`}
      onClick={() => run('bookmark.open', { id: node.id, newTab: false, tabId })}
    />
  )
}

/**
 * The Safety check card's content (NTP-19; Chrome's `safety_hub_magic_stack_view.xml:28-70`): the
 * type's glyph in a rounded tile, the title beside it – two lines at most – and the one-line
 * summary under the title where the type has one (Chrome's revoked-permissions card has none,
 * `SafetyHubMagicStackMediator.java:158-183`). The words are Chrome's
 * (`shared/safetyHubCard.ts`); the tile takes the type's ink: the success ink for what is already
 * done (the permissions removed), the accent for what is asked of the user.
 */
function SafetyHubContent({
  type,
  inputs
}: {
  type: SafetyHubCardType
  inputs: SafetyHubInputs
}): JSX.Element {
  const Glyph = SAFETY_HUB_GLYPHS[type]
  const summary = safetyHubCardSummary(type, inputs)
  return (
    <div className="zen-mstack-safety" data-type={type}>
      <span className="zen-mstack-safety-tile" aria-hidden>
        <Glyph />
      </span>
      <span className="zen-mstack-safety-text">
        <span className="zen-mstack-safety-title">{safetyHubCardTitle(type, inputs)}</span>
        {summary && <span className="zen-mstack-safety-summary">{summary}</span>}
      </span>
    </div>
  )
}

/**
 * The tip card's content (NTP-20; Chrome's `educational_tip_module_layout.xml:28-95`): where
 * Chrome draws the card's 72 dp illustration (`dimens.xml:12-14`), the card's glyph in the Safety
 * check card's tile – the same object at the same 56 on the card's `--v2-fill`, at the accent
 * (§9.17 draws no illustration; whether the tips get one is the gate's) – and beside it the
 * title at §9.23's 17/600 on two lines at most (Chrome's never wraps, `:78-86`) over the
 * description at 15 in the deemphasised ink, in full – the card grows with the sentence (the
 * design lead's fold on #695; Chrome clamps at two, `:88-95`, against a text column a 72 dp
 * image leaves wider). The words are Chrome's, spelt as this surface spells
 * (`shared/educationalTips.ts`).
 */
function TipContent({ card }: { card: EducationalTipCardId }): JSX.Element {
  const Glyph = TIP_GLYPHS[card]
  return (
    <div className="zen-mstack-safety zen-mstack-tip" data-card={card}>
      <span className="zen-mstack-safety-tile" aria-hidden>
        <Glyph />
      </span>
      <span className="zen-mstack-safety-text">
        <span className="zen-mstack-safety-title">{educationalTipCardTitle(card)}</span>
        <span className="zen-mstack-safety-summary zen-mstack-tip-summary">
          {educationalTipCardDescription(card)}
        </span>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The Customise sheet: the modules as switch rows.
// ---------------------------------------------------------------------------

/** The Settings rows' context: a switch row never asks the page for a sheet, so nothing to open. */
const NO_SHEETS: RowContext = { open: () => {} }

/**
 * Mounted once at the root, as the page's customise sheet is: while the store says open, the
 * sheet renders in the frame's dialog host (`PhoneSheet` places itself there) over the content
 * frame, which recedes under it.
 */
export function MagicStackCustomizeLayer(): JSX.Element | null {
  const open = magicStackCustomizeStore.use((s) => s.open)
  const state = browserStore.use((s) => s.state)
  if (!open || !state) return null
  return <MagicStackCustomizeSheet state={state} />
}

/**
 * Chrome's "Customise Magic Stack", titled "Cards" here (Chrome's name for the feature stays
 * in Chrome's UI): every module this host has as a switch row (§10.4, the shared `RowView`) under
 * the one section "Show", its description under the name; a switch writes the device's hidden
 * set at once, so the page behind the sheet shows the card come or go as the sheet is used.
 */
function MagicStackCustomizeSheet({ state }: { state: UIState }): JSX.Element {
  const hidden = state.newTabHiddenModules
  const modules = availableModules()
  return (
    <PhoneSheet
      name="newtab-magic-stack-customize"
      title={{ pose: 'header', text: 'Cards' }}
      onClose={closeMagicStackCustomize}
    >
      <div className="zen-ntp-customize flex flex-col pb-1">
        <section className="zen-v2-section flex flex-col">
          <h3 className="zen-v2-heading">Show</h3>
          {modules.map((m) => (
            <RowView
              key={m.id}
              ctx={NO_SHEETS}
              row={{
                id: m.id,
                kind: 'switch',
                label: m.title,
                description: m.description,
                checked: !hidden.includes(m.id),
                onChange: (checked) => run('newtab.setModuleHidden', { id: m.id, hidden: !checked })
              }}
            />
          ))}
          <p className="zen-v2-description px-4 pt-3">
            A card appears only when it has something to show.
          </p>
        </section>
      </div>
    </PhoneSheet>
  )
}

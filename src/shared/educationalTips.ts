/**
 * The tip card of the Magic Stack (NTP-20): Chrome's educational tip module
 * (`chrome/browser/educational_tip/`, 152.0.7977.89) and the ephemeral-card ranking behind it
 * (`components/segmentation_platform/embedder/home_modules/`) as one pure machine over what the UI
 * state already publishes. Chrome shows one tip card at a time, the first eligible card in the
 * registry's priority order – NtpTheme, DefaultBrowser, [HistorySync], TabGroup, [TabGroupSync],
 * QuickDelete (`home_modules_card_registry_android.cc:36-64`) – at the stack's last position
 * (`EphemeralHomeModuleRank::kLast`, `ntp_theme_promo.cc:159`, `default_browser_promo.cc:143`,
 * `tab_group_promo.cc:138`, `quick_delete_promo.cc:156`; one card per position,
 * `ephemeral_home_module_backend.cc:146-166`). Every card is one `ComputeCardResult` rule over
 * its signals; the cadence is shared: any tip at most once in 3 days, each card at most once in 7
 * (`constants.h:119-127`), a card at most 10 impressions in all – 3 for the default browser
 * (`constants.h:128-130`, `default_browser_promo.cc:20`, `IsEnabled` `:151-169`) – and a card whose
 * button was tapped never again (`OnInteract` `:180-183` sets the interacted pref that
 * `ComputeCardResult` `:104-108` reads). All tips share one name ("Chrome tips",
 * `HomeModulesUtils.java:70-86`, `:133-144`) and one settings switch (`:315-322`).
 *
 * The cards kept are the ones whose feature Zenium has: the theme (the page's customise sheet),
 * the default browser (W6-4's reminder, folded in), tab groups (`UIState.folders`) and Quick
 * Delete (the phone's Delete browsing data sheet). Chrome's History sync and Tab group sync promos
 * are Google-account features and are not built; nor is Chrome's signed-in gate on the other
 * three (`*_promo.cc`'s `kIsUserSignedIn`), Zenium having no account to be signed in to, nor the
 * theme card's wait for a theme-tip bottom sheet Zenium does not have
 * (`ntp_theme_promo.cc:153-158`).
 *
 * The memory is this device's (`NewTabDeviceState.educationalTips`; Chrome's per-card impression
 * counter and interacted prefs, `constants.h:52-65`, and the shown-count histograms its rules
 * read): per card its impressions, when it was last shown and whether it was tapped; when any
 * tip was last shown; when browsing data was last deleted here (the Quick Delete card's signal,
 * `quick_delete_promo.cc:145-152`). The renderer runs `pickEducationalTipCard` once per impression
 * of the stack and writes the record back through `newtab.setEducationalTipMemory`. Nothing here
 * reads a clock: `now` is an argument.
 */

const DAY_MS = 24 * 3_600_000

/** The cards, in the registry's priority order (`home_modules_card_registry_android.cc:36-64`). */
export const EDUCATIONAL_TIP_CARD_IDS = [
  'ntp-theme',
  'default-browser',
  'tab-groups',
  'quick-delete'
] as const

export type EducationalTipCardId = (typeof EDUCATIONAL_TIP_CARD_IDS)[number]

export function isEducationalTipCardId(value: unknown): value is EducationalTipCardId {
  return (
    typeof value === 'string' && (EDUCATIONAL_TIP_CARD_IDS as readonly string[]).includes(value)
  )
}

/** Any tip at most once within this long (`constants.h:120-123`, `KDaysToShowEphemeralCardOnce`). */
export const EDUCATIONAL_TIP_ANY_INTERVAL_MS = 3 * DAY_MS
/** Each card at most once within this long (`constants.h:124-127`, `KDaysToShowEachEphemeralCardOnce`). */
export const EDUCATIONAL_TIP_CARD_INTERVAL_MS = 7 * DAY_MS
/** A card's impressions in all (`constants.h:128-130`, `kSingleEphemeralCardMaxImpressions`). */
export const EDUCATIONAL_TIP_MAX_IMPRESSIONS = 10
/** The default-browser card's (`default_browser_promo.cc:20`, `kMaxDefaultBrowserCardImpressions`). */
export const DEFAULT_BROWSER_TIP_MAX_IMPRESSIONS = 3
/** The tab-groups card wants more open tabs than this (`tab_group_promo.cc:20`, `kTabCountLimit`). */
export const TAB_GROUPS_TIP_TAB_COUNT = 10
/** The Quick Delete card rests this long after browsing data was deleted (`quick_delete_promo.cc:60-74`). */
export const QUICK_DELETE_TIP_REST_MS = 30 * DAY_MS

/** One card's record. */
export interface EducationalTipCardMemory {
  /** Impressions in all (Chrome's `*_promo_impression_counter` pref). */
  impressions: number
  /** When the card was last shown; null for never. */
  shownAt: number | null
  /** The button was tapped: the card is retired for good (Chrome's `*_promo_interacted` pref). */
  interacted: boolean
}

/** The tip module's memory on one device. */
export interface EducationalTipMemory {
  cards: Partial<Record<EducationalTipCardId, EducationalTipCardMemory>>
  /** When any tip was last shown; null for never. */
  shownAt: number | null
  /** When browsing data was last deleted on this device; null for never. */
  browsingDataClearedAt: number | null
}

export function emptyEducationalTipCardMemory(): EducationalTipCardMemory {
  return { impressions: 0, shownAt: null, interacted: false }
}

export function emptyEducationalTipMemory(): EducationalTipMemory {
  return { cards: {}, shownAt: null, browsingDataClearedAt: null }
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function sanitizeCardMemory(raw: unknown): EducationalTipCardMemory | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const impressions =
    typeof r.impressions === 'number' && Number.isFinite(r.impressions) && r.impressions > 0
      ? Math.floor(r.impressions)
      : 0
  const shownAt = isTime(r.shownAt) ? r.shownAt : null
  const interacted = r.interacted === true
  if (impressions === 0 && shownAt === null && !interacted) return null
  return { impressions, shownAt, interacted }
}

/** The memory from disk: known cards only, well-formed records, an empty record dropped. */
export function sanitizeEducationalTipMemory(raw: unknown): EducationalTipMemory {
  const memory = emptyEducationalTipMemory()
  if (typeof raw !== 'object' || raw === null) return memory
  const r = raw as Record<string, unknown>
  const cards =
    typeof r.cards === 'object' && r.cards !== null ? (r.cards as Record<string, unknown>) : {}
  for (const id of EDUCATIONAL_TIP_CARD_IDS) {
    const card = sanitizeCardMemory(cards[id])
    if (card) memory.cards[id] = card
  }
  memory.shownAt = isTime(r.shownAt) ? r.shownAt : null
  memory.browsingDataClearedAt = isTime(r.browsingDataClearedAt) ? r.browsingDataClearedAt : null
  return memory
}

function sameCardMemory(
  a: EducationalTipCardMemory | undefined,
  b: EducationalTipCardMemory | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.impressions === b.impressions && a.shownAt === b.shownAt && a.interacted === b.interacted
}

export function sameEducationalTipMemory(
  a: EducationalTipMemory,
  b: EducationalTipMemory
): boolean {
  if (a === b) return true
  if (a.shownAt !== b.shownAt || a.browsingDataClearedAt !== b.browsingDataClearedAt) return false
  return EDUCATIONAL_TIP_CARD_IDS.every((id) => sameCardMemory(a.cards[id], b.cards[id]))
}

// ---------------------------------------------------------------------------
// The signals and the rules
// ---------------------------------------------------------------------------

/**
 * The live signals, from the UI state (Chrome's `EducationalTipCardProviderSignalHandler.java`
 * feeds the same facts to the ranker: `kHasCustomizedNtpBackground`,
 * `kShouldShowNonRoleManagerDefaultBrowserPromo`, `kHasDefaultBrowserPromoShownInOtherSurface`,
 * `kTabGroupExists`, `kNumberOfTabs`).
 */
export interface EducationalTipInputs {
  /** The page's background is not the default (`settings.newTab.background !== 'space'`). */
  customizedBackground: boolean
  /** The host can ask for the browser role at all (`capabilities.defaultBrowser`). */
  canRequestDefault: boolean
  /** The host's answer on the role: known not the default (false), the default (true), not yet asked (null). */
  isDefault: boolean | null
  /** The first-run sheet or its banner is asking already (`UIState.defaultBrowser.prompt`): one ask at a time. */
  defaultBrowserPromptUp: boolean
  /** Tab groups on the profile (`UIState.folders`). */
  groups: number
  /** Open tabs (`UIState.tabs`). */
  tabs: number
}

/**
 * The card's live signals hold – the part of its rule that can change under a card that is up,
 * which takes the card down (the plan re-checks it every render, as Chrome's observers remove
 * the module). The theme card while the background is the default
 * (`ntp_theme_promo.cc:153-154`); the default-browser card while the host can ask, Zenium is
 * known not to be the default and no other surface is asking (`default_browser_promo.cc:137-139`,
 * `DefaultBrowserPromoUtils.java:195-203`); the tab-groups card while there is no group and more
 * than ten tabs (`tab_group_promo.cc:134-135`); the Quick Delete card always – its signal is the
 * memory's, below.
 */
export function educationalTipCardHolds(
  id: EducationalTipCardId,
  inputs: EducationalTipInputs
): boolean {
  switch (id) {
    case 'ntp-theme':
      return !inputs.customizedBackground
    case 'default-browser':
      return (
        inputs.canRequestDefault && inputs.isDefault === false && !inputs.defaultBrowserPromptUp
      )
    case 'tab-groups':
      return inputs.groups === 0 && inputs.tabs > TAB_GROUPS_TIP_TAB_COUNT
    case 'quick-delete':
      return true
  }
}

/**
 * The card's whole rule less the cadence: its live signals, and for the Quick Delete card no
 * browsing data deleted on this device in the past 30 days (`quick_delete_promo.cc:145-152`:
 * never cleared, or never through Quick Delete in 30 days – on the phone the Delete browsing
 * data sheet IS Quick Delete, so one signal stands for both).
 */
export function educationalTipCardWanted(
  id: EducationalTipCardId,
  inputs: EducationalTipInputs,
  memory: EducationalTipMemory,
  now: number
): boolean {
  if (!educationalTipCardHolds(id, inputs)) return false
  if (id === 'quick-delete') {
    const cleared = memory.browsingDataClearedAt
    if (cleared !== null && now - cleared < QUICK_DELETE_TIP_REST_MS) return false
  }
  return true
}

export function educationalTipCardMaxImpressions(id: EducationalTipCardId): number {
  return id === 'default-browser'
    ? DEFAULT_BROWSER_TIP_MAX_IMPRESSIONS
    : EDUCATIONAL_TIP_MAX_IMPRESSIONS
}

/**
 * The card's own cadence allows it: not retired by a tap, under its cap of impressions
 * (`IsEnabled`), and not shown within the past seven days (`*_promo_shown_count < 1` over
 * `KDaysToShowEachEphemeralCardOnce`).
 */
export function educationalTipCardRested(
  id: EducationalTipCardId,
  memory: EducationalTipMemory,
  now: number
): boolean {
  const card = memory.cards[id]
  if (!card) return true
  if (card.interacted) return false
  if (card.impressions >= educationalTipCardMaxImpressions(id)) return false
  return card.shownAt === null || now - card.shownAt >= EDUCATIONAL_TIP_CARD_INTERVAL_MS
}

/** The module's cadence allows a tip: none shown within the past three days (`kEducationalTipShownCount < 1`). */
export function educationalTipsRested(memory: EducationalTipMemory, now: number): boolean {
  return memory.shownAt === null || now - memory.shownAt >= EDUCATIONAL_TIP_ANY_INTERVAL_MS
}

/**
 * The card this impression shows, or null for none: the first card in priority order that is
 * wanted and rested, while the module is rested (`ephemeral_home_module_backend.cc:146-166`:
 * the first card whose result takes the last position).
 */
export function pickEducationalTipCard(
  inputs: EducationalTipInputs,
  memory: EducationalTipMemory,
  now: number
): EducationalTipCardId | null {
  if (!educationalTipsRested(memory, now)) return null
  for (const id of EDUCATIONAL_TIP_CARD_IDS) {
    if (
      educationalTipCardWanted(id, inputs, memory, now) &&
      educationalTipCardRested(id, memory, now)
    )
      return id
  }
  return null
}

// ---------------------------------------------------------------------------
// The transitions
// ---------------------------------------------------------------------------

/** The card was shown at `now` (Chrome's `OnShow`, `default_browser_promo.cc:171-178`, and the shown histograms). */
export function showEducationalTipCard(
  memory: EducationalTipMemory,
  id: EducationalTipCardId,
  now: number
): EducationalTipMemory {
  const card = memory.cards[id] ?? emptyEducationalTipCardMemory()
  return {
    ...memory,
    cards: { ...memory.cards, [id]: { ...card, impressions: card.impressions + 1, shownAt: now } },
    shownAt: now
  }
}

/** The card's button was tapped: retired for good (Chrome's `OnInteract`, `default_browser_promo.cc:180-183`). */
export function interactEducationalTipCard(
  memory: EducationalTipMemory,
  id: EducationalTipCardId
): EducationalTipMemory {
  const card = memory.cards[id] ?? emptyEducationalTipCardMemory()
  if (card.interacted) return memory
  return { ...memory, cards: { ...memory.cards, [id]: { ...card, interacted: true } } }
}

/**
 * Browsing data was deleted on this device at `now` (Chrome's
 * `Privacy.DeleteBrowsingData.Action` count): the Quick Delete card rests for 30 days from here.
 */
export function noteBrowsingDataCleared(
  memory: EducationalTipMemory,
  now: number
): EducationalTipMemory {
  if (memory.browsingDataClearedAt !== null && memory.browsingDataClearedAt >= now) return memory
  return { ...memory, browsingDataClearedAt: now }
}

// ---------------------------------------------------------------------------
// Strings (Chrome's, `components/browser_ui/strings/android/browser_ui_strings.grd`)
// ---------------------------------------------------------------------------

/**
 * The module's name, on the card's title row and the Cards sheet's row
 * (`IDS_EDUCATIONAL_TIP_MODULE_NAME` :1210-1212, "Chrome tips", with the product's name).
 */
export const EDUCATIONAL_TIP_MODULE_NAME = 'Zenium tips'

/**
 * The card's title, Chrome's words with the product's name and its British spelling (design
 * language v2 – "Chrome's 'Customize' is Chrome's"): `IDS_EDUCATIONAL_TIP_NTP_THEME_TITLE`
 * :1246-1248, `IDS_USE_CHROME_BY_DEFAULT` :1225-1227, `IDS_EDUCATIONAL_TIP_TAB_GROUP_TITLE`
 * :1234-1236, `IDS_EDUCATIONAL_TIP_QUICK_DELETE_TITLE` :1255-1257.
 */
export function educationalTipCardTitle(id: EducationalTipCardId): string {
  switch (id) {
    case 'ntp-theme':
      return 'Customise your homepage'
    case 'default-browser':
      return 'Use Zenium by default'
    case 'tab-groups':
      return 'Tidy up with tab groups'
    case 'quick-delete':
      return 'Manage your browsing data'
  }
}

/**
 * The card's description: `IDS_EDUCATIONAL_TIP_NTP_THEME_DESCRIPTION` :1249-1251,
 * `IDS_EDUCATIONAL_TIP_DEFAULT_BROWSER_DESCRIPTION` :1228-1230,
 * `IDS_EDUCATIONAL_TIP_TAB_GROUP_DESCRIPTION` :1237-1239,
 * `IDS_EDUCATIONAL_TIP_QUICK_DELETE_DESCRIPTION` :1258-1260.
 */
export function educationalTipCardDescription(id: EducationalTipCardId): string {
  switch (id) {
    case 'ntp-theme':
      return 'Make Zenium your own with custom colours and images for your homepage'
    case 'default-browser':
      return 'You can use Zenium any time you tap links in messages, documents and other apps'
    case 'tab-groups':
      return 'Create tab groups that automatically save and update across all your devices'
    case 'quick-delete':
      return 'You can delete some or all of your history, cookies, site data and more'
  }
}

/**
 * The button: the theme card's `IDS_EDUCATIONAL_TIP_NTP_THEME_PROMO_BUTTON` :1252-1254; the
 * default-browser card's `IDS_SETUP_LIST_DEFAULT_BROWSER_PROMO_BUTTON` :1231-1233, since the
 * button here opens the system's role sheet at once where Chrome's "Show me how" opens a how-to
 * sheet first; the other two `IDS_EDUCATIONAL_TIP_MODULE_BUTTON` :1216-1218.
 */
export function educationalTipCardButton(id: EducationalTipCardId): string {
  switch (id) {
    case 'ntp-theme':
      return 'Try it now'
    case 'default-browser':
      return 'Set default'
    case 'tab-groups':
    case 'quick-delete':
      return 'Show me how'
  }
}

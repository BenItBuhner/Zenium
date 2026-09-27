/**
 * The Safety Hub card of the Magic Stack (NTP-19): Chrome's `SafetyHubMenuNotificationService`
 * and `SafetyHubMenuNotification` (`chrome/browser/ui/safety_hub/menu_notification_service.cc`,
 * `menu_notification.cc`, 152.0.7977.89) as one pure state machine over what the UI state
 * already publishes. Chrome drives the card and the ⋮ menu's Safety Hub line from the same
 * service: one module at a time by priority – passwords HIGH, Safe Browsing MEDIUM, revoked
 * permissions LOW (`menu_notification_service.cc:85-145`) – shown until it has been seen enough
 * (three days and five impressions, `menu_notification.h:20-21`), then dismissed; a dismissed
 * module returns once its interval has passed (none / 90 days / 10 days, `:36-48`) AND its result
 * has changed in a way that warrants a new run (a new revoked origin, a grown count; Safe Browsing
 * always). Safe Browsing waits a day after the switch went off and shows at most three times per
 * off period (`:183-186`, `:262-264`, `:282-288`).
 *
 * The memory is this device's (`NewTabDeviceState.safetyHubCard`, Chrome's
 * `safety_hub.menu_notifications` pref), one record per type; the renderer runs `pickSafetyHubCard`
 * once per impression of the stack and writes the record back through `newtab.setSafetyHubCardMemory`.
 * Nothing here reads a clock: `now` is an argument.
 * Decision: `due` is persisted with the record where Chrome's `should_be_shown_after_interval_` is
 * memory-only (`menu_notification.h:102`; absent from `ToDictValue`, `menu_notification.cc:34-79`):
 * a warranted run survives a relaunch here instead of dying with the process – stricter on restart.
 */

const DAY_MS = 24 * 3_600_000

/**
 * Chrome's four `MagicStackEntry.ModuleType`s (`MagicStackEntry.java:21-32`) less notification
 * permissions, for which Zenium has no live source; in priority order, highest first.
 */
export const SAFETY_HUB_CARD_TYPES = ['passwords', 'safe-browsing', 'revoked-permissions'] as const

export type SafetyHubCardType = (typeof SAFETY_HUB_CARD_TYPES)[number]

export function isSafetyHubCardType(value: unknown): value is SafetyHubCardType {
  return typeof value === 'string' && (SAFETY_HUB_CARD_TYPES as readonly string[]).includes(value)
}

/** `MenuNotificationPriority` (`menu_notification_service.h:35-39`): LOW 0, MEDIUM 1, HIGH 2. */
export const SAFETY_HUB_PRIORITY: Record<SafetyHubCardType, number> = {
  passwords: 2,
  'safe-browsing': 1,
  'revoked-permissions': 0
}

/** How long a dismissed type stays away (`menu_notification_service.cc:36`, `:48`, `:40`). */
export const SAFETY_HUB_INTERVAL_MS: Record<SafetyHubCardType, number> = {
  passwords: 0,
  'safe-browsing': 90 * DAY_MS,
  'revoked-permissions': 10 * DAY_MS
}

/** All-time cap on a type's runs; 0 is none (`menu_notification_service.cc:183-186`). */
export const SAFETY_HUB_MAX_RUNS: Record<SafetyHubCardType, number> = {
  passwords: 0,
  'safe-browsing': 3,
  'revoked-permissions': 0
}

/** A run has been seen enough after this long AND this many impressions (`menu_notification.h:20-21`). */
export const SAFETY_HUB_MIN_RUN_MS = 3 * DAY_MS
export const SAFETY_HUB_MIN_IMPRESSIONS = 5

/** Safe Browsing is not raised in the day after its switch moved (`menu_notification_service.cc:262-264`, `:282-288`). */
export const SAFETY_HUB_SAFE_BROWSING_DELAY_MS = DAY_MS

/** The slices of `UIState` the card reads. */
export interface SafetyHubInputs {
  /** `UIState.revokedUnusedPermissions[].origin` (PS-41's records). */
  revokedOrigins: readonly string[]
  /** `UIState.settings.privacy.safeBrowsingEnabled`. */
  safeBrowsingEnabled: boolean
  /** `UIState.passwords.checkupSummary.compromised` (Chrome's `kBreachedCredentialsCount`). */
  compromisedPasswords: number
}

/**
 * One type's memory: Chrome's `SafetyHubMenuNotification` as it is persisted
 * (`menu_notification.cc:40-82`). `activeSince` stands for `is_currently_active_` and
 * `first_impression_time_` together (set on the first impression of a run, cleared on the
 * dismissal, `:84-99`); `result` is the last result the machine saw, what a new one is compared
 * with (`:178-195`).
 */
export interface SafetyHubCardMemory {
  activeSince: number | null
  impressions: number
  lastShownAt: number | null
  /** All-time runs (`all_time_notification_count_`). */
  runs: number
  showAfter: number | null
  /** `should_be_shown_after_interval_`: a result since the last run warrants another. */
  due: boolean
  result: string | null
}

export type SafetyHubCardMemories = Partial<Record<SafetyHubCardType, SafetyHubCardMemory>>

export function emptySafetyHubCardMemory(): SafetyHubCardMemory {
  return {
    activeSince: null,
    impressions: 0,
    lastShownAt: null,
    runs: 0,
    showAfter: null,
    due: false,
    result: null
  }
}

/** Most characters a stored result keeps: a list of origins, bounded. */
const MAX_RESULT_LENGTH = 8_192

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** A record from disk: each field its own kind or the empty record's; unknown types dropped. */
export function sanitizeSafetyHubCardMemories(raw: unknown): SafetyHubCardMemories {
  if (!raw || typeof raw !== 'object') return {}
  const out: SafetyHubCardMemories = {}
  for (const [type, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafetyHubCardType(type) || !value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const memory: SafetyHubCardMemory = {
      activeSince: time(v.activeSince),
      impressions: count(v.impressions),
      lastShownAt: time(v.lastShownAt),
      runs: count(v.runs),
      showAfter: time(v.showAfter),
      due: v.due === true,
      result: typeof v.result === 'string' ? v.result.slice(0, MAX_RESULT_LENGTH) : null
    }
    // A run needs its first impression to have been an impression.
    if (memory.activeSince !== null && memory.lastShownAt === null)
      memory.lastShownAt = memory.activeSince
    out[type] = memory
  }
  return out
}

export function sameSafetyHubCardMemories(
  a: SafetyHubCardMemories,
  b: SafetyHubCardMemories
): boolean {
  for (const type of SAFETY_HUB_CARD_TYPES) {
    const x = a[type]
    const y = b[type]
    if (x === y) continue
    if (!x || !y) return false
    if (
      x.activeSince !== y.activeSince ||
      x.impressions !== y.impressions ||
      x.lastShownAt !== y.lastShownAt ||
      x.runs !== y.runs ||
      x.showAfter !== y.showAfter ||
      x.due !== y.due ||
      x.result !== y.result
    )
      return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Results: Chrome's `SafetyHubResult` per type – the trigger and what warrants a new run
// ---------------------------------------------------------------------------

/** The origins a stored revoked-permissions result names (sorted, one per line). */
function origins(result: string | null): Set<string> {
  return new Set(result ? result.split('\n').filter(Boolean) : [])
}

/** A type's result as the memory stores it: the origins, the switch, the count. */
export function safetyHubResult(type: SafetyHubCardType, inputs: SafetyHubInputs): string {
  switch (type) {
    case 'revoked-permissions':
      return [...new Set(inputs.revokedOrigins)].sort().join('\n')
    case 'safe-browsing':
      return inputs.safeBrowsingEnabled ? 'on' : 'off'
    case 'passwords':
      return String(Math.max(0, Math.floor(inputs.compromisedPasswords)))
  }
}

/**
 * Whether the result raises the type at all (`IsTriggerForMenuNotification`): revoked origins
 * (`revoked_permissions_result.cc:57-61`), the switch off (`safe_browsing_result.cc:123-125`,
 * "disabled by user" – Zenium's switch has no other author), a compromised login
 * (`password_status_check_result_android.cc`).
 */
export function safetyHubTriggers(type: SafetyHubCardType, inputs: SafetyHubInputs): boolean {
  switch (type) {
    case 'revoked-permissions':
      return inputs.revokedOrigins.length > 0
    case 'safe-browsing':
      return !inputs.safeBrowsingEnabled
    case 'passwords':
      return inputs.compromisedPasswords > 0
  }
}

/**
 * Whether `next` warrants a run after `previous` (`WarrantsNewMenuNotification`): an origin the
 * previous list did not hold (`revoked_permissions_result.cc:63-93`), Safe Browsing always
 * (`safe_browsing_result.cc:127-130`), a count that grew (`password_status_check_result_android.cc`).
 */
export function safetyHubWarrants(
  type: SafetyHubCardType,
  previous: string,
  next: string
): boolean {
  switch (type) {
    case 'revoked-permissions': {
      const before = origins(previous)
      for (const origin of origins(next)) if (!before.has(origin)) return true
      return false
    }
    case 'safe-browsing':
      return true
    case 'passwords':
      return Number(next) > Number(previous)
  }
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/** `IsShownEnough` (`menu_notification.cc:148-163`). */
function shownEnough(memory: SafetyHubCardMemory, now: number): boolean {
  if (memory.activeSince === null || memory.lastShownAt === null) return false
  return (
    now - memory.activeSince >= SAFETY_HUB_MIN_RUN_MS &&
    memory.impressions >= SAFETY_HUB_MIN_IMPRESSIONS
  )
}

/** `HasIntervalPassed` (`menu_notification.cc:165-172`). */
function intervalPassed(memory: SafetyHubCardMemory, interval: number, now: number): boolean {
  if (memory.lastShownAt === null) return true
  return now - memory.lastShownAt >= interval
}

/** `ShouldBeShown` (`menu_notification.cc:105-142`). */
export function safetyHubShouldShow(
  type: SafetyHubCardType,
  inputs: SafetyHubInputs,
  memory: SafetyHubCardMemory,
  now: number
): boolean {
  const max = SAFETY_HUB_MAX_RUNS[type]
  if (max > 0 && memory.runs >= max) return false
  if (!safetyHubTriggers(type, inputs)) return false
  if (memory.showAfter !== null && now < memory.showAfter) return false
  if (memory.lastShownAt === null) return true
  if (memory.activeSince !== null) return !shownEnough(memory, now)
  return memory.due && intervalPassed(memory, SAFETY_HUB_INTERVAL_MS[type], now)
}

/** `Show` (`menu_notification.cc:84-92`). */
function show(memory: SafetyHubCardMemory, now: number): SafetyHubCardMemory {
  return {
    ...memory,
    impressions: memory.impressions + 1,
    activeSince: memory.activeSince ?? now,
    due: memory.activeSince === null ? false : memory.due,
    lastShownAt: now
  }
}

/** `Dismiss` (`menu_notification.cc:94-99`). */
function dismiss(memory: SafetyHubCardMemory): SafetyHubCardMemory {
  return { ...memory, activeSince: null, impressions: 0, runs: memory.runs + 1 }
}

/**
 * `UpdateResult` (`menu_notification.cc:178-195`) with the service's Safe Browsing hooks: a type
 * with no record yet starts one (Safe Browsing's with its day's delay,
 * `menu_notification_service.cc:262-264`); a Safe Browsing switch that moved since the last look
 * re-arms the delay and the cap (`:282-288`; Chrome does this as the pref changes, Zenium at the
 * first look after – the day runs from the first Cards render after the switch, not the switch);
 * an inactive type whose result warrants a run is due for one after its interval.
 */
function updated(
  type: SafetyHubCardType,
  inputs: SafetyHubInputs,
  memory: SafetyHubCardMemory | undefined,
  now: number
): SafetyHubCardMemory {
  const result = safetyHubResult(type, inputs)
  let next: SafetyHubCardMemory = memory
    ? { ...memory }
    : {
        ...emptySafetyHubCardMemory(),
        showAfter: type === 'safe-browsing' ? now + SAFETY_HUB_SAFE_BROWSING_DELAY_MS : null
      }
  if (type === 'safe-browsing' && memory && memory.result !== null && memory.result !== result)
    next = { ...next, showAfter: now + SAFETY_HUB_SAFE_BROWSING_DELAY_MS, runs: 0 }
  if (
    next.activeSince === null &&
    next.result !== null &&
    safetyHubWarrants(type, next.result, result)
  )
    next.due = true
  next.result = result
  return next
}

export interface SafetyHubPick {
  /** The type the card shows this impression, or null for no card. */
  type: SafetyHubCardType | null
  /** The memories after this impression: written back when they differ from what was read. */
  memories: SafetyHubCardMemories
}

/**
 * `GetNotificationToShow` (`menu_notification_service.cc:168-223`), one impression of the stack:
 * every type's result is brought up to date, the types that should show are ranked by priority
 * with a running one ahead of a new one at the same priority, every other running type is
 * dismissed, and the winner takes the impression.
 */
export function pickSafetyHubCard(
  inputs: SafetyHubInputs,
  memories: SafetyHubCardMemories,
  now: number
): SafetyHubPick {
  const next: SafetyHubCardMemories = {}
  for (const type of SAFETY_HUB_CARD_TYPES) next[type] = updated(type, inputs, memories[type], now)
  const candidates = SAFETY_HUB_CARD_TYPES.filter((type) =>
    safetyHubShouldShow(type, inputs, next[type] as SafetyHubCardMemory, now)
  ).sort((a, b) => {
    const priority = SAFETY_HUB_PRIORITY[b] - SAFETY_HUB_PRIORITY[a]
    if (priority !== 0) return priority
    const active = (type: SafetyHubCardType): number =>
      (next[type] as SafetyHubCardMemory).activeSince !== null ? 1 : 0
    return active(b) - active(a)
  })
  const winner = candidates[0] ?? null
  for (const type of SAFETY_HUB_CARD_TYPES) {
    const memory = next[type] as SafetyHubCardMemory
    if (type === winner) next[type] = show(memory, now)
    else if (memory.activeSince !== null) next[type] = dismiss(memory)
  }
  return { type: winner, memories: next }
}

/**
 * The type whose run is on – what the card shows – or null. `pickSafetyHubCard` dismisses every
 * running type but its winner, so at most one is on; a record that names more (a hand-edited
 * file) reads by priority.
 */
export function activeSafetyHubType(memories: SafetyHubCardMemories): SafetyHubCardType | null {
  for (const type of SAFETY_HUB_CARD_TYPES) if (memories[type]?.activeSince != null) return type
  return null
}

/**
 * `DismissActiveNotificationOfModule` (`magic_stack_bridge.cc:69-86`): the type's run ends now –
 * the button of the Safe Browsing and passwords cards, Safe Browsing switched back on or the
 * compromised count gone while the card is up (`SafetyHubMagicStackMediator.java:136-151`).
 * A type with no run returns the memories it was given.
 */
export function dismissSafetyHubCard(
  memories: SafetyHubCardMemories,
  type: SafetyHubCardType
): SafetyHubCardMemories {
  const memory = memories[type]
  if (!memory || memory.activeSince === null) return memories
  return { ...memories, [type]: dismiss(memory) }
}

// ---------------------------------------------------------------------------
// The words (browser_ui_strings.grd, settings_strings.grdp at 152.0.7977.89)
// ---------------------------------------------------------------------------

/** `IDS_SAFETY_HUB_MAGIC_STACK_MODULE_NAME` (`browser_ui_strings.grd:1406-1408`), in sentence case (§9.1). */
export const SAFETY_HUB_CARD_NAME = 'Safety check'

/**
 * The card's title: the revoked-permissions label
 * (`settings_strings.grdp:4450-4454`), `IDS_SAFETY_HUB_MAGIC_STACK_SAFE_BROWSING_TITLE`
 * (`browser_ui_strings.grd:1421-1423`), `IDS_SAFETY_HUB_MAGIC_STACK_COMPROMISED_PASSWORDS_TITLE`
 * (`:1427-1429`).
 */
export function safetyHubCardTitle(type: SafetyHubCardType, inputs: SafetyHubInputs): string {
  switch (type) {
    case 'revoked-permissions': {
      const n = new Set(inputs.revokedOrigins).size
      return n === 1 ? 'Removed permissions for 1 site' : `Removed permissions for ${n} sites`
    }
    case 'safe-browsing':
      return 'Turn on Safe Browsing'
    case 'passwords':
      return 'Change passwords'
  }
}

/**
 * The line under the title, or none: Chrome's revoked-permissions card has no summary
 * (`SafetyHubMagicStackMediator.java:158-183`); `IDS_SETTINGS_SAFETY_HUB_SAFE_BROWSING_MENU_NOTIFICATION`
 * (`settings_strings.grdp:4470-4472`); `IDS_SETTINGS_SAFETY_HUB_COMPROMISED_PASSWORDS_MENU_NOTIFICATION`
 * (`:4460-4464`).
 */
export function safetyHubCardSummary(
  type: SafetyHubCardType,
  inputs: SafetyHubInputs
): string | null {
  switch (type) {
    case 'revoked-permissions':
      return null
    case 'safe-browsing':
      return 'Safe Browsing is off'
    case 'passwords': {
      const n = Math.max(0, Math.floor(inputs.compromisedPasswords))
      return n === 1 ? 'Found 1 compromised password' : `Found ${n} compromised passwords`
    }
  }
}

/**
 * The button: `IDS_SAFETY_HUB_MAGIC_STACK_SAFE_STATE_BUTTON_TEXT` "Review"
 * (`browser_ui_strings.grd:1415-1417`), `..._SAFE_BROWSING_BUTTON_TEXT` "Go to settings"
 * (`:1424-1426`), the passwords title again (`SafetyHubMagicStackMediator.java:247-283`).
 */
export function safetyHubCardButton(type: SafetyHubCardType): string {
  switch (type) {
    case 'revoked-permissions':
      return 'Review'
    case 'safe-browsing':
      return 'Go to settings'
    case 'passwords':
      return 'Change passwords'
  }
}

/** The button's accessible name: "Review Safety Check" (`browser_ui_strings.grd:1418-1420`) for the plain Review. */
export function safetyHubCardButtonLabel(type: SafetyHubCardType): string {
  return type === 'revoked-permissions' ? 'Review Safety check' : safetyHubCardButton(type)
}

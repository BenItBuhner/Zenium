import type { DefaultBrowserPromoState, DefaultBrowserPrompt } from './types'

/**
 * When to ask the user to make Zenium the default browser. Pure rules over the persisted
 * `DefaultBrowserPromoState`; the core applies them at every session start and foreground
 * return, the chrome only shows what `decidePrompt` says.
 *
 * A session is one app start after onboarding. The sheet ("Make Zenium your default browser")
 * comes up in the third session and, when answered with "Not now", again after seven more, at
 * most three times; choosing "Set as default" from any prompt ends the campaign for good. In
 * the sessions between sheets a lighter banner reminds the user, no more than every other
 * session. Everything stops the moment the browser role is held.
 */

/** The sheet first shows in this session. */
export const PROMO_FIRST_SESSION = 3
/** …and again this many sessions after the last time it was dismissed. */
export const PROMO_REPEAT_SESSIONS = 7
/** After this many "Not now" answers the sheet never comes back. */
export const PROMO_MAX_DISMISSALS = 3
/** The banner waits at least this many sessions between appearances. */
export const BANNER_GAP_SESSIONS = 2

export const DEFAULT_PROMO_STATE: DefaultBrowserPromoState = {
  sessions: 0,
  promptedAt: null,
  dismissals: 0,
  done: false,
  bannerAt: null
}

/** Persisted state from disk can be anything: coerce it into a valid record. */
export function sanitizePromoState(raw: unknown): DefaultBrowserPromoState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  const session = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
  return {
    sessions: count(r.sessions),
    promptedAt: session(r.promptedAt),
    dismissals: count(r.dismissals),
    done: r.done === true,
    bannerAt: session(r.bannerAt)
  }
}

/** A new session started: count it. */
export function beginSession(state: DefaultBrowserPromoState): DefaultBrowserPromoState {
  return { ...state, sessions: state.sessions + 1 }
}

/** The campaign is over: the user chose "Set as default", or gave up on us often enough. */
export function promoFinished(state: DefaultBrowserPromoState): boolean {
  return state.done || state.dismissals >= PROMO_MAX_DISMISSALS
}

/** Whether the sheet is due in the current session. */
export function sheetDue(state: DefaultBrowserPromoState): boolean {
  if (promoFinished(state)) return false
  if (state.sessions < PROMO_FIRST_SESSION) return false
  if (state.promptedAt === null) return true
  if (state.promptedAt === state.sessions) return false
  return state.sessions - state.promptedAt >= PROMO_REPEAT_SESSIONS
}

/**
 * Whether the banner is due: only once the sheet has had its say (it never pre-empts the first
 * sheet), never in a session the sheet took, and with a gap between appearances.
 */
export function bannerDue(state: DefaultBrowserPromoState): boolean {
  if (promoFinished(state)) return false
  if (state.promptedAt === null || state.promptedAt === state.sessions) return false
  if (state.bannerAt !== null && state.sessions - state.bannerAt < BANNER_GAP_SESSIONS) return false
  return true
}

/**
 * What to show now. `isDefault` is the host's live answer: while the role is held (or the host
 * has not answered yet) nothing is shown.
 */
export function decidePrompt(
  state: DefaultBrowserPromoState,
  isDefault: boolean | null
): DefaultBrowserPrompt {
  if (isDefault !== false) return null
  if (sheetDue(state)) return 'sheet'
  if (bannerDue(state)) return 'banner'
  return null
}

/** The sheet came up in this session: remember it so it does not come back tomorrow. */
export function markSheetShown(state: DefaultBrowserPromoState): DefaultBrowserPromoState {
  return { ...state, promptedAt: state.sessions }
}

/** The banner came up in this session. */
export function markBannerShown(state: DefaultBrowserPromoState): DefaultBrowserPromoState {
  return { ...state, bannerAt: state.sessions }
}

/** "Not now" on the sheet counts towards giving up; closing the banner only ends its turn. */
export function dismissPrompt(
  state: DefaultBrowserPromoState,
  prompt: 'sheet' | 'banner'
): DefaultBrowserPromoState {
  if (prompt === 'sheet') {
    return { ...state, promptedAt: state.sessions, dismissals: state.dismissals + 1 }
  }
  return { ...state, bannerAt: state.sessions }
}

/** "Set as default" was chosen: the user has heard us, never ask again. */
export function markRequested(state: DefaultBrowserPromoState): DefaultBrowserPromoState {
  return { ...state, done: true }
}

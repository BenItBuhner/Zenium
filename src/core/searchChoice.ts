/**
 * The EEA's search-engine choice screen (W6-2; DMA Art. 6(3) – Chrome's
 * `chrome://search-engine-choice` is the reference): a device in the European Economic Area is
 * asked, once, which engine the address bar searches with, from a list in a random order with
 * nothing picked in advance. The model is the core's and the phone's alike – the gate, the
 * eligible list and its shuffle, the record – and knows nothing of a screen; the desktop draws
 * the screen in its onboarding chassis, the phone draws nothing until it has a screen of its own.
 *
 * The gate is read by the chrome at its first render from the state (`UIState.searchChoice`),
 * not run as a startup hook: the core's boot sequence is untouched.
 */
import type { SearchChoiceRecord, SearchChoiceState, SearchEngine } from '../shared/types'
import {
  EEA_SEARCH_CHOICE,
  SEARCH_CHOICE_ALIASES,
  searchChoiceCountry,
  searchChoiceEngine,
  searchChoiceEngineIds,
  searchChoiceTagline
} from '../shared/search'

/**
 * Where the screen is owed: the European Economic Area as Chrome's choice screen has it
 * (`components/regional_capabilities/eea_countries_ids.h` `kEeaChoiceCountriesIds`) – the EU's
 * twenty-seven, the three EFTA states in the Area (Iceland, Liechtenstein, Norway) and the
 * seventeen territories with codes of their own that take a member state's list (Åland, the
 * French overseas departments and collectivities, Ceuta, Melilla and the Canaries, Svalbard,
 * the Vatican; `SEARCH_CHOICE_ALIASES`). ISO 3166-1 alpha-2, as `app.getLocaleCountryCode()`
 * reports the OS region.
 */
export const EEA_REGIONS: ReadonlySet<string> = new Set([
  ...Object.keys(EEA_SEARCH_CHOICE),
  ...Object.keys(SEARCH_CHOICE_ALIASES)
])

/**
 * The eligible lists' revision, written into each record: 2 since the lists became Chrome's
 * per-country tables (a version-1 record – the first list – stands; the screen is not owed
 * again for a new list).
 */
export const SEARCH_CHOICE_VERSION = 2

/** A region as a two-letter upper-case code, or null for anything else (`''`, junk, absent). */
export function normalizeRegion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(code) ? code : null
}

/**
 * The region the screen is gated on: the drive's or a tester's override (`--zen-region=DE`,
 * `ZEN_REGION=DE`) over the OS's answer; null when neither names a region (the OS may not know
 * – Electron reports `''` then – and an unknown region is not the EEA).
 */
export function resolveSearchChoiceRegion(
  override: string | null | undefined,
  os: string | null | undefined
): string | null {
  return normalizeRegion(override) ?? normalizeRegion(os)
}

export function isEeaRegion(region: string | null | undefined): boolean {
  return region !== null && region !== undefined && EEA_REGIONS.has(region)
}

/** What the gate reads. */
export interface SearchChoiceTerms {
  region: string | null
  record: SearchChoiceRecord | null
  /** "Skip for now" was pressed this run: the screen waits for the next run. */
  skipped?: boolean
  /** Settings › Search › "Choose your search engine again" asked for the screen. */
  askAgain?: boolean
}

/**
 * Whether the screen is owed: asked for again from Settings, whatever the region; else in the
 * EEA with no record on this device and not skipped this run. Outside the EEA, never.
 */
export function searchChoiceRequired(terms: SearchChoiceTerms): boolean {
  if (terms.askAgain) return true
  if (terms.skipped) return false
  return isEeaRegion(terms.region) && terms.record === null
}

/** The state the chrome reads (`UIState.searchChoice`). */
export function searchChoiceState(terms: SearchChoiceTerms & { seed: number }): SearchChoiceState {
  return {
    region: terms.region,
    eea: isEeaRegion(terms.region),
    required: searchChoiceRequired(terms),
    seed: terms.seed
  }
}

/** One tile of the screen: the engine and its own line. */
export interface SearchChoiceTile {
  engine: SearchEngine
  tagline: string
}

/**
 * The region whose list the screen shows: the host's region when the table has a list for it
 * (a member state's, a territory's through its alias); else – Settings' "Choose your search
 * engine again" from outside the EEA, or after a move – the region the device's record was
 * made for, when the table has that one; else null, and the list is the fallback
 * (`searchChoiceEngineIds`). One resolution for the core's `choose` and the chrome's list, so
 * the tile picked is always one the core accepts.
 */
export function searchChoiceListRegion(
  region: string | null | undefined,
  record: Pick<SearchChoiceRecord, 'region'> | null | undefined
): string | null {
  return searchChoiceCountry(region) ?? searchChoiceCountry(record?.region) ?? null
}

/**
 * The region `choose` records the screen as shown for: the host's when the table has its list
 * (a territory's own code, not its alias's); else the record's, when the table has that one –
 * the device moved, and keeps the list it was given, as Chrome keeps the country at install;
 * else the host's as it is (the fallback list was shown).
 */
export function searchChoiceShownFor(
  region: string | null,
  record: Pick<SearchChoiceRecord, 'region'> | null | undefined
): string | null {
  if (searchChoiceCountry(region)) return region
  if (record && searchChoiceCountry(record.region)) return record.region
  return region
}

/**
 * The tiles for `region` in the table's order (`EEA_SEARCH_CHOICE`; the fallback list for a
 * region the table has no list for), each engine with its line. An id the registry does not
 * resolve is left out rather than drawn without an engine behind it.
 */
export function searchChoiceTiles(region: string | null | undefined): SearchChoiceTile[] {
  const tiles: SearchChoiceTile[] = []
  for (const id of searchChoiceEngineIds(region)) {
    const engine = searchChoiceEngine(id)
    if (engine) tiles.push({ engine, tagline: searchChoiceTagline(engine) })
  }
  return tiles
}

/**
 * The tiles in the run's order: the region's list shuffled with `seed` (stable for one seed),
 * as Chrome shuffles each country's whole list with a seed it keeps.
 */
export function shuffledSearchChoiceTiles(
  region: string | null | undefined,
  seed: number
): SearchChoiceTile[] {
  return seededShuffle(searchChoiceTiles(region), seed)
}

/** Whether `engineId` is one the screen for `region` may set as the default. */
export function isSearchChoiceEngine(engineId: string, region: string | null | undefined): boolean {
  return searchChoiceEngineIds(region).includes(engineId) && searchChoiceEngine(engineId) !== null
}

/** A seed for the run's order: 32 bits from `random` (Math.random by default). */
export function newSearchChoiceSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0x100000000) >>> 0
}

/**
 * Fisher–Yates over a copy, the draws from a small seeded generator (mulberry32): the same seed
 * gives the same order every time, so the list keeps its order while the app is open and a
 * test can name the order it expects; two seeds give two orders.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  const next = mulberry32(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const swap = out[i]!
    out[i] = out[j]!
    out[j] = swap
  }
  return out
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }
}

/** The record `choose` writes: the engine, the region the screen was shown for, the time, the version. */
export function searchChoiceRecord(
  engineId: string,
  region: string | null,
  madeAt: number,
  version = SEARCH_CHOICE_VERSION
): SearchChoiceRecord {
  return { engineId, region: region ?? '', madeAt, version }
}

/**
 * A profile's `settings.searchChoice` as read from disk: a complete record, or null for a
 * profile from before the screen, an explicit null, or anything that is not a record (a
 * record without an engine is no answer, and the screen asks again).
 */
export function sanitizeSearchChoice(raw: unknown): SearchChoiceRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.engineId !== 'string' || !r.engineId || r.engineId.length > 128) return null
  const madeAt = typeof r.madeAt === 'number' && Number.isFinite(r.madeAt) ? r.madeAt : 0
  const version =
    typeof r.version === 'number' && Number.isInteger(r.version) && r.version > 0
      ? r.version
      : SEARCH_CHOICE_VERSION
  return { engineId: r.engineId, region: normalizeRegion(r.region) ?? '', madeAt, version }
}

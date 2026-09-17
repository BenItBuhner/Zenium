import type { LanguagePair } from '../../shared/translateEngine'
import { TRANSLATE_PIVOT_LANGUAGE } from '../../shared/translate'
import type { PackedFile, PackedModel } from './registryTypes'
import {
  REGISTRY_LOCATION_PREFIX,
  REGISTRY_MODEL_LICENSE,
  REGISTRY_SNAPSHOT,
  REGISTRY_SNAPSHOT_AT
} from './registryData'

/** Where Remote Settings serves the model files. */
export const REGISTRY_CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/'
/** The collection the snapshot was taken from; consulted again at runtime for new pairs. */
export const REGISTRY_RECORDS_URL =
  'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records'
/** How long a fetched registry is trusted before it is refreshed. */
export const REGISTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type ModelFileType = 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab' | 'qualityModel'

export interface ModelFile {
  type: ModelFileType
  size: number
  sha256: string
  url: string
}

/** One translation model: the newest release of a language pair. */
export interface ModelRecord {
  from: string
  to: string
  version: string
  files: ModelFile[]
  /** Total size of the files in bytes. */
  bytes: number
}

/** A Remote Settings record of the `translations-models` collection (the fields used here). */
export interface RegistryRecord {
  fromLang?: string
  toLang?: string
  version?: string
  fileType?: string
  attachment?: { location: string; hash: string; size: number }
}

/** The document cached after a live refresh (`translate-registry.json`). */
export interface RegistryCache {
  fetchedAt: number
  models: PackedModel[]
}

export function pairKey(pair: LanguagePair): string {
  return `${pair.from}\u0000${pair.to}`
}

/**
 * `2.1a1` → [2, 1, 0, 1] and `2.1` → [2, 1, 1, 0]: alphas sort below the release with the same
 * number and among themselves by their alpha number.
 */
function versionKey(version: string): [number, number, number, number] {
  const match = /^(\d+)\.(\d+)(a(\d*))?$/.exec(version)
  if (!match) return [0, 0, -1, 0]
  return [Number(match[1]), Number(match[2]), match[3] ? 0 : 1, Number(match[4] || 0)]
}

export function compareVersions(a: string, b: string): number {
  const ka = versionKey(a)
  const kb = versionKey(b)
  for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
  return 0
}

function isComplete(files: Map<string, RegistryRecord>): boolean {
  return (
    files.has('model') &&
    files.has('lex') &&
    (files.has('vocab') || (files.has('srcvocab') && files.has('trgvocab')))
  )
}

/**
 * Condense raw collection records (one per file) to the newest complete release per pair, the
 * way Firefox picks its models: releases beat alphas, higher versions beat lower ones. Mirrors
 * `scripts/translate-registry.mjs`, which produces the bundled snapshot with the same rules.
 */
export function condenseRecords(records: RegistryRecord[]): PackedModel[] {
  const byPair = new Map<string, Map<string, Map<string, RegistryRecord>>>()
  for (const record of records) {
    if (!record.fromLang || !record.toLang || !record.attachment || !record.version) continue
    if (!record.fileType) continue
    const key = pairKey({ from: record.fromLang, to: record.toLang })
    let versions = byPair.get(key)
    if (!versions) byPair.set(key, (versions = new Map()))
    let files = versions.get(record.version)
    if (!files) versions.set(record.version, (files = new Map()))
    files.set(record.fileType, record)
  }
  const models: PackedModel[] = []
  for (const [key, versions] of byPair) {
    const complete = [...versions.entries()].filter(([, files]) => isComplete(files))
    if (complete.length === 0) continue
    const releases = complete.filter(([version]) => !/a/.test(version))
    const candidates = releases.length > 0 ? releases : complete
    candidates.sort((a, b) => compareVersions(b[0], a[0]))
    const [version, files] = candidates[0]
    const [from, to] = key.split('\u0000')
    const pack = (type: string): PackedFile => {
      const record = files.get(type)
      const attachment = record?.attachment
      if (!attachment) throw new Error(`registry record ${from}-${to} ${version} lacks ${type}`)
      const location = attachment.location
      return {
        t: type,
        s: attachment.size,
        h: attachment.hash,
        l: location.startsWith(REGISTRY_LOCATION_PREFIX)
          ? location.slice(REGISTRY_LOCATION_PREFIX.length)
          : location
      }
    }
    const list = [pack('model'), pack('lex')]
    if (files.has('srcvocab') && files.has('trgvocab'))
      list.push(pack('srcvocab'), pack('trgvocab'))
    else list.push(pack('vocab'))
    models.push({ f: from, o: to, v: version, x: list })
  }
  models.sort((a, b) => (a.f + a.o).localeCompare(b.f + b.o))
  return models
}

export function unpackModel(packed: PackedModel): ModelRecord {
  const files = packed.x.map((file): ModelFile => ({
    type: file.t as ModelFileType,
    size: file.s,
    sha256: file.h,
    url: `${REGISTRY_CDN}${REGISTRY_LOCATION_PREFIX}${file.l}`
  }))
  return {
    from: packed.f,
    to: packed.o,
    version: packed.v,
    files,
    bytes: files.reduce((sum, file) => sum + file.size, 0)
  }
}

/**
 * The language pairs Bergamot models exist for. Starts from the snapshot bundled with the app
 * and can be replaced by a fresher condensed copy of the live collection (`replace`).
 */
export class ModelRegistry {
  private models = new Map<string, ModelRecord>()
  private packedModels: PackedModel[] = []
  /** When the current contents were fetched (0 for the bundled snapshot). */
  fetchedAt = 0

  constructor(packed: PackedModel[] = REGISTRY_SNAPSHOT) {
    this.replace(packed, 0)
  }

  /** Date of the bundled snapshot (`YYYY-MM-DD`). */
  static readonly snapshotDate = REGISTRY_SNAPSHOT_AT
  /** SPDX identifier of the licence the model files come under. */
  static readonly modelLicense = REGISTRY_MODEL_LICENSE

  replace(packed: PackedModel[], fetchedAt: number): void {
    const next = new Map<string, ModelRecord>()
    for (const model of packed) {
      const record = unpackModel(model)
      next.set(pairKey(record), record)
    }
    if (next.size === 0) return
    this.models = next
    this.packedModels = packed
    this.fetchedAt = fetchedAt
  }

  /** The current contents in the compact form the cache and the snapshot use. */
  packed(): PackedModel[] {
    return this.packedModels
  }

  find(pair: LanguagePair): ModelRecord | null {
    return this.models.get(pairKey(pair)) ?? null
  }

  all(): ModelRecord[] {
    return [...this.models.values()]
  }

  /** Every language that appears as a source or a target, sorted. */
  languages(): string[] {
    const set = new Set<string>()
    for (const model of this.models.values()) {
      set.add(model.from)
      set.add(model.to)
    }
    return [...set].sort()
  }

  /** Languages pages can be translated from (into `to`, directly or through English). */
  sources(to: string): string[] {
    return this.languages().filter((from) => from !== to && this.route({ from, to }) !== null)
  }

  /** Languages pages in `from` can be translated into. */
  targets(from: string): string[] {
    return this.languages().filter((to) => to !== from && this.route({ from, to }) !== null)
  }

  /**
   * The models a translation needs: the direct pair when one exists, otherwise a pivot through
   * English (Mozilla publishes every language paired with English only). Null when impossible.
   */
  route(pair: LanguagePair): LanguagePair[] | null {
    if (pair.from === pair.to) return null
    if (this.find(pair)) return [pair]
    const pivot = TRANSLATE_PIVOT_LANGUAGE
    if (pair.from === pivot || pair.to === pivot) return null
    const first = { from: pair.from, to: pivot }
    const second = { from: pivot, to: pair.to }
    return this.find(first) && this.find(second) ? [first, second] : null
  }

  /**
   * Whether to ask Remote Settings again: the bundled snapshot (never refreshed, `fetchedAt` 0)
   * always is, a cached copy once it is older than `REGISTRY_MAX_AGE_MS`.
   */
  stale(now: number): boolean {
    return this.fetchedAt === 0 || now - this.fetchedAt > REGISTRY_MAX_AGE_MS
  }
}

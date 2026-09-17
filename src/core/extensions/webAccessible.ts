/**
 * `web_accessible_resources`: which files of an extension package a web page may load. MV2 lists
 * paths; MV3 lists entries with `resources` (paths, `*` wildcards), the `matches` / `extension_ids`
 * allowed to load them, and `use_dynamic_url` (Chrome then serves the entry from a per-session
 * origin so pages cannot fingerprint the extension by its id).
 */
import type { ExtensionManifest, ManifestWebAccessibleResourceMv3 } from './manifest'

export interface WebAccessibleMatch {
  /** The entry's `use_dynamic_url` (always false for MV2 lists). */
  useDynamicUrl: boolean
  /** The `matches` patterns of the entry, when it has any. */
  matches: readonly string[] | undefined
}

/** A package path without leading slashes, query or fragment, as the manifest patterns name it. */
export function normalizeResourcePath(path: string): string {
  let out = path
  const cut = out.search(/[?#]/)
  if (cut >= 0) out = out.slice(0, cut)
  try {
    out = decodeURIComponent(out)
  } catch {
    // A malformed escape keeps the raw text; nothing in a manifest matches it anyway.
  }
  return out.replace(/^\/+/, '')
}

/** Chrome matches `resources` entries with `*` as "any run of characters" (`base::MatchPattern`). */
export function resourcePatternMatches(pattern: string, path: string): boolean {
  const normalized = normalizeResourcePath(pattern)
  if (!normalized.includes('*')) return normalized === path
  const source = normalized
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(path)
}

/** The first `web_accessible_resources` entry naming `path`, or undefined when a page may not load it. */
export function webAccessibleEntryFor(
  manifest: Pick<ExtensionManifest, 'web_accessible_resources'>,
  path: string
): WebAccessibleMatch | undefined {
  const entries = manifest.web_accessible_resources
  if (!entries || entries.length === 0) return undefined
  const target = normalizeResourcePath(path)
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (resourcePatternMatches(entry, target)) return { useDynamicUrl: false, matches: undefined }
      continue
    }
    const mv3 = entry as ManifestWebAccessibleResourceMv3
    if (!Array.isArray(mv3.resources)) continue
    if (mv3.resources.some((pattern) => resourcePatternMatches(pattern, target))) {
      return { useDynamicUrl: mv3.use_dynamic_url === true, matches: mv3.matches }
    }
  }
  return undefined
}

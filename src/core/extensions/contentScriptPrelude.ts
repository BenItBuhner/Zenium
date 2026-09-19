/**
 * The install pipeline's side of the content-script storage prelude (`api/contentScriptStorage.ts`):
 * the prelude file every install directory carries, and the rewrite that puts it first in each
 * `content_scripts[].js` list of the manifest the engine loads. The developer's manifest keeps
 * its meaning otherwise; entries that run in the page's main world (`world: "MAIN"`, where
 * `chrome.storage` does not exist) and CSS-only entries are left alone. Pure functions, so the
 * rules are testable and the same for store packages, sideloaded zips and unpacked folders.
 */
import { CONTENT_SCRIPT_PRELUDE_FILE, contentScriptPreludeSource } from './api/contentScriptStorage'
import { utf8Decode, utf8Encode } from './bytes'
import { stripJsonComments } from './manifest'

export { CONTENT_SCRIPT_PRELUDE_FILE } from './api/contentScriptStorage'

export interface PreludeRewrite {
  manifest: Record<string, unknown>
  /** Content-script entries that carry the prelude (already or after this rewrite). */
  entries: number
  /** Whether the rewrite produced a different manifest. */
  changed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether a content-script entry (a manifest `content_scripts` item or a `scripting`
 * registration) runs where `chrome.storage` exists and has scripts to run before.
 */
export function contentScriptWantsPrelude(entry: Record<string, unknown>): boolean {
  if (entry.world === 'MAIN') return false
  const js = entry.js
  return Array.isArray(js) && js.some((item) => typeof item === 'string')
}

/** `list` with the prelude first (unchanged when it already leads). */
export function withPreludeFirst(list: unknown[], file = CONTENT_SCRIPT_PRELUDE_FILE): unknown[] {
  return list[0] === file ? list : [file, ...list]
}

/** The manifest with the prelude first in every content-script entry that wants it. */
export function withContentScriptPrelude(
  manifest: Record<string, unknown>,
  file = CONTENT_SCRIPT_PRELUDE_FILE
): PreludeRewrite {
  const scripts = manifest.content_scripts
  if (!Array.isArray(scripts)) return { manifest, entries: 0, changed: false }
  let changed = false
  let entries = 0
  const next = scripts.map((entry: unknown): unknown => {
    if (!isRecord(entry) || !contentScriptWantsPrelude(entry)) return entry
    entries += 1
    const js = entry.js as unknown[]
    const withPrelude = withPreludeFirst(js, file)
    if (withPrelude === js) return entry
    changed = true
    return { ...entry, js: withPrelude }
  })
  if (!changed) return { manifest, entries, changed: false }
  return { manifest: { ...manifest, content_scripts: next }, entries, changed: true }
}

/**
 * A manifest's bytes as written by the pipeline: parsed (comments stripped, as Chrome does),
 * transformed, re-serialised. Bytes that are not a JSON object come back untouched, so a broken
 * manifest fails in the engine's loader with the engine's message, not here.
 */
export function transformManifestBytes(
  bytes: Uint8Array,
  transform: (manifest: Record<string, unknown>) => Record<string, unknown>
): Uint8Array {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(utf8Decode(bytes)))
  } catch {
    return bytes
  }
  if (!isRecord(parsed)) return bytes
  return utf8Encode(JSON.stringify(transform(parsed), null, 2))
}

/** The prelude file as the pipeline writes it. */
export function contentScriptPreludeFile(): { path: string; bytes: Uint8Array } {
  return { path: CONTENT_SCRIPT_PRELUDE_FILE, bytes: utf8Encode(contentScriptPreludeSource()) }
}

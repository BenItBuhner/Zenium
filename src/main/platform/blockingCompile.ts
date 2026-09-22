/**
 * The desktop's filter-list compile as a background task: Ghostery's `FiltersEngine` parsed from
 * the enabled lists' text and SERIALISED (its own byte form, the one `blocking/engine.bin`
 * caches), plus the document-level filters' accepted lines – plain bytes and a string, so the
 * main process only deserialises (milliseconds) where it used to parse (hundreds of milliseconds
 * per build, once per list that changed in a sweep). Served by the main process's background
 * worker (`backgroundWorker.ts`) beside the core's tasks; `GhosteryTextMatcher` runs the same
 * function inline where the queue has no worker. No `electron` import: this runs in a worker.
 */
import { FiltersEngine } from '@ghostery/adblocker'
import type { BackgroundTask } from '../../core/background/tasks'
import { DocumentFilters } from '../../core/blocking/documentFilters'

/** How the lists are parsed: network filters only, uncompressed, optimised. */
export const GHOSTERY_PARSE_OPTIONS = {
  loadCosmeticFilters: false,
  enableCompression: false,
  enableOptimizations: true,
  debug: false
} as const

/** Parse the enabled lists' text (`parts`) into the engine and the document filters, in memory. */
export function compileGhosteryEngine(parts: readonly string[]): {
  engine: FiltersEngine
  documents: DocumentFilters
} {
  return {
    engine: FiltersEngine.parse(parts.join('\n'), GHOSTERY_PARSE_OPTIONS),
    documents: DocumentFilters.parse(parts)
  }
}

export interface GhosteryCompileInput {
  /** The enabled lists' filter text, one entry per list. */
  parts: string[]
}

export interface GhosteryCompileOutput {
  /** `FiltersEngine.serialize()`; `FiltersEngine.deserialize` reads it back. Its buffer is moved. */
  engine: Uint8Array
  /** `DocumentFilters.lines` joined by newlines (what `documents.txt` caches). */
  documents: string
}

/** The compiled form of the lists as bytes, which the main process adopts by deserialising. */
export const GHOSTERY_COMPILE_TASK: BackgroundTask<GhosteryCompileInput, GhosteryCompileOutput> = {
  name: 'blocking.compileGhostery',
  run: ({ parts }) => {
    const { engine, documents } = compileGhosteryEngine(parts)
    return { engine: engine.serialize(), documents: documents.lines.join('\n') }
  },
  transferables: (output) => [output.engine.buffer as ArrayBuffer]
}

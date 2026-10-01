/**
 * The desktop's filter-list compile as a background task: Ghostery's `FiltersEngine` parsed from
 * the enabled lists' text and SERIALISED (its own byte form, the one `blocking/engine.bin`
 * caches), plus the document-level filters' accepted lines – plain bytes and a string, so the
 * main process only deserialises (milliseconds) where it used to parse (hundreds of milliseconds
 * per build, once per list that changed in a sweep). Served by the main process's background
 * worker (`backgroundWorker.ts`) beside the core's tasks; `GhosteryTextMatcher` runs the same
 * function inline where the queue has no worker. No `electron` import: this runs in a worker.
 *
 * One request compiles every scope of one build (the unscoped matcher's and each named
 * partition's), one after the other, and answers once with all of them (W8-P1: never two
 * compiles side by side). The cache write happens here too, where the bytes already are: after
 * the answer is posted – the adopt never waits on the disk – each scope's files land atomically
 * (temp file + rename), and a write that fails is logged once per path and otherwise forgotten:
 * the next start finds no cache (or a stale one) and recompiles, as it does for any miss.
 */
import { FiltersEngine } from '@ghostery/adblocker'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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

/** The three files one scope's compiled form is cached in, and what their metadata records. */
export interface GhosteryCachePaths {
  bin: string
  meta: string
  documents: string
}

/** Where (and under which fingerprint) one scope's compiled form is cached. */
export interface GhosteryCacheTarget extends GhosteryCachePaths {
  fingerprint: string
  version: string
}

/** One scope of a build: its key (the partition, or null for the unscoped matcher) and text. */
export interface GhosteryCompileScope {
  partition: string | null
  /** The scope's enabled lists' filter text, one entry per list. */
  parts: string[]
  /** Where the worker caches the result once it has answered; null: not cached. */
  cache: GhosteryCacheTarget | null
}

export interface GhosteryCompileInput {
  /** The scopes of one build, compiled one after the other. */
  scopes: GhosteryCompileScope[]
}

export interface GhosteryCompiledScope {
  partition: string | null
  /** `FiltersEngine.serialize()`; `FiltersEngine.deserialize` reads it back. Its buffer is moved. */
  engine: Uint8Array
  /** `DocumentFilters.lines` joined by newlines (what `documents.txt` caches). */
  documents: string
}

export interface GhosteryCompileOutput {
  scopes: GhosteryCompiledScope[]
}

/** Cache paths whose write already failed once this session: the warning is not repeated. */
const warnedCachePaths = new Set<string>()

/**
 * Write one scope's compiled form under `target`, atomically: the bytes go to a temp file that
 * is renamed into place, so a crash mid-write never leaves a torn `engine.bin` for the next
 * start; the documents and the metadata follow (the metadata last, so a reader that finds the
 * fingerprint finds the files it names). A failure is logged once per path; nothing is retried.
 */
export function writeGhosteryCache(
  target: GhosteryCacheTarget,
  engine: Uint8Array,
  documents: string
): boolean {
  const tmp = `${target.bin}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(target.bin), { recursive: true })
    writeFileSync(tmp, engine)
    renameSync(tmp, target.bin)
    writeFileSync(target.documents, documents)
    writeFileSync(
      target.meta,
      JSON.stringify({ fingerprint: target.fingerprint, version: target.version })
    )
    return true
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // Never written, or already renamed.
    }
    if (!warnedCachePaths.has(target.bin)) {
      warnedCachePaths.add(target.bin)
      console.warn('[zenium] filter engine cache not written', target.bin, error)
    }
    return false
  }
}

/** Forget which cache writes were already warned about (the tests). */
export function resetGhosteryCacheWarnings(): void {
  warnedCachePaths.clear()
}

/**
 * The compiled form of the lists as bytes, which the main process adopts by deserialising. The
 * cache write is scheduled for right after the reply is posted (`setImmediate`, on the worker's
 * own loop) from a copy of the bytes, since the reply moves the originals to the main thread.
 */
export const GHOSTERY_COMPILE_TASK: BackgroundTask<GhosteryCompileInput, GhosteryCompileOutput> = {
  name: 'blocking.compileGhostery',
  run: ({ scopes }) => {
    const writes: Array<() => void> = []
    const out: GhosteryCompiledScope[] = []
    for (const scope of scopes) {
      const { engine, documents } = compileGhosteryEngine(scope.parts)
      const bytes = engine.serialize()
      const lines = documents.lines.join('\n')
      out.push({ partition: scope.partition, engine: bytes, documents: lines })
      if (scope.cache) {
        const target = scope.cache
        const copy = bytes.slice()
        writes.push(() => void writeGhosteryCache(target, copy, lines))
      }
    }
    if (writes.length) setImmediate(() => writes.forEach((write) => write()))
    return { scopes: out }
  },
  transferables: (output) => output.scopes.map((scope) => scope.engine.buffer as ArrayBuffer)
}

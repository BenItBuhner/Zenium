/**
 * The heavy, pure work the services hand to the background worker (`work.ts`): what a Safe
 * Browsing feed's text becomes (its hash-prefix table, sorted, as bytes) and what a filter list's
 * text becomes (its network filters, one per line). Each task is a plain function of plain data:
 * the same code runs inside the worker (`worker.ts` serves this table) and, where the host has no
 * worker, on the main thread (`runInline`, the chunked path that yields between hosts), and both
 * produce the same bytes – the tests pin them against each other.
 *
 * A task's output crosses the thread boundary by structured clone, its {@link BackgroundTask.transferables}
 * moved rather than copied; keep outputs to strings, numbers and typed arrays.
 */
import { parseListHeader, prepareListText, type ListHeader } from '../blocking/lists'
import { parseFeed, type SafeBrowsingFeed } from '../safebrowsing/feeds'
import { PrefixTable } from '../safebrowsing/prefixes'

export interface BackgroundTask<I, O> {
  /** The name the request carries; unique across the tables a worker serves. */
  readonly name: string
  /** The work, whole, as the worker runs it. */
  run(input: I): O
  /**
   * The work on the main thread where no worker is available: the same result, in pieces that
   * yield to the event loop where the work has a natural seam. Defaults to {@link run}.
   */
  runInline?(input: I): Promise<O>
  /** The buffers of an output the worker moves instead of copying. */
  transferables?(output: O): ArrayBuffer[]
}

/** What a worker is asked; `input` is the task's. */
export interface BackgroundRequest {
  id: number
  name: string
  input: unknown
}

/** A worker's answer to one request. */
export type BackgroundReply =
  { id: number; ok: true; output: unknown } | { id: number; ok: false; error: string }

// ---------------------------------------------------------------------------
// Safe Browsing: feed text → prefix table
// ---------------------------------------------------------------------------

export interface SafeBrowsingTableInput {
  text: string
  format: SafeBrowsingFeed['format']
}

export interface SafeBrowsingTableOutput {
  /**
   * The table itself, sorted and distinct (`PrefixTable.sortedValues()`); its buffer is moved,
   * not copied, and `PrefixTable.fromSortedValues` adopts it without another sort.
   */
  values: BigUint64Array
  /** The same table as the feed document stores it (`FeedDocument.prefixes`). */
  base64: string
  /** Distinct prefixes in the table. */
  entries: number
  /** Hosts the text held (0: the download is not a host list). */
  hosts: number
}

function tableOutput(table: PrefixTable, hosts: number): SafeBrowsingTableOutput {
  return { values: table.sortedValues(), base64: table.toBase64(), entries: table.size, hosts }
}

/**
 * The feed text parsed, every host hashed, the prefixes sorted and deduplicated, the document's
 * base64 encoded. Inline, the hashing yields every few thousand hosts
 * (`PrefixTable.fromHostsChunked`) – the parse, the sort and the encoding do not, which is why
 * the worker is the better place.
 */
export const SAFE_BROWSING_TABLE_TASK: BackgroundTask<
  SafeBrowsingTableInput,
  SafeBrowsingTableOutput
> = {
  name: 'safebrowsing.table',
  run: ({ text, format }) => {
    const hosts = parseFeed(text, format)
    return tableOutput(PrefixTable.fromHosts(hosts), hosts.length)
  },
  runInline: async ({ text, format }) => {
    const hosts = parseFeed(text, format)
    return tableOutput(await PrefixTable.fromHostsChunked(hosts), hosts.length)
  },
  transferables: (output) => [output.values.buffer as ArrayBuffer]
}

// ---------------------------------------------------------------------------
// Blocking: filter-list text → what the engines store
// ---------------------------------------------------------------------------

export interface PrepareListInput {
  text: string
}

export interface PrepareListOutput {
  /** Network filters only, one per line (`prepareListText`). */
  text: string
  /** How many; also the count of network filters in `text`. */
  count: number
  /** The `! Key: value` header block of the list. */
  header: ListHeader
}

/**
 * A downloaded list reduced to what both engines store: its network filters, normalised, plus
 * the header the Settings rows show. The compiled form of a list on the desktop (Ghostery's
 * engine) and on Android (the Kotlin engine's own index) is each host's, built from this text;
 * the core keeps no compiled form of a list, so there is nothing more to hand back.
 */
export const PREPARE_LIST_TASK: BackgroundTask<PrepareListInput, PrepareListOutput> = {
  name: 'blocking.prepareList',
  run: ({ text }) => {
    const prepared = prepareListText(text)
    return { text: prepared.text, count: prepared.count, header: parseListHeader(text) }
  }
}

/** The tasks every host's worker serves (a host adds its own beside them). */
export const CORE_BACKGROUND_TASKS: ReadonlyArray<BackgroundTask<unknown, unknown>> = [
  SAFE_BROWSING_TABLE_TASK as BackgroundTask<unknown, unknown>,
  PREPARE_LIST_TASK as BackgroundTask<unknown, unknown>
]

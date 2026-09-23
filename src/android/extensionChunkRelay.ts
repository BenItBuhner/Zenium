/**
 * A webpack chunk of a content script's module graph, run in the content script's own scope on a
 * WebView without isolated worlds.
 *
 * Under the `with` fallback a content script's globals live in its scope proxy's store, not on
 * the page's window; a module the script `import()`s evaluates on the real global, bracketed by
 * the host so its `chrome` and `self` answer the extension's while it runs
 * (`extensionModuleChrome.ts`). That is enough for a module that reaches its globals through
 * `self` or `globalThis`, and not for one that reads a bare name: Mote's runtime wrote
 * `HowlerGlobal` through webpack's `r.g` (the scope proxy) while its sidebar chunk, a module on
 * the real global, read the bare `HowlerGlobal` and found nothing (compat round 11, row 13).
 *
 * A webpack chunk is one `push` expression with no exports, so a block of the scope runs it as
 * its module would have, and there its bare identifiers resolve as the content script's own do.
 * The host serves such a chunk to a page's module graph as a stub (`ExtensionScripts.chunkStub`)
 * whose top-level `await` calls `__zenExtChunk(<id>, <url>)`: this relay asks the host for the
 * file (`chunkScript` over the bridge), the host runs it through `evaluateJavascript` as an exec
 * of kind `chunk` – a `with(window){…}` block of the extension's scope, the shape a scoped
 * `scripting.executeScript` file has – and the bootstrap's `exec` settles the ticket once the
 * block ran (`ran`). The `import()` then resolves as the chunk's would have, with the chunk
 * registered on the content script's registry. Where it cannot run this way – no scope of the
 * extension in this copy, a subframe (`evaluateJavascript` takes no frame), the host's refusal
 * (`chunkDone`: not web-accessible, not found, a text `evaluateJavascript` could not run) – the
 * ticket answers false and the stub imports the chunk plain, bracketed, as it was served before
 * the stub. A chunk that threw in the scope rejects the ticket with its error, so the `import()`
 * rejects as it would have.
 */

export interface ChunkRelayHost {
  /** Whether this copy can run a chunk of the extension in its content scope here (a top frame that made the scope). */
  canRun(extId: string): boolean
  /** Ask the host to run `url` in the scope; it answers through `ran` (the exec landed) or `done` (refused). */
  request(id: string, extId: string, url: string): void
  /** A console warning of the page's, for a chunk that ran plain after all. */
  warn(...args: unknown[]): void
}

export interface ChunkRelay {
  /**
   * `__zenExtChunk(extId, url)`: true once the chunk ran in the scope, false when it is to be
   * imported plain (synchronously so when this copy cannot run it at all), the chunk's own error
   * when it threw.
   */
  claim(extId: unknown, url: unknown): Promise<boolean> | false
  /** The exec of kind `chunk` ran the file in the scope: `error` null, or what the chunk threw. */
  ran(id: string, error: string | null): void
  /** The host's `chunkDone`: refused for `error`; the stub imports the chunk plain. */
  done(id: string, error: string | null): void
  /** Tickets still waiting for the host (tests, diagnostics). */
  pending(): number
  /** How the chunks went: run in the scope, imported plain (this copy could not, or the host refused), thrown. */
  stats(): ChunkStats
}

export interface ChunkStats {
  scoped: number
  plain: number
  failed: number
}

interface Ticket {
  url: string
  resolve(ran: boolean): void
  reject(error: Error): void
}

export function createChunkRelay(host: ChunkRelayHost): ChunkRelay {
  const waiting = new Map<string, Ticket>()
  const stats: ChunkStats = { scoped: 0, plain: 0, failed: 0 }
  let seq = 0
  const take = (id: string): Ticket | undefined => {
    const ticket = waiting.get(id)
    if (ticket) waiting.delete(id)
    return ticket
  }
  return {
    claim(extId, url) {
      const id = String(extId)
      const href = String(url)
      if (!host.canRun(id)) {
        stats.plain++
        return false
      }
      const ticket = `c${++seq}`
      return new Promise<boolean>((resolve, reject) => {
        waiting.set(ticket, { url: href, resolve, reject })
        host.request(ticket, id, href)
      })
    },
    ran(id, error) {
      const ticket = take(id)
      if (!ticket) return
      if (error === null) {
        stats.scoped++
        ticket.resolve(true)
      } else {
        stats.failed++
        ticket.reject(new Error(error))
      }
    },
    done(id, error) {
      const ticket = take(id)
      if (!ticket) return
      stats.plain++
      host.warn(
        `[Zenium] ${ticket.url} runs on the page's global, not in the content script's scope: ${error ?? 'the host refused'}`
      )
      ticket.resolve(false)
    },
    pending: () => waiting.size,
    stats: () => stats
  }
}

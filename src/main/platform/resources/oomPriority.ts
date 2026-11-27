import { writeFileSync } from 'node:fs'

/**
 * Which process Linux's out-of-memory killer takes first, when it has to (a container or a
 * systemd unit at its `MemoryMax=`, a machine out of RAM and swap): a page nobody is looking at,
 * never the browser.
 *
 * The killer picks the process with the highest `oom_score`: its resident memory plus
 * `oom_score_adj` thousandths of the memory it may use. Chromium starts renderers at 300 and
 * leaves the browser process at 0, so under a tight limit the browser process – the biggest one,
 * with few pages open – is the one killed, and the whole browser goes. Here every renderer that
 * holds only hidden pages is raised (frozen ones highest), and one with a page in front is left
 * at Chromium's value. A renderer killed this way is a sleeping tab like any other: the tab
 * manager unloads a hidden page whose renderer went and loads it again when it is shown.
 *
 * Raising a process's own children's `oom_score_adj` needs no privilege. Linux only; every
 * write is best effort and done only when the value changes.
 */

/** Chromium's own value for renderers: what a renderer with a visible page keeps. */
export const OOM_ADJ_VISIBLE = 300
/** A renderer whose pages are all hidden but running. */
export const OOM_ADJ_HIDDEN = 800
/** A renderer whose pages are all frozen: the cheapest to lose, nothing in it runs. */
export const OOM_ADJ_FROZEN = 1000

export interface RendererPage {
  pids: readonly number[]
  visible: boolean
  frozen: boolean
}

/** The adjustment for each renderer pid: the most protected of the pages it holds wins. */
export function oomAdjustments(pages: readonly RendererPage[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const page of pages) {
    const adj = page.visible ? OOM_ADJ_VISIBLE : page.frozen ? OOM_ADJ_FROZEN : OOM_ADJ_HIDDEN
    for (const pid of page.pids) {
      const prev = out.get(pid)
      out.set(pid, prev === undefined ? adj : Math.min(prev, adj))
    }
  }
  return out
}

export class OomPriority {
  private readonly written = new Map<number, number>()

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly write: (pid: number, value: number) => void = (pid, value) =>
      writeFileSync(`/proc/${pid}/oom_score_adj`, String(value))
  ) {}

  /** Bring every listed renderer to its adjustment; forget pids that are gone. */
  apply(pages: readonly RendererPage[]): void {
    if (this.platform !== 'linux') return
    const wanted = oomAdjustments(pages)
    for (const pid of [...this.written.keys()]) if (!wanted.has(pid)) this.written.delete(pid)
    for (const [pid, adj] of wanted) {
      if (this.written.get(pid) === adj) continue
      try {
        this.write(pid, adj)
      } catch {
        // The process is gone, or the write was refused: not retried until the value changes.
      }
      this.written.set(pid, adj)
    }
  }
}

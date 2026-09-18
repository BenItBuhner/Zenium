/**
 * The page-load progress bar's arithmetic. The bar springs (`SPRING_SNAPPY`) towards a target
 * that is the page's reported progress or, while that report stands still, a slow creep – the
 * way every browser keeps its bar alive while a server is still thinking – and fills to the end
 * once the load is over, whatever was reported last.
 */

/** The creep alone never reaches this: only the page finishing fills the last stretch. */
export const CREEP_CEILING = 0.9

/** Time constant (ms) of the creep: about a fifth of the ceiling per second at first. */
export const CREEP_TAU_MS = 4000

/** How far the bar has crept on its own `sinceStartMs` into a load (0…`CREEP_CEILING`). */
export function creep(sinceStartMs: number): number {
  if (!(sinceStartMs > 0)) return 0
  return CREEP_CEILING * (1 - Math.exp(-sinceStartMs / CREEP_TAU_MS))
}

/**
 * Where the bar should be heading: the reported progress or the creep, whichever is further,
 * while the page loads; the end once it has finished (or failed). Always 0…1.
 */
export function progressTarget(reported: number, loading: boolean, sinceStartMs: number): number {
  if (!loading) return 1
  const known = Number.isFinite(reported) ? Math.min(1, Math.max(0, reported)) : 0
  return Math.max(known, creep(sinceStartMs))
}

import type { ResourceProcessProfile } from '@shared/types'

/**
 * "Max concurrency": the process profile for keeping dozens of heavy pages live at once. Sites
 * share renderer processes (relaxed site isolation, and at most this many page processes), which
 * takes the fixed cost of a process off most pages: with 24 or 48 heavy sites kept loaded, about
 * a fifth less memory than full isolation (bench/memory, live24 and live48). The cost is weaker
 * protection between sites, so it is opt-in.
 */
export const MAX_CONCURRENCY_PROCESS_LIMIT = 6

/** Whether `p` is the max-concurrency profile. */
export function isMaxConcurrency(p: ResourceProcessProfile): boolean {
  return p.siteIsolation === 'relaxed' && p.rendererProcessLimit === MAX_CONCURRENCY_PROCESS_LIMIT
}

/** The process-profile change that turns max concurrency on, or back to the defaults. */
export function maxConcurrencyPatch(on: boolean): Partial<ResourceProcessProfile> {
  return on
    ? { siteIsolation: 'relaxed', rendererProcessLimit: MAX_CONCURRENCY_PROCESS_LIMIT }
    : { siteIsolation: 'full', rendererProcessLimit: 0 }
}

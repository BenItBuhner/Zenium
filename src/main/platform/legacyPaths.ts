import { cpSync, existsSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs'

/**
 * The browser was called Zen up to v0.2.0. Its directories carried that name – Electron's
 * userData (`<appData>/Zen`) and the `zen-sync` folder inside a user's cloud drive – and the
 * renamed app looks in `Zenium` / `zenium-sync` instead. Rather than starting every existing
 * user over with an empty profile, the old directory takes the new one's place the first time
 * the renamed app runs: rename where possible, copy when the file system refuses.
 */

/** Answers the file-system questions `planLegacyMove` asks; swapped out by tests. */
export interface DirectoryProbe {
  exists(path: string): boolean
  isDirectory(path: string): boolean
  /** True for a directory without entries (an empty directory may be replaced). */
  isEmpty(path: string): boolean
}

export type LegacySkipReason = 'same-path' | 'no-legacy' | 'current-in-use'

export type LegacyMovePlan = { action: 'move' } | { action: 'skip'; reason: LegacySkipReason }

/**
 * Decide whether the directory at `legacy` should become `current`. Pure apart from `probe`.
 * A `current` that already holds data is never touched: nothing may overwrite a profile the
 * renamed app has begun to use.
 */
export function planLegacyMove(
  legacy: string,
  current: string,
  probe: DirectoryProbe = fsProbe
): LegacyMovePlan {
  if (legacy === current) return { action: 'skip', reason: 'same-path' }
  if (!probe.exists(legacy) || !probe.isDirectory(legacy))
    return { action: 'skip', reason: 'no-legacy' }
  if (probe.exists(current) && !(probe.isDirectory(current) && probe.isEmpty(current)))
    return { action: 'skip', reason: 'current-in-use' }
  return { action: 'move' }
}

export type LegacyMoveResult = 'moved' | 'copied' | LegacySkipReason

/**
 * Carry out `planLegacyMove`: rename `legacy` to `current`, or copy it when renaming fails
 * (another volume, a file that is still open). The copy leaves the original in place – a second
 * copy on disk beats any chance of losing the only one; a copy that fails midway is removed so
 * the next start tries again instead of running on half a profile.
 */
export function moveLegacyDirectory(
  legacy: string,
  current: string,
  log: (message: string) => void = () => undefined
): LegacyMoveResult {
  const plan = planLegacyMove(legacy, current)
  if (plan.action === 'skip') return plan.reason
  // The plan only allows an empty directory here; rmdirSync fails on anything else.
  if (existsSync(current)) rmdirSync(current)
  try {
    renameSync(legacy, current)
    log(`moved ${legacy} to ${current}`)
    return 'moved'
  } catch (error) {
    log(`could not rename ${legacy} to ${current} (${(error as Error).message}); copying instead`)
  }
  try {
    cpSync(legacy, current, { recursive: true, force: true, preserveTimestamps: true })
    log(`copied ${legacy} to ${current}`)
    return 'copied'
  } catch (error) {
    rmSync(current, { recursive: true, force: true })
    throw error
  }
}

export const fsProbe: DirectoryProbe = {
  exists: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  isEmpty: (path) => {
    try {
      return readdirSync(path).length === 0
    } catch {
      return false
    }
  }
}

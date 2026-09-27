import type { UIState } from '@shared/types'
import { isPrereleaseVersion, type UpdateTarget } from '@shared/updates'
import { emptyUpdateDotRecord, updateDotShows } from '@core/updateDot'

/*
 * The words of Settings › About's head (settings-73; `AboutVersionBlock`): the version with its
 * channel, and the copyright and licence line, kept apart from the block so the block's file
 * exports the component alone.
 */

/** The year of the first release, the copyright line's start. */
const FIRST_YEAR = 2026
/** `package.json`'s `author` and `license`, as the copyright line says them. */
const AUTHOR = 'Zenium contributors'
const LICENCE = 'Apache License 2.0'

/**
 * The build's channel, as About names it beside the version (Chrome's "Version 1xx (Official
 * Build) (64-bit)"). The build carries no channel marker of its own: a pre-release tag in the
 * version is the Beta channel (as `effectiveChannel` in `shared/updates.ts` reads it), anything
 * else is Stable, and a dev run – the `dev` target, `npm run dev` – says so. Once the release
 * worker stamps a channel into the build (a `channel` field in `package.json`, or a
 * `ZENIUM_CHANNEL` define in both Vite configs), read it here ahead of the version.
 */
export function buildChannel(version: string, target: Pick<UpdateTarget, 'kind'>): string {
  if (target.kind === 'dev') return 'Development build'
  return isPrereleaseVersion(version) ? 'Beta' : 'Stable'
}

/** "Version 0.4.31 · Stable": the row's one line under the wordmark. */
export function versionLine(version: string, target: Pick<UpdateTarget, 'kind'>): string {
  return `Version ${version} · ${buildChannel(version, target)}`
}

/** "© 2026 Zenium contributors · Apache License 2.0", the span growing with the year. */
export function copyrightLine(year: number = new Date().getFullYear()): string {
  const span = year > FIRST_YEAR ? `${FIRST_YEAR}–${year}` : String(FIRST_YEAR)
  return `© ${span} ${AUTHOR} · ${LICENCE}`
}

/**
 * Whether an update is downloaded and waiting for the relaunch (`UpdateStatus.phase: 'ready'`,
 * shortcuts-menus-101): the app menu opens on its "Update Zenium" row then (`core/menus.ts`)
 * and the "⋯" button wears the accent dot for it (`SidebarTop`), Chrome's dot on its ⋮. A
 * found update that has not downloaded (`available`) shows neither, as Chrome shows nothing
 * until it has. A snapshot without the updater's status (a partial state in a component test)
 * reads as no update.
 */
export function updateReadyAt(state: Pick<UIState, 'updates'>): boolean {
  return state.updates?.phase === 'ready'
}

/**
 * Whether a touch layout's menu button wears the update dot (TB-12; `core/updateDot.ts`): an
 * update downloaded and waiting whose version the app menu has not yet been opened for
 * (`UIState.updateDot`, this device's record, written by the core as the menu opens) – Chrome
 * Android's ⋮ badge, which clears on the menu's first open and returns on a state change. The
 * phone bar's ⋮ and the tablet toolbar's menu button read this; the desktop's ⋯ keeps
 * `updateReadyAt` until W8-F3. A snapshot without the record (a partial state in a component
 * test) reads as nothing seen – the plain ready dot.
 */
export function updateDotAt(state: Partial<Pick<UIState, 'updates' | 'updateDot'>>): boolean {
  if (!state.updates) return false
  return updateDotShows(state.updates, state.updateDot ?? emptyUpdateDotRecord())
}

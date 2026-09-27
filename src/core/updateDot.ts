import type { UpdateStatus } from '../shared/updates'

/*
 * The update dot's per-version 'seen' record (TB-12): Chrome Android's cadence for the badge on
 * its ⋮ – the badge shows while an update waits, clears the first time the app menu is opened
 * (`MenuButtonMediator`: the dot is removed on the menu's open) and returns on a state change (a
 * new version becomes available). Zenium keys the record by the update's version: the dot shows
 * while the updater is `ready` and the waiting version is not the one the menu was last opened
 * for; a new version's `ready` shows it again by construction; the 'Update Zenium' ROW stays as
 * long as the update waits, however often the menu opens.
 *
 * A pure module, shared by every host: the record itself is `BrowserState.updateDot` – device-
 * local (the `privateDevice` shape: replaced whole, persisted with the profile in `state.json`,
 * never synced – what this device's menu has shown is this device's), surfaced to the renderer as
 * `UIState.updateDot`. Every layout reads `updateDotShows` through the renderer's `lib/about.ts`
 * `updateDotAt` (the phone bar's ⋮, the tablet toolbar's menu button, the desktop's ⋯ since
 * W8-F3) and `Menus.showAppMenu` writes `markUpdateMenuOpened` as the menu opens on every host.
 * Chrome DESKTOP's own cadence is the edge left (`app_menu_icon_controller.cc`,
 * `upgrade_detector.cc`): its badge is a pure function of the detector's annoyance stage –
 * green at 2 days, yellow at 4, red at 7 on the stable channel – never cleared by the menu's
 * open, gone only at the relaunch; the lead ruled Zenium takes Android's clear-on-open on every
 * host, keyed by version and persisted (Android's badge is per process: any state change with an
 * update available brings it back, `MenuButtonMediator.updateStateChanged`).
 */

/** What the menu was last opened for: the waiting update's version, or nothing seen yet. */
export interface UpdateDotRecord {
  seenVersion: string | null
}

export function emptyUpdateDotRecord(): UpdateDotRecord {
  return { seenVersion: null }
}

/** A persisted record read back: a non-empty string version or nothing; anything else is empty. */
export function sanitizeUpdateDotRecord(raw: unknown): UpdateDotRecord {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const seen = source.seenVersion
  return { seenVersion: typeof seen === 'string' && seen.length > 0 ? seen : null }
}

/** The part of the updater's status the dot reads: its phase and the waiting release. */
export type UpdateDotStatus = Pick<UpdateStatus, 'phase' | 'release'>

/**
 * Whether the menu button wears the dot: the update downloaded and waiting (`ready`) and its
 * version not the one the menu was last opened for. A `ready` without a release (never the
 * updater's own doing) fails open – the plain ready dot, so a waiting update is never hidden.
 */
export function updateDotShows(status: UpdateDotStatus, record: UpdateDotRecord): boolean {
  if (status.phase !== 'ready') return false
  const version = status.release?.version ?? null
  return version === null || version !== record.seenVersion
}

/**
 * The app menu opened: the waiting version becomes the seen one. Returns the record it was given
 * (the same object) when nothing waits or the version is already seen, so a writer can skip the
 * commit; a release-less `ready` records nothing (there is no version to have seen).
 */
export function markUpdateMenuOpened(
  status: UpdateDotStatus,
  record: UpdateDotRecord
): UpdateDotRecord {
  if (status.phase !== 'ready') return record
  const version = status.release?.version ?? null
  if (version === null || version === record.seenVersion) return record
  return { seenVersion: version }
}

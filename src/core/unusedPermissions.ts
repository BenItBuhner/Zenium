import type { Browser } from './browser'
import type { UnusedPermissionsSweepResult } from './permissions'

const DAY_MS = 24 * 3_600_000

/**
 * The sweep's first run after start: armed for later, off the boot path, as the archive's first
 * pass is (TAB-20's `INACTIVE_TABS_FIRST_PASS_DELAY_MS`) – nothing of it runs at boot beyond the
 * arming itself. Chrome runs its first update as the service comes up; a browser that has been
 * closed for weeks catches up here, three quarters of a minute in.
 */
export const UNUSED_PERMISSIONS_FIRST_SWEEP_DELAY_MS = 45_000

/** Then daily (Chrome's `kUnusedSitePermissionsRepeatedUpdateInterval`). */
export const UNUSED_PERMISSIONS_SWEEP_INTERVAL_MS = DAY_MS

/**
 * Chrome's Safety Hub "unused site permissions" module, the schedule (PS-41): the permissions
 * model does the sweeping (`PermissionService.sweepUnused`); this service says when, and reads
 * the setting that says whether – `settings.autoRevokeUnusedPermissions`, Chrome's
 * `safety_hub.unused_site_permissions_revocation.enabled`, on by default. Off, a run only lets
 * the expired records go; the visit clock keeps running in the model regardless (Chrome keeps
 * stamping too), so turning the setting on later finds the stamps in place. The Safety check
 * runs a sweep before it composes (`PrivacyService.safetyCheck`), so "Check now" reads a fresh
 * list.
 */
export class UnusedPermissionsService {
  private cancelFirstRun: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly browser: Browser) {}

  /** Whether the setting lets the sweep revoke. */
  enabled(): boolean {
    return this.browser.state.settings.autoRevokeUnusedPermissions !== false
  }

  start(): void {
    const run = (): void => {
      this.run()
    }
    this.cancelFirstRun = this.browser.background.armStartup(
      UNUSED_PERMISSIONS_FIRST_SWEEP_DELAY_MS,
      run
    )
    this.timer = setInterval(run, UNUSED_PERMISSIONS_SWEEP_INTERVAL_MS)
  }

  stop(): void {
    this.cancelFirstRun?.()
    this.cancelFirstRun = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The setting changed: switched on, the sweep catches up at once, as Chrome's does. */
  onSettingsChanged(): void {
    if (this.enabled()) this.run()
  }

  /**
   * One sweep at `now`: the model revokes (when the setting says so) and expires; a run that
   * changed the list pushes the state, so every window's revoked list and rules follow.
   */
  run(now: number = Date.now()): UnusedPermissionsSweepResult {
    const result = this.browser.permissions.sweepUnused(this.enabled(), now)
    if (result.revoked.length > 0 || result.expired > 0) this.browser.state.commitVolatile()
    return result
  }
}

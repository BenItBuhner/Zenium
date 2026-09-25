import { powerSaveBlocker } from 'electron'
import {
  isKeepAwakeLevel,
  POWER_BAD_LEVEL_ERROR,
  POWER_NO_PERMISSION_ERROR,
  POWER_PERMISSION,
  type KeepAwakeLevel
} from '../../../core/extensions/api/power'
import { ApiError, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/** The OS-level hold behind a keep-awake request, as Electron's `powerSaveBlocker` gives it. */
export interface SaveBlocker {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export function electronSaveBlocker(): SaveBlocker {
  return {
    start: (type) => powerSaveBlocker.start(type),
    stop: (id) => void powerSaveBlocker.stop(id),
    isStarted: (id) => powerSaveBlocker.isStarted(id)
  }
}

/** Chrome's `power.Level` onto the blocker Chromium holds for it (`PowerSaveBlocker` types). */
const BLOCKER_FOR: Record<KeepAwakeLevel, 'prevent-app-suspension' | 'prevent-display-sleep'> = {
  system: 'prevent-app-suspension',
  display: 'prevent-display-sleep'
}

/**
 * `chrome.power` for the desktop: `requestKeepAwake(level)` keeps the system (`'system'`) or the
 * display (`'display'`) from sleeping while the extension holds the request, through Electron's
 * power-save blocker; `releaseKeepAwake()` lets it go; the request goes with the extension when
 * it unloads (Chrome releases on unload). One request per extension: a second call replaces the
 * level, as Chrome's does. `reportActivity` is Chrome OS's alone and answers with nothing here,
 * as Chrome's does off Chrome OS. Gated on the `power` permission as granted; Chrome checks the
 * level against its enum before anything else.
 */
export class PowerApi {
  private readonly held = new Map<string, { level: KeepAwakeLevel; blockerId: number }>()

  constructor(
    private readonly host: ApiHost,
    private readonly blocker: SaveBlocker
  ) {}

  readonly handlers: NamespaceHandlers = {
    requestKeepAwake: (ctx, level) => this.request(ctx, level),
    releaseKeepAwake: (ctx) => this.release(ctx),
    reportActivity: (ctx) => this.reportActivity(ctx)
  }

  /** The level an extension holds, or null: what a probe of the row reads. */
  heldLevel(extensionId: string): KeepAwakeLevel | null {
    return this.held.get(extensionId)?.level ?? null
  }

  unload(extensionId: string): void {
    this.drop(extensionId)
  }

  private permitted(ctx: ApiContext): void {
    if (!this.host.grants(ctx.extensionId).permissions.includes(POWER_PERMISSION))
      throw new ApiError(POWER_NO_PERMISSION_ERROR)
  }

  private request(ctx: ApiContext, level: unknown): void {
    this.permitted(ctx)
    if (!isKeepAwakeLevel(level)) throw new ApiError(POWER_BAD_LEVEL_ERROR)
    const current = this.held.get(ctx.extensionId)
    if (current && current.level === level && this.blocker.isStarted(current.blockerId)) return
    // The new hold starts before the old one stops, so the level changes without a gap.
    const blockerId = this.blocker.start(BLOCKER_FOR[level])
    this.drop(ctx.extensionId)
    this.held.set(ctx.extensionId, { level, blockerId })
  }

  private release(ctx: ApiContext): void {
    this.permitted(ctx)
    this.drop(ctx.extensionId)
  }

  private reportActivity(ctx: ApiContext): void {
    this.permitted(ctx)
  }

  private drop(extensionId: string): void {
    const current = this.held.get(extensionId)
    if (!current) return
    this.held.delete(extensionId)
    if (this.blocker.isStarted(current.blockerId)) this.blocker.stop(current.blockerId)
  }
}

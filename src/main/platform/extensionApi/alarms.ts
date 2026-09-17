import {
  type Alarm,
  type AlarmCreateInfo,
  msUntilNext,
  rescheduleAlarm,
  scheduleAlarm,
  splitDue
} from '../../../core/extensions/api/alarms'
import { ApiError, isRecord, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/** Node refuses longer timeouts; a far-off alarm re-arms when this one fires. */
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * `chrome.alarms` owned by the browser layer: Electron accepts `alarms.create` but never fires
 * `onAlarm` in MV3 workers, so alarms live and tick here, survive restarts, and wake the worker
 * (or reach the MV2 background page) when they fire.
 */
export class AlarmsApi {
  private readonly alarms = new Map<string, Alarm[]>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    create: (ctx, name, info) => this.create(ctx, name, info),
    get: (ctx, name) => this.get(ctx, name),
    getAll: (ctx) => [...this.list(ctx.extensionId)],
    clear: (ctx, name) => this.clear(ctx, name),
    clearAll: (ctx) => this.clearAll(ctx)
  }

  private list(extensionId: string): Alarm[] {
    return this.alarms.get(extensionId) ?? []
  }

  private save(extensionId: string, alarms: Alarm[]): void {
    if (alarms.length === 0) this.alarms.delete(extensionId)
    else this.alarms.set(extensionId, alarms)
    this.host.store.setAlarms(extensionId, alarms)
    this.arm(extensionId)
  }

  private create(ctx: ApiContext, name: unknown, info: unknown): void {
    const alarmName = typeof name === 'string' ? name : ''
    if (!isRecord(info)) throw new ApiError('Invalid alarm info')
    const result = scheduleAlarm(alarmName, info as AlarmCreateInfo, {
      now: Date.now(),
      unpacked: ctx.extension.unpacked
    })
    if (!result.alarm) throw new ApiError(result.error)
    const others = this.list(ctx.extensionId).filter((a) => a.name !== alarmName)
    this.save(ctx.extensionId, [...others, result.alarm])
  }

  private get(ctx: ApiContext, name: unknown): Alarm | undefined {
    const alarmName = typeof name === 'string' ? name : ''
    const alarm = this.list(ctx.extensionId).find((a) => a.name === alarmName)
    return alarm ? { ...alarm } : undefined
  }

  private clear(ctx: ApiContext, name: unknown): boolean {
    const alarmName = typeof name === 'string' ? name : ''
    const before = this.list(ctx.extensionId)
    const after = before.filter((a) => a.name !== alarmName)
    if (after.length === before.length) return false
    this.save(ctx.extensionId, after)
    return true
  }

  private clearAll(ctx: ApiContext): boolean {
    const had = this.list(ctx.extensionId).length > 0
    this.save(ctx.extensionId, [])
    return had
  }

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  /** An extension came up: restore its persisted alarms and fire the ones missed while away. */
  load(extensionId: string): void {
    const persisted = this.host.store.alarms(extensionId)
    if (persisted.length === 0) return
    this.alarms.set(extensionId, [...persisted])
    this.arm(extensionId)
  }

  unload(extensionId: string): void {
    const timer = this.timers.get(extensionId)
    if (timer) clearTimeout(timer)
    this.timers.delete(extensionId)
    this.alarms.delete(extensionId)
  }

  forget(extensionId: string): void {
    this.unload(extensionId)
  }

  private arm(extensionId: string): void {
    const timer = this.timers.get(extensionId)
    if (timer) clearTimeout(timer)
    this.timers.delete(extensionId)
    const wait = msUntilNext(this.list(extensionId), Date.now())
    if (wait === null) return
    this.timers.set(
      extensionId,
      setTimeout(() => this.fire(extensionId), Math.min(wait, MAX_TIMEOUT_MS))
    )
  }

  private fire(extensionId: string): void {
    this.timers.delete(extensionId)
    const now = Date.now()
    const { due, pending } = splitDue(this.list(extensionId), now)
    const next = [...pending]
    for (const alarm of due) {
      this.host.dispatch(extensionId, 'alarms', 'onAlarm', [{ ...alarm }], { wake: true })
      const again = rescheduleAlarm(alarm, now)
      if (again) next.push(again)
    }
    this.save(extensionId, next)
  }

  flushSync(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

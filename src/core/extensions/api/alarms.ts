/**
 * `chrome.alarms` scheduling: Chrome's `when` / `delayInMinutes` / `periodInMinutes` rules, the
 * 30-second floor packed extensions get, and the rescheduling of periodic alarms. Pure functions;
 * the host owns the timers and the persistence.
 */

export interface AlarmCreateInfo {
  when?: number
  delayInMinutes?: number
  periodInMinutes?: number
}

export interface Alarm {
  name: string
  scheduledTime: number
  periodInMinutes?: number
}

/** Chrome refuses delays and periods below half a minute for packed extensions. */
export const MIN_PERIOD_MINUTES = 0.5

export interface ScheduleOptions {
  now: number
  /** Unpacked (developer-mode) extensions may schedule anything. */
  unpacked: boolean
}

/**
 * Turn `alarms.create` arguments into an alarm record, or an error message when Chrome would
 * reject them. Sub-minimum delays are clamped rather than rejected (Chrome logs a warning).
 */
export function scheduleAlarm(
  name: string,
  info: AlarmCreateInfo,
  options: ScheduleOptions
): { alarm: Alarm; error: null } | { alarm: null; error: string } {
  const { when, delayInMinutes, periodInMinutes } = info
  if (when !== undefined && delayInMinutes !== undefined) {
    return { alarm: null, error: 'Cannot set both when and delayInMinutes.' }
  }
  for (const [label, value] of [
    ['when', when],
    ['delayInMinutes', delayInMinutes],
    ['periodInMinutes', periodInMinutes]
  ] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      return { alarm: null, error: `Invalid value for ${label}.` }
    }
  }
  const minDelayMs = options.unpacked ? 0 : MIN_PERIOD_MINUTES * 60_000
  let scheduledTime: number
  if (when !== undefined) {
    scheduledTime = Math.max(when, options.now + minDelayMs)
  } else if (delayInMinutes !== undefined) {
    scheduledTime = options.now + Math.max(delayInMinutes * 60_000, minDelayMs)
  } else if (periodInMinutes !== undefined) {
    scheduledTime = options.now + Math.max(periodInMinutes * 60_000, minDelayMs)
  } else {
    return { alarm: null, error: 'Alarm needs when, delayInMinutes or periodInMinutes.' }
  }
  const alarm: Alarm = { name, scheduledTime }
  if (periodInMinutes !== undefined) {
    alarm.periodInMinutes = options.unpacked
      ? periodInMinutes
      : Math.max(periodInMinutes, MIN_PERIOD_MINUTES)
  }
  return { alarm, error: null }
}

/**
 * After an alarm fired at `now`: its next occurrence, or `null` when it was a one-shot. Missed
 * periods (the app was closed) collapse into a single firing, like Chrome.
 */
export function rescheduleAlarm(alarm: Alarm, now: number): Alarm | null {
  if (alarm.periodInMinutes === undefined) return null
  const period = alarm.periodInMinutes * 60_000
  let next = alarm.scheduledTime + period
  if (next <= now) next = now + period
  return { ...alarm, scheduledTime: next }
}

/** Alarms whose time has come (sorted by time), and those still pending. */
export function splitDue(
  alarms: readonly Alarm[],
  now: number
): { due: Alarm[]; pending: Alarm[] } {
  const due: Alarm[] = []
  const pending: Alarm[] = []
  for (const alarm of alarms) (alarm.scheduledTime <= now ? due : pending).push(alarm)
  due.sort((a, b) => a.scheduledTime - b.scheduledTime)
  return { due, pending }
}

/** Milliseconds until the earliest alarm (0 when one is already due), or null when there is none. */
export function msUntilNext(alarms: readonly Alarm[], now: number): number | null {
  if (alarms.length === 0) return null
  const next = Math.min(...alarms.map((a) => a.scheduledTime))
  return Math.max(0, next - now)
}

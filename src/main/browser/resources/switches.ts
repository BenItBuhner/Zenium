/**
 * Chromium / V8 command-line switches derived from the resource settings. They can only be set
 * before Electron's `ready` event, so they are read from the persisted profile at startup and a
 * change in Settings shows a "restart required" notice until the browser is relaunched.
 *
 * Pure module (no Electron) so the derivation is unit tested; `startup.ts` applies the result.
 */
import type { ResourceSettings } from '../../../shared/types'
import { DEFAULT_RESOURCE_SETTINGS } from '../../../shared/defaults'

export interface StartupSwitch {
  name: string
  value?: string
}

export interface StartupProfile {
  switches: StartupSwitch[]
  /** False → `app.disableHardwareAcceleration()`. */
  hardwareAcceleration: boolean
}

export const MAX_RENDERER_PROCESS_LIMIT = 64
export const MAX_RENDERER_HEAP_MB = 16384
export const MAX_RASTER_THREADS = 8

export function deriveStartupProfile(settings: ResourceSettings): StartupProfile {
  if (!settings.enabled) return { switches: [], hardwareAcceleration: true }
  const p = settings.process
  const switches: StartupSwitch[] = []
  const jsFlags: string[] = []
  const disabledFeatures: string[] = []

  if (p.rendererProcessLimit > 0) {
    switches.push({
      name: 'renderer-process-limit',
      value: String(Math.min(MAX_RENDERER_PROCESS_LIMIT, Math.round(p.rendererProcessLimit)))
    })
  }
  if (p.rendererHeapMb > 0) {
    jsFlags.push(
      `--max-old-space-size=${Math.min(MAX_RENDERER_HEAP_MB, Math.round(p.rendererHeapMb))}`
    )
  }
  if (p.v8OptimizeForSize) jsFlags.push('--optimize-for-size')
  if (p.lowEndDeviceMode) switches.push({ name: 'enable-low-end-device-mode' })
  // Electron already disables the spare renderer; listing it keeps the intent explicit.
  if (p.disableSpareRenderer) disabledFeatures.push('SpareRendererForSitePerProcess')
  if (p.disableBackForwardCache) disabledFeatures.push('BackForwardCache')
  if (p.disablePrerender) disabledFeatures.push('Prerender2')
  if (p.rasterThreads > 0) {
    switches.push({
      name: 'num-raster-threads',
      value: String(Math.min(MAX_RASTER_THREADS, Math.round(p.rasterThreads)))
    })
  }
  if (settings.gpuMemoryMb > 0) {
    const mb = Math.round(settings.gpuMemoryMb)
    switches.push({ name: 'force-gpu-mem-available-mb', value: String(mb) })
    switches.push({
      name: 'force-gpu-mem-discardable-limit-mb',
      value: String(Math.max(16, Math.round(mb / 2)))
    })
  }
  if (settings.gpuMode === 'low') {
    switches.push(
      { name: 'disable-gpu-rasterization' },
      { name: 'disable-accelerated-video-decode' },
      { name: 'disable-accelerated-2d-canvas' }
    )
  }
  if (jsFlags.length) switches.push({ name: 'js-flags', value: jsFlags.join(' ') })
  if (disabledFeatures.length)
    switches.push({ name: 'disable-features', value: disabledFeatures.join(',') })
  return { switches, hardwareAcceleration: settings.gpuMode !== 'off' }
}

/** Stable string form used to detect that the running process was started with other switches. */
export function serializeProfile(profile: StartupProfile): string {
  const parts = profile.switches
    .map((s) => (s.value === undefined ? `--${s.name}` : `--${s.name}=${s.value}`))
    .sort()
  parts.push(profile.hardwareAcceleration ? 'gpu:on' : 'gpu:off')
  return parts.join(' ')
}

export function profilesDiffer(a: StartupProfile, b: StartupProfile): boolean {
  return serializeProfile(a) !== serializeProfile(b)
}

/**
 * Deep-merge a persisted (possibly partial or malformed) `resources` block with the defaults and
 * clamp every number to a sane range. Used both by the startup reader and by settings updates.
 */
export function sanitizeResourceSettings(raw: unknown): ResourceSettings {
  const d = DEFAULT_RESOURCE_SETTINGS
  const r = isRecord(raw) ? raw : {}
  const p = isRecord(r.process) ? r.process : {}
  return {
    enabled: bool(r.enabled, d.enabled),
    enforcement: oneOf(r.enforcement, ['balanced', 'strict', 'extreme'], d.enforcement),
    memoryMb: int(r.memoryMb, d.memoryMb, 0, 1_048_576),
    memoryPercent: int(r.memoryPercent, d.memoryPercent, 5, 100),
    cpuPercent: int(r.cpuPercent, d.cpuPercent, 5, 100),
    gpuMemoryMb: int(r.gpuMemoryMb, d.gpuMemoryMb, 0, 65_536),
    gpuMode: oneOf(r.gpuMode, ['auto', 'low', 'off'], d.gpuMode),
    freezeAfterMinutes: int(r.freezeAfterMinutes, d.freezeAfterMinutes, 0, 24 * 60),
    idleFreezeMinutes: int(r.idleFreezeMinutes, d.idleFreezeMinutes, 0, 24 * 60),
    maxLoadedTabs: int(r.maxLoadedTabs, d.maxLoadedTabs, 0, 500),
    maxConcurrentLoads: int(r.maxConcurrentLoads, d.maxConcurrentLoads, 1, 16),
    batteryFactor: num(r.batteryFactor, d.batteryFactor, 0.25, 1),
    protectPinned: bool(r.protectPinned, d.protectPinned),
    protectEssentials: bool(r.protectEssentials, d.protectEssentials),
    protectAudible: bool(r.protectAudible, d.protectAudible),
    process: {
      rendererProcessLimit: int(
        p.rendererProcessLimit,
        d.process.rendererProcessLimit,
        0,
        MAX_RENDERER_PROCESS_LIMIT
      ),
      rendererHeapMb: int(p.rendererHeapMb, d.process.rendererHeapMb, 0, MAX_RENDERER_HEAP_MB),
      lowEndDeviceMode: bool(p.lowEndDeviceMode, d.process.lowEndDeviceMode),
      disableSpareRenderer: bool(p.disableSpareRenderer, d.process.disableSpareRenderer),
      disableBackForwardCache: bool(p.disableBackForwardCache, d.process.disableBackForwardCache),
      disablePrerender: bool(p.disablePrerender, d.process.disablePrerender),
      rasterThreads: int(p.rasterThreads, d.process.rasterThreads, 0, MAX_RASTER_THREADS),
      v8OptimizeForSize: bool(p.v8OptimizeForSize, d.process.v8OptimizeForSize)
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

function int(v: unknown, fallback: number, lo: number, hi: number): number {
  return Math.round(num(v, fallback, lo, hi))
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback
}

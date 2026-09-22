/**
 * `chrome.system.cpu` and `chrome.system.memory` in Chrome's shape (`CpuInfoProvider`,
 * `MemoryInfoProvider`), over what each host reads: the phone's `Runtime` / `ActivityManager`
 * and its `/proc` files where the app may read them, the desktop's `os` module. Chrome hides
 * each namespace from extensions that do not declare its permission; so does the shim, and the
 * hosts check again. Pure shaping here, so every host answers the same fields.
 */

export const SYSTEM_CPU_PERMISSION = 'system.cpu'
export const SYSTEM_MEMORY_PERMISSION = 'system.memory'

export const SYSTEM_CPU_NO_PERMISSION_ERROR =
  "The extension does not have the 'system.cpu' permission."
export const SYSTEM_MEMORY_NO_PERMISSION_ERROR =
  "The extension does not have the 'system.memory' permission."

/** Chrome's `system.cpu.CpuTime`: cumulative ticks, `total` the sum of the three. */
export interface CpuTime {
  user: number
  kernel: number
  idle: number
  total: number
}

/** Chrome's `system.cpu.CpuInfo`. */
export interface CpuInfo {
  numOfProcessors: number
  archName: string
  modelName: string
  features: string[]
  processors: Array<{ usage: CpuTime }>
  /** ChromeOS reads its thermal zones; every other platform answers none. */
  temperatures: number[]
}

/** Chrome's `system.memory.MemoryInfo`, both in bytes. */
export interface MemoryInfo {
  capacity: number
  availableCapacity: number
}

/** What a host reads for `system.cpu.getInfo`; the shaping below fills in what it left out. */
export interface RawCpuReading {
  numOfProcessors?: unknown
  archName?: unknown
  modelName?: unknown
  features?: unknown
  /** Per processor `[user, kernel, idle]` ticks, `user` with `nice` folded in as Chrome folds it. */
  usage?: unknown
}

/** What a host reads for `system.memory.getInfo`. */
export interface RawMemoryReading {
  capacity?: unknown
  availableCapacity?: unknown
}

/** The x86 features Chrome's `CpuInfoProvider` lists, in its order (ARM lists none). */
export const CPU_FEATURES = [
  'mmx',
  'sse',
  'sse2',
  'sse3',
  'ssse3',
  'sse4_1',
  'sse4_2',
  'avx'
] as const

/**
 * Chrome's `archName`: `base::SysInfo::OperatingSystemArchitecture()`, the machine name with
 * the i?86 family spelled `x86` and `amd64` spelled `x86_64`; `aarch64`, `armv7l`, `armv8l` as
 * the kernel (or Java's `os.arch`) spells them. Node's `x64` / `ia32` / `arm` are mapped too.
 */
export function chromeArchName(raw: string): string {
  const arch = raw.trim()
  if (/^i[3-6]86$/.test(arch) || arch === 'ia32' || arch === 'x86') return 'x86'
  if (arch === 'amd64' || arch === 'x64') return 'x86_64'
  return arch
}

/**
 * The features Chrome lists from a `/proc/cpuinfo` `flags` line (Linux spells SSE3 `pni`); an
 * ARM `Features` line yields none, as Chrome's ARM build lists none.
 */
export function cpuFeaturesFromFlags(flags: string): string[] {
  const present = new Set(flags.split(/\s+/).map((flag) => flag.toLowerCase()))
  if (present.has('pni')) present.add('sse3')
  return CPU_FEATURES.filter((feature) => present.has(feature))
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

const ticks = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

/** One processor's `CpuTime` from `[user, kernel, idle]`; anything else reads as no time counted. */
export function cpuTime(entry: unknown): CpuTime {
  const parts = Array.isArray(entry) ? entry : []
  const user = ticks(parts[0])
  const kernel = ticks(parts[1])
  const idle = ticks(parts[2])
  return { user, kernel, idle, total: user + kernel + idle }
}

/**
 * A host's reading shaped as Chrome's `CpuInfo`: as many `processors` entries as
 * `numOfProcessors` (a host that could not read the per-processor times, the phone's app
 * sandbox keeps `/proc/stat` from it, gives them all as zero), the architecture in Chrome's
 * spelling, the model name a string, the features Chrome's list in Chrome's order.
 */
export function cpuInfo(raw: RawCpuReading): CpuInfo {
  const usage = Array.isArray(raw.usage) ? raw.usage : []
  const numOfProcessors = Math.max(count(raw.numOfProcessors), usage.length, 1)
  const processors: Array<{ usage: CpuTime }> = []
  for (let i = 0; i < numOfProcessors; i++) processors.push({ usage: cpuTime(usage[i]) })
  const listed: unknown[] = Array.isArray(raw.features) ? raw.features : []
  const features = CPU_FEATURES.filter((feature) => listed.includes(feature))
  return {
    numOfProcessors,
    archName: chromeArchName(typeof raw.archName === 'string' ? raw.archName : ''),
    modelName: typeof raw.modelName === 'string' ? raw.modelName.trim() : '',
    features: [...features],
    processors,
    temperatures: []
  }
}

/** A host's reading shaped as Chrome's `MemoryInfo`: bytes, the available never over the capacity. */
export function memoryInfo(raw: RawMemoryReading): MemoryInfo {
  const capacity = ticks(raw.capacity)
  const availableCapacity = Math.min(ticks(raw.availableCapacity), capacity)
  return { capacity, availableCapacity }
}

/**
 * The per-processor times of a Linux `/proc/stat`: each `cpuN` line's `user nice system idle`
 * as Chrome's `CpuInfoProvider` reads it (`user + nice`, `system`, `idle`), in processor order;
 * an unreadable or foreign text yields none.
 */
export function procStatUsage(text: string): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  for (const line of text.split('\n')) {
    const match = /^cpu(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line)
    if (!match) continue
    out[Number(match[1])] = [
      Number(match[2]) + Number(match[3]),
      Number(match[4]),
      Number(match[5])
    ]
  }
  for (let i = 0; i < out.length; i++) out[i] ??= [0, 0, 0]
  return out
}

/**
 * What a Linux `/proc/cpuinfo` says of the model and the features: the first `model name`
 * (x86) or `Hardware` (ARM, as `base::CPU` falls back to) as the model, the first `flags` line
 * as the features. Either may be missing; the phone's sandbox may keep the file itself away.
 */
export function procCpuInfo(text: string): { modelName: string; features: string[] } {
  let modelName = ''
  let hardware = ''
  let features: string[] = []
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'model name' && !modelName) modelName = value
    else if (key === 'hardware' && !hardware) hardware = value
    else if (key === 'flags' && features.length === 0) features = cpuFeaturesFromFlags(value)
  }
  return { modelName: modelName || hardware, features }
}

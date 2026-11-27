import { readFileSync } from 'node:fs'
import { totalmem } from 'node:os'

/**
 * The memory this process may really use, in bytes: the machine's RAM, or less when the browser
 * runs inside a Linux control group with a memory limit (a container, a systemd unit with
 * `MemoryMax=`, a sandbox). `os.totalmem()` reports the whole machine's RAM inside a cgroup, so
 * a budget of "35 % of RAM" on a 16 GB host under a 512 MB limit would be 5.6 GB and the
 * governor would never act before the kernel's OOM killer did.
 *
 * Both cgroup versions are read: v2's `memory.max` and v1's `memory.limit_in_bytes`, for this
 * process's group and every ancestor up to the root (a limit set on a parent binds its
 * children; the smallest one wins). Anything unreadable or "unlimited" is skipped. Elsewhere
 * than Linux it is `totalmem()`.
 */
export function effectiveTotalMemory(
  read: (path: string) => string | null = readOrNull,
  machine: number = totalmem(),
  platform: NodeJS.Platform = process.platform
): number {
  if (platform !== 'linux') return machine
  const groups = read('/proc/self/cgroup')
  if (!groups) return machine
  let limit = machine
  for (const { version, path } of parseProcCgroup(groups)) {
    const [root, file] =
      version === 2
        ? ['/sys/fs/cgroup', 'memory.max']
        : ['/sys/fs/cgroup/memory', 'memory.limit_in_bytes']
    for (const dir of ancestors(path)) {
      const value = parseLimit(read(`${root}${dir === '/' ? '' : dir}/${file}`))
      if (value !== null && value < limit) limit = value
    }
  }
  return limit
}

/** `/proc/self/cgroup`'s lines that can carry a memory limit: v2's unified one, v1's `memory`. */
export function parseProcCgroup(text: string): Array<{ version: 1 | 2; path: string }> {
  const out: Array<{ version: 1 | 2; path: string }> = []
  for (const line of text.split('\n')) {
    const m = /^(\d+):([^:]*):(.*)$/.exec(line.trim())
    if (!m) continue
    const [, id, controllers, path] = m
    if (id === '0' && controllers === '') out.push({ version: 2, path: path || '/' })
    else if (controllers.split(',').includes('memory')) out.push({ version: 1, path: path || '/' })
  }
  return out
}

/** A limit file's value in bytes, or null for "max", an absurd v1 "unlimited" or junk. */
export function parseLimit(text: string | null): number | null {
  if (text === null) return null
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  // cgroup v1 spells "no limit" as the page-rounded maximum (9223372036854771712).
  if (!Number.isFinite(n) || n <= 0 || n >= 2 ** 60) return null
  return n
}

/** `/a/b/c` → `/a/b/c`, `/a/b`, `/a`, `/`. */
function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = parts.length; i >= 0; i--) out.push('/' + parts.slice(0, i).join('/'))
  return out
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

let cached: { at: number; bytes: number } | null = null

/** `effectiveTotalMemory()` in MB, re-read at most once a minute (a limit can be changed live). */
export function effectiveTotalMemoryMb(now = Date.now()): number {
  if (!cached || now - cached.at > 60_000) cached = { at: now, bytes: effectiveTotalMemory() }
  return cached.bytes / 1_048_576
}

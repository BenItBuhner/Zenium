// Memory of a whole process tree, read from /proc: PSS (proportional set size, which splits
// shared pages between the processes that map them, so it adds up to what the tree really
// costs) and the plain RSS sum (which counts shared pages once per process, the number most
// task managers show) from /proc/<pid>/smaps_rollup.
import { readFileSync, readdirSync } from 'node:fs'

function ppidMap() {
  const map = new Map()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      // Field 4 (ppid) comes after the parenthesised command, which may contain spaces.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      map.set(Number(name), Number(rest[1]))
    } catch {
      /* exited between readdir and read */
    }
  }
  return map
}

export function treePids(rootPid) {
  const parents = ppidMap()
  const children = new Map()
  for (const [pid, ppid] of parents) {
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const out = []
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop()
    if (!parents.has(pid)) continue
    out.push(pid)
    for (const c of children.get(pid) ?? []) stack.push(c)
  }
  return out
}

/** Every pid in a set of roots' trees (Chromium's zygote is re-parented on some systems). */
export function sampleTree(rootPids) {
  const pids = new Set()
  for (const root of rootPids) for (const pid of treePids(root)) pids.add(pid)
  let pssKb = 0
  let rssKb = 0
  let n = 0
  for (const pid of pids) {
    let text
    try {
      text = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    } catch {
      continue
    }
    const pss = /^Pss:\s+(\d+) kB/m.exec(text)
    const rss = /^Rss:\s+(\d+) kB/m.exec(text)
    if (!pss || !rss) continue
    pssKb += Number(pss[1])
    rssKb += Number(rss[1])
    n++
  }
  return { pssMb: pssKb / 1024, rssMb: rssKb / 1024, processes: n }
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/**
 * PSS of a process tree grouped by what each process is (Chromium's `--type=` and utility
 * sub-type, Firefox's `-contentproc` kind, otherwise "browser"), largest first.
 */
export function breakdown(rootPids) {
  const groups = {}
  const pids = new Set()
  for (const root of rootPids) for (const pid of treePids(root)) pids.add(pid)
  for (const pid of pids) {
    let cmd
    let text
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      // Chromium rewrites its title into one space-separated string.
      if (cmd.length === 1) cmd = cmd[0].split(' ')
      text = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    } catch {
      continue
    }
    const pss = Number(/^Pss:\s+(\d+) kB/m.exec(text)?.[1] ?? 0) / 1024
    const type = cmd.find((a) => a.startsWith('--type='))?.slice(7)
    const sub = cmd.find((a) => a.startsWith('--utility-sub-type='))?.slice(19)
    const ff = cmd.includes('-contentproc') ? `content:${cmd.at(-1)}` : null
    const key = ff ?? (sub ? `utility:${sub.split('.')[0]}` : (type ?? 'browser'))
    const g = (groups[key] ??= { count: 0, pssMb: 0 })
    g.count++
    g.pssMb += pss
  }
  return Object.fromEntries(
    Object.entries(groups)
      .map(([k, v]) => [k, { count: v.count, pssMb: Math.round(v.pssMb) }])
      .sort((a, b) => b[1].pssMb - a[1].pssMb)
  )
}

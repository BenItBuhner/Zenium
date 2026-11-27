import { describe, expect, it } from 'vitest'
import { effectiveTotalMemory, parseLimit, parseProcCgroup } from '../resources/memoryLimit'

/*
 * The memory budget's "share of RAM" is taken of the memory the browser may really use: a
 * container's or a systemd unit's cgroup limit when there is one, not the host's whole RAM
 * (`os.totalmem()` ignores cgroups).
 */

const GB = 1024 ** 3
const MB = 1024 ** 2

function fs(files: Record<string, string>): (path: string) => string | null {
  return (path) => files[path] ?? null
}

describe('effectiveTotalMemory', () => {
  it('takes a cgroup v2 limit on the process group', () => {
    const read = fs({
      '/proc/self/cgroup': '0::/user.slice/browser.scope\n',
      '/sys/fs/cgroup/user.slice/browser.scope/memory.max': `${512 * MB}\n`,
      '/sys/fs/cgroup/user.slice/memory.max': 'max\n'
    })
    expect(effectiveTotalMemory(read, 16 * GB, 'linux')).toBe(512 * MB)
  })

  it('takes the smallest limit among the ancestors', () => {
    const read = fs({
      '/proc/self/cgroup': '0::/a/b\n',
      '/sys/fs/cgroup/a/b/memory.max': `${4 * GB}`,
      '/sys/fs/cgroup/a/memory.max': `${2 * GB}`
    })
    expect(effectiveTotalMemory(read, 16 * GB, 'linux')).toBe(2 * GB)
  })

  it('reads cgroup v1 memory.limit_in_bytes and ignores its "unlimited" value', () => {
    const read = fs({
      '/proc/self/cgroup': '12:pids:/x\n9:memory:/zbench\n1:name=systemd:/x\n',
      '/sys/fs/cgroup/memory/zbench/memory.limit_in_bytes': `${512 * MB}`,
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712'
    })
    expect(effectiveTotalMemory(read, 16 * GB, 'linux')).toBe(512 * MB)
  })

  it('never reports more than the machine has', () => {
    const read = fs({
      '/proc/self/cgroup': '0::/big\n',
      '/sys/fs/cgroup/big/memory.max': `${64 * GB}`
    })
    expect(effectiveTotalMemory(read, 16 * GB, 'linux')).toBe(16 * GB)
  })

  it('is the machine total without cgroups or off Linux', () => {
    expect(effectiveTotalMemory(fs({}), 8 * GB, 'linux')).toBe(8 * GB)
    expect(effectiveTotalMemory(() => '0::/\n', 8 * GB, 'win32')).toBe(8 * GB)
  })
})

describe('parsing', () => {
  it('keeps the unified line and v1 memory lines only', () => {
    expect(parseProcCgroup('0::/\n4:memory,cpu:/a\n3:cpu:/b\n')).toEqual([
      { version: 2, path: '/' },
      { version: 1, path: '/a' }
    ])
  })

  it('treats max, junk and huge values as no limit', () => {
    expect(parseLimit('max')).toBeNull()
    expect(parseLimit('')).toBeNull()
    expect(parseLimit(null)).toBeNull()
    expect(parseLimit('9223372036854771712')).toBeNull()
    expect(parseLimit('536870912\n')).toBe(536870912)
  })
})

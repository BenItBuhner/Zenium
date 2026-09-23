import { describe, expect, it } from 'vitest'
import {
  chromeArchName,
  cpuFeaturesFromFlags,
  cpuInfo,
  cpuTime,
  memoryInfo,
  procCpuInfo,
  procStatUsage
} from '../api/systemInfo'

const PROC_STAT = `cpu  1000 50 300 9000 20 0 10 0 0 0
cpu0 600 30 200 4000 10 0 5 0 0 0
cpu1 400 20 100 5000 10 0 5 0 0 0
intr 12345 0 0
ctxt 99999
btime 1700000000
`

const PROC_CPUINFO_X86 = `processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz
flags\t\t: fpu vme mmx fxsr sse sse2 ss ht pni ssse3 sse4_1 sse4_2 avx avx2
processor\t: 1
model name\t: Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz
flags\t\t: fpu vme mmx fxsr sse sse2 ss ht pni ssse3 sse4_1 sse4_2 avx avx2
`

const PROC_CPUINFO_ARM = `processor\t: 0
BogoMIPS\t: 38.40
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp
CPU implementer\t: 0x51
Hardware\t: Qualcomm Technologies, Inc SM8550
`

describe('chrome.system.cpu shaping', () => {
  it("spells the architecture as Chrome's SysInfo does", () => {
    expect(chromeArchName('i686')).toBe('x86')
    expect(chromeArchName('i386')).toBe('x86')
    expect(chromeArchName('ia32')).toBe('x86')
    expect(chromeArchName('amd64')).toBe('x86_64')
    expect(chromeArchName('x64')).toBe('x86_64')
    expect(chromeArchName('x86_64')).toBe('x86_64')
    expect(chromeArchName('aarch64')).toBe('aarch64')
    expect(chromeArchName(' armv8l ')).toBe('armv8l')
    expect(chromeArchName('arm64')).toBe('arm64')
  })

  it("lists Chrome's x86 features from a flags line, in Chrome's order, sse3 from pni", () => {
    expect(
      cpuFeaturesFromFlags('fpu vme mmx fxsr sse sse2 ss ht pni ssse3 sse4_1 sse4_2 avx avx2')
    ).toEqual(['mmx', 'sse', 'sse2', 'sse3', 'ssse3', 'sse4_1', 'sse4_2', 'avx'])
    expect(cpuFeaturesFromFlags('AVX SSE2 MMX')).toEqual(['mmx', 'sse2', 'avx'])
    expect(cpuFeaturesFromFlags('fp asimd evtstrm aes')).toEqual([])
  })

  it('reads the per-processor times of /proc/stat with nice folded into user, and nothing from a foreign text', () => {
    expect(procStatUsage(PROC_STAT)).toEqual([
      [630, 200, 4000],
      [420, 100, 5000]
    ])
    expect(procStatUsage('')).toEqual([])
    expect(procStatUsage('Permission denied')).toEqual([])
    // A gap in the numbering (a processor offline) reads as no time counted.
    expect(procStatUsage('cpu0 1 1 1 1 0\ncpu2 2 2 2 2 0\n')).toEqual([
      [2, 1, 1],
      [0, 0, 0],
      [4, 2, 2]
    ])
  })

  it('reads the model and the features of /proc/cpuinfo, the ARM Hardware line as the model', () => {
    expect(procCpuInfo(PROC_CPUINFO_X86)).toEqual({
      modelName: 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz',
      features: ['mmx', 'sse', 'sse2', 'sse3', 'ssse3', 'sse4_1', 'sse4_2', 'avx']
    })
    expect(procCpuInfo(PROC_CPUINFO_ARM)).toEqual({
      modelName: 'Qualcomm Technologies, Inc SM8550',
      features: []
    })
    expect(procCpuInfo('')).toEqual({ modelName: '', features: [] })
  })

  it("shapes a host's reading as Chrome's CpuInfo, one processors entry per processor", () => {
    expect(cpuTime([1, 2, 3])).toEqual({ user: 1, kernel: 2, idle: 3, total: 6 })
    expect(cpuTime(null)).toEqual({ user: 0, kernel: 0, idle: 0, total: 0 })
    expect(cpuTime([-1, 'x', 2.7])).toEqual({ user: 0, kernel: 0, idle: 2, total: 2 })
    expect(
      cpuInfo({
        numOfProcessors: 2,
        archName: 'amd64',
        modelName: '  Intel(R) Core(TM) i7 ',
        features: ['avx', 'mmx', 'bogus'],
        usage: [[630, 200, 4000]]
      })
    ).toEqual({
      numOfProcessors: 2,
      archName: 'x86_64',
      modelName: 'Intel(R) Core(TM) i7',
      features: ['mmx', 'avx'],
      processors: [
        { usage: { user: 630, kernel: 200, idle: 4000, total: 4830 } },
        { usage: { user: 0, kernel: 0, idle: 0, total: 0 } }
      ],
      temperatures: []
    })
    // A reading with nothing in it is still one processor, as no machine has none.
    expect(cpuInfo({})).toEqual({
      numOfProcessors: 1,
      archName: '',
      modelName: '',
      features: [],
      processors: [{ usage: { user: 0, kernel: 0, idle: 0, total: 0 } }],
      temperatures: []
    })
    // More times than the count widens the count.
    expect(
      cpuInfo({
        numOfProcessors: 1,
        usage: [
          [1, 1, 1],
          [2, 2, 2]
        ]
      }).numOfProcessors
    ).toBe(2)
  })

  it("shapes memory as Chrome's MemoryInfo, bytes, the available capped at the capacity", () => {
    expect(memoryInfo({ capacity: 8 * 1024 ** 3, availableCapacity: 3 * 1024 ** 3 })).toEqual({
      capacity: 8 * 1024 ** 3,
      availableCapacity: 3 * 1024 ** 3
    })
    expect(memoryInfo({ capacity: 100, availableCapacity: 150 })).toEqual({
      capacity: 100,
      availableCapacity: 100
    })
    expect(memoryInfo({})).toEqual({ capacity: 0, availableCapacity: 0 })
  })
})

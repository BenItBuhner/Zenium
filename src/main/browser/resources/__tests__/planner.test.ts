import { describe, expect, it } from 'vitest'
import {
  DISCARD_TARGET,
  PURGE_COOLDOWN_MS,
  THROTTLE_COOLDOWN_MS,
  attribute,
  deriveBudgets,
  emptyPlannerMemory,
  nextThrottle,
  plan,
  previousThrottle,
  protectionReason,
  victimScore,
  type PlannerInput,
  type PlannerMemory,
  type ProcessSample,
  type SystemSample,
  type TabSample
} from '../planner'
import { DEFAULT_RESOURCE_SETTINGS } from '../../../../shared/defaults'
import type { ResourceSettings } from '../../../../shared/types'

const NOW = 1_700_000_000_000
const MINUTE = 60_000

function settings(overrides: Partial<ResourceSettings> = {}): ResourceSettings {
  return {
    ...structuredClone(DEFAULT_RESOURCE_SETTINGS),
    memoryMb: 1000,
    cpuPercent: 50,
    gpuMemoryMb: 0,
    freezeAfterMinutes: 5,
    idleFreezeMinutes: 0,
    maxLoadedTabs: 0,
    enforcement: 'balanced',
    ...overrides
  }
}

function tab(id: string, overrides: Partial<TabSample> = {}): TabSample {
  return {
    id,
    title: id,
    pids: [],
    loaded: true,
    visible: false,
    active: false,
    audible: false,
    mediaPlaying: false,
    loading: false,
    pinned: false,
    essential: false,
    excluded: false,
    devtoolsOpen: false,
    frozen: false,
    cpuThrottle: 1,
    lastActiveAt: NOW - MINUTE,
    lastPurgedAt: 0,
    lastThrottledAt: 0,
    ...overrides
  }
}

function proc(
  pid: number,
  memoryMb: number,
  cpuPercent = 0,
  type: ProcessSample['type'] = 'Tab'
): ProcessSample {
  return { pid, type, memoryMb, cpuPercent }
}

function system(overrides: Partial<SystemSample> = {}): SystemSample {
  return {
    totalMemoryMb: 16_000,
    cpuCount: 4,
    onBattery: false,
    idleSeconds: 0,
    windowMinimized: false,
    ...overrides
  }
}

function input(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    now: NOW,
    settings: settings(),
    unload: { enabled: true, timeoutMinutes: 20 },
    system: system(),
    processes: [],
    tabs: [],
    memory: emptyPlannerMemory(),
    ...overrides
  }
}

function memoryWith(over: Partial<Record<'memory' | 'cpu' | 'gpu', number>>): PlannerMemory {
  const m = emptyPlannerMemory()
  for (const [k, v] of Object.entries(over)) m.overStreak[k as 'memory'] = v
  return m
}

const kinds = (p: ReturnType<typeof plan>, kind: string): string[] =>
  p.actions.filter((a) => a.kind === kind).map((a) => a.tabId)

// ---------------------------------------------------------------------------

describe('deriveBudgets', () => {
  it('uses an explicit MB budget, else a percentage of RAM', () => {
    expect(deriveBudgets(settings({ memoryMb: 2048 }), system()).memory.budget).toBe(2048)
    expect(
      deriveBudgets(settings({ memoryMb: 0, memoryPercent: 25 }), system()).memory.budget
    ).toBe(4000)
  })

  it('treats 100% CPU and 0 MB GPU as unlimited', () => {
    const b = deriveBudgets(settings({ cpuPercent: 100, gpuMemoryMb: 0 }), system())
    expect(b.cpu.budget).toBe(0)
    expect(b.gpu.budget).toBe(0)
    expect(deriveBudgets(settings({ gpuMemoryMb: 512 }), system()).gpu.budget).toBe(512)
  })

  it('tightens every budget on battery but keeps the configured value', () => {
    const b = deriveBudgets(
      settings({ memoryMb: 1000, cpuPercent: 50, gpuMemoryMb: 500, batteryFactor: 0.5 }),
      system({ onBattery: true })
    )
    expect(b.memory).toEqual({ configured: 1000, budget: 500 })
    expect(b.cpu).toEqual({ configured: 50, budget: 25 })
    expect(b.gpu).toEqual({ configured: 500, budget: 250 })
  })
})

describe('attribute', () => {
  it('splits a shared renderer evenly and adds out-of-process iframes', () => {
    const tabs = [
      tab('a', { pids: [10, 30] }),
      tab('b', { pids: [10] }),
      tab('c', { loaded: false })
    ]
    const processes = [
      proc(1, 200, 40, 'Browser'),
      proc(2, 150, 0, 'GPU'),
      proc(10, 400, 100),
      proc(30, 100, 20),
      proc(99, 50, 0, 'Utility')
    ]
    const result = attribute(processes, tabs, 4)
    const a = result.usage.find((u) => u.tabId === 'a')!
    const b = result.usage.find((u) => u.tabId === 'b')!
    expect(a.memoryMb).toBe(300)
    expect(a.processes).toBe(2)
    expect(a.cpuPercent).toBe(17.5) // (50 + 20) / 4 cores
    expect(b.memoryMb).toBe(200)
    expect(b.cpuPercent).toBe(12.5)
    expect(result.overheadMb).toBe(400)
    expect(result.totalMemoryMb).toBe(900)
    expect(result.totalCpuPercent).toBe(40) // 160 / 4 cores
    expect(result.gpuMemoryMb).toBe(150)
  })

  it('never attributes processes to unloaded tabs', () => {
    const result = attribute([proc(10, 100)], [tab('a', { pids: [10], loaded: false })], 1)
    expect(result.usage[0].memoryMb).toBe(0)
    expect(result.overheadMb).toBe(100)
  })
})

describe('protection & ranking', () => {
  it('honours every protection switch', () => {
    const s = settings({ protectAudible: true, protectPinned: true, protectEssentials: true })
    expect(protectionReason(tab('x', { excluded: true }), s)).toBe('excluded domain')
    expect(protectionReason(tab('x', { devtoolsOpen: true }), s)).toBe('devtools open')
    expect(protectionReason(tab('x', { audible: true }), s)).toBe('playing audio')
    expect(protectionReason(tab('x', { pinned: true }), s)).toBe('pinned')
    expect(protectionReason(tab('x', { essential: true }), s)).toBe('essential')
    expect(protectionReason(tab('x'), s)).toBeNull()
    const loose = settings({
      protectAudible: false,
      protectPinned: false,
      protectEssentials: false
    })
    expect(
      protectionReason(tab('x', { audible: true, pinned: true, essential: true }), loose)
    ).toBeNull()
  })

  it('prefers bigger, older, regular tabs as victims', () => {
    const usage = (
      mb: number
    ): { tabId: string; memoryMb: number; cpuPercent: number; processes: number } => ({
      tabId: 'x',
      memoryMb: mb,
      cpuPercent: 0,
      processes: 1
    })
    const fresh = victimScore(tab('x', { lastActiveAt: NOW }), usage(100), 'memory', NOW)
    const old = victimScore(
      tab('x', { lastActiveAt: NOW - 30 * MINUTE }),
      usage(100),
      'memory',
      NOW
    )
    const big = victimScore(tab('x', { lastActiveAt: NOW }), usage(1000), 'memory', NOW)
    const pinned = victimScore(
      tab('x', { lastActiveAt: NOW, pinned: true }),
      usage(100),
      'memory',
      NOW
    )
    expect(old).toBeGreaterThan(fresh)
    expect(big).toBeGreaterThan(fresh)
    expect(pinned).toBeCloseTo(fresh / 2)
  })

  it('steps throttling 1 → 4 → 8 → 16 and back', () => {
    expect(nextThrottle(1)).toBe(4)
    expect(nextThrottle(4)).toBe(8)
    expect(nextThrottle(8)).toBe(16)
    expect(nextThrottle(16)).toBe(16)
    expect(previousThrottle(16)).toBe(8)
    expect(previousThrottle(4)).toBe(1)
    expect(previousThrottle(1)).toBe(1)
  })
})

describe('plan – time based rules', () => {
  it('freezes hidden tabs after the freeze timeout and unloads them after the unload timeout', () => {
    const p = plan(
      input({
        tabs: [
          tab('fresh', { lastActiveAt: NOW - 2 * MINUTE }),
          tab('stale', { lastActiveAt: NOW - 6 * MINUTE }),
          tab('ancient', { lastActiveAt: NOW - 25 * MINUTE }),
          tab('loading', { lastActiveAt: NOW - 6 * MINUTE, loading: true }),
          tab('shown', { lastActiveAt: NOW - 60 * MINUTE, visible: true, active: true })
        ]
      })
    )
    expect(kinds(p, 'freeze')).toEqual(['stale'])
    expect(kinds(p, 'discard')).toEqual(['ancient'])
    expect(p.actions.find((a) => a.tabId === 'loading')).toBeUndefined()
    expect(p.actions.find((a) => a.tabId === 'shown')).toBeUndefined()
    expect(p.pressure).toEqual([])
  })

  it('does not unload on the timer when Zen tab unloading is off, but still freezes', () => {
    const p = plan(
      input({
        unload: { enabled: false, timeoutMinutes: 20 },
        tabs: [tab('ancient', { lastActiveAt: NOW - 90 * MINUTE })]
      })
    )
    expect(kinds(p, 'discard')).toEqual([])
    expect(kinds(p, 'freeze')).toEqual(['ancient'])
  })

  it('leaves protected tabs alone and thaws frozen visible tabs', () => {
    const p = plan(
      input({
        tabs: [
          tab('audio', { lastActiveAt: NOW - 30 * MINUTE, audible: true }),
          tab('excluded', { lastActiveAt: NOW - 30 * MINUTE, excluded: true }),
          tab('devtools', { lastActiveAt: NOW - 30 * MINUTE, devtoolsOpen: true }),
          tab('shown', { visible: true, active: true, frozen: true })
        ]
      })
    )
    expect(p.actions.map((a) => [a.kind, a.tabId])).toEqual([['thaw', 'shown']])
  })

  it('freezes every hidden tab once the system is idle, and visible ones only in extreme mode', () => {
    const tabs = (): TabSample[] => [
      tab('hidden', { lastActiveAt: NOW }),
      tab('shown', { visible: true, active: true, lastActiveAt: NOW })
    ]
    const idle = system({ idleSeconds: 15 * 60 })
    const strict = plan(
      input({
        settings: settings({ idleFreezeMinutes: 10, enforcement: 'strict' }),
        system: idle,
        tabs: tabs()
      })
    )
    expect(kinds(strict, 'freeze')).toEqual(['hidden'])
    expect(strict.idle).toBe(true)
    const extreme = plan(
      input({
        settings: settings({ idleFreezeMinutes: 10, enforcement: 'extreme' }),
        system: idle,
        tabs: tabs()
      })
    )
    expect(kinds(extreme, 'freeze')).toEqual(['hidden', 'shown'])
    const awake = plan(
      input({
        settings: settings({ idleFreezeMinutes: 10, enforcement: 'extreme' }),
        system: system({ idleSeconds: 0 }),
        tabs: [tab('shown', { visible: true, active: true, frozen: true })]
      })
    )
    expect(kinds(awake, 'thaw')).toEqual(['shown'])
  })

  it('freezes hidden tabs within a minute when the window is minimised', () => {
    const p = plan(
      input({
        system: system({ windowMinimized: true }),
        tabs: [
          tab('hidden', { lastActiveAt: NOW - 61_000 }),
          tab('recent', { lastActiveAt: NOW - 10_000 })
        ]
      })
    )
    expect(kinds(p, 'freeze')).toEqual(['hidden'])
  })
})

describe('plan – live page cap', () => {
  it('discards the best hidden victims down to the cap and never a visible page', () => {
    const p = plan(
      input({
        settings: settings({ maxLoadedTabs: 3, memoryMb: 100_000 }),
        processes: [proc(1, 100), proc(2, 500), proc(3, 50), proc(4, 800), proc(5, 60)],
        tabs: [
          tab('shown', { visible: true, active: true, pids: [1] }),
          tab('big', { pids: [2], lastActiveAt: NOW - 2 * MINUTE }),
          tab('small', { pids: [3], lastActiveAt: NOW - 2 * MINUTE }),
          tab('huge', { pids: [4], lastActiveAt: NOW - 2 * MINUTE }),
          tab('tiny', { pids: [5], lastActiveAt: NOW - 2 * MINUTE })
        ]
      })
    )
    expect(kinds(p, 'discard')).toEqual(['huge', 'big'])
    expect(p.actions.map((a) => a.reason)).toContain('over the 3 live pages cap')
  })
})

describe('plan – memory ladder', () => {
  const tabs = (): TabSample[] => [
    tab('shown', { visible: true, active: true, pids: [1], lastActiveAt: NOW }),
    tab('a', { pids: [2], lastActiveAt: NOW - 2 * MINUTE }),
    tab('b', { pids: [3], lastActiveAt: NOW - 3 * MINUTE }),
    tab('c', { pids: [4], lastActiveAt: NOW - 4 * MINUTE })
  ]

  it('only purges on the first sample a little over budget', () => {
    const p = plan(
      input({
        processes: [proc(1, 400), proc(2, 250), proc(3, 250), proc(4, 200)], // 1100 > 1000
        tabs: tabs()
      })
    )
    expect(p.pressure).toEqual(['memory'])
    expect(p.memory.overStreak.memory).toBe(1)
    expect(kinds(p, 'discard')).toEqual([])
    expect(kinds(p, 'purge').sort()).toEqual(['a', 'b', 'c'])
    // Balanced mode never touches the visible page.
    expect(p.actions.find((a) => a.tabId === 'shown')).toBeUndefined()
  })

  it('discards by score until projected usage is under the target once sustained', () => {
    const p = plan(
      input({
        processes: [proc(1, 400), proc(2, 250), proc(3, 250), proc(4, 200)],
        tabs: tabs(),
        memory: memoryWith({ memory: 1 })
      })
    )
    // c is oldest but smallest; b (250 MB, 3 min) outranks a (250 MB, 2 min) and c (200 MB, 4 min).
    const discards = kinds(p, 'discard')
    expect(discards[0]).toBe('b')
    let projected = 1100
    for (const id of discards) projected -= id === 'c' ? 200 : 250
    expect(projected).toBeLessThanOrEqual(1000 * DISCARD_TARGET)
    // Survivors are purged, discarded tabs are not.
    for (const id of kinds(p, 'purge')) expect(discards).not.toContain(id)
  })

  it('acts immediately on a large overage', () => {
    const p = plan(
      input({
        processes: [proc(1, 400), proc(2, 600), proc(3, 250), proc(4, 200)], // 1450 > 1250
        tabs: tabs()
      })
    )
    expect(kinds(p, 'discard').length).toBeGreaterThan(0)
  })

  it('respects the purge cooldown and skips frozen pages', () => {
    const p = plan(
      input({
        processes: [proc(1, 400), proc(2, 250), proc(3, 250), proc(4, 200)],
        tabs: [
          tab('shown', { visible: true, active: true, pids: [1] }),
          tab('a', { pids: [2], lastPurgedAt: NOW - PURGE_COOLDOWN_MS / 2 }),
          tab('b', { pids: [3], frozen: true }),
          tab('c', { pids: [4] })
        ]
      })
    )
    expect(kinds(p, 'purge')).toEqual(['c'])
  })

  it('purges visible pages in strict mode when hidden pages are not enough', () => {
    const p = plan(
      input({
        settings: settings({ enforcement: 'strict' }),
        processes: [proc(1, 1500), proc(2, 50)],
        tabs: [
          tab('shown', { visible: true, active: true, pids: [1] }),
          tab('pane', { visible: true, pids: [2] })
        ],
        memory: memoryWith({ memory: 1 })
      })
    )
    expect(kinds(p, 'purge').sort()).toEqual(['pane', 'shown'])
    const balanced = plan(
      input({
        processes: [proc(1, 1500)],
        tabs: [tab('shown', { visible: true, active: true, pids: [1] })],
        memory: memoryWith({ memory: 1 })
      })
    )
    expect(balanced.actions).toEqual([])
  })

  it('reloads the active page in extreme mode after it alone exceeded the budget three times', () => {
    const shown = tab('shown', { visible: true, active: true, pids: [1] })
    const base = input({
      settings: settings({ enforcement: 'extreme' }),
      processes: [proc(1, 1500)],
      tabs: [shown]
    })
    let memory = emptyPlannerMemory()
    const seen: string[][] = []
    for (let i = 0; i < 3; i++) {
      const p = plan({ ...base, memory })
      memory = p.memory
      seen.push(p.actions.map((a) => a.kind))
      // The governor stamps purged tabs; the planner itself never mutates its input.
      if (p.actions.some((a) => a.kind === 'purge')) shown.lastPurgedAt = NOW
    }
    expect(seen[0]).toEqual(['purge'])
    expect(seen[1]).toEqual([]) // purge cooldown
    expect(seen[2]).toEqual(['reload'])
    expect(memory.activeOverStreak).toBe(0)
  })

  it('does nothing while the governor is disabled', () => {
    const p = plan(
      input({
        settings: settings({ enabled: false }),
        processes: [proc(1, 5000), proc(2, 5000)],
        tabs: [
          tab('shown', { visible: true, active: true, pids: [1] }),
          tab('a', { pids: [2], lastActiveAt: 0 })
        ]
      })
    )
    expect(p.actions).toEqual([])
    expect(p.pressure).toEqual([])
  })

  it('"free up memory now" discards every eligible hidden page', () => {
    const p = plan(
      input({
        force: true,
        processes: [proc(1, 100), proc(2, 100), proc(3, 100)],
        tabs: [
          tab('shown', { visible: true, active: true, pids: [1] }),
          tab('a', { pids: [2] }),
          tab('protected', { pids: [3], excluded: true })
        ]
      })
    )
    expect(kinds(p, 'discard')).toEqual(['a'])
    expect(p.pressure).toEqual(['memory', 'cpu', 'gpu'])
  })
})

describe('plan – cpu ladder', () => {
  const cpuTabs = (over: Partial<TabSample> = {}): TabSample[] => [
    tab('shown', { visible: true, active: true, pids: [1], lastActiveAt: NOW }),
    tab('miner', { pids: [2], lastActiveAt: NOW, ...over }),
    tab('quiet', { pids: [3], lastActiveAt: NOW })
  ]
  // 4 cores: shown 130%, miner 80%, quiet 1% → 52.75% of the machine against a 50% budget.
  const processes = [proc(1, 100, 130), proc(2, 100, 80), proc(3, 100, 1)]

  it('waits for a sustained overage before throttling small overages', () => {
    const first = plan(input({ processes, tabs: cpuTabs() }))
    expect(first.pressure).toEqual(['cpu'])
    expect(first.actions).toEqual([])
    const second = plan(input({ processes, tabs: cpuTabs(), memory: memoryWith({ cpu: 1 }) }))
    expect(second.actions).toEqual([
      expect.objectContaining({ kind: 'throttle', tabId: 'miner', rate: 4 })
    ])
  })

  it('freezes a hidden page outright when it alone burns the whole budget', () => {
    // miner at 200% of one core = 50% of the machine, against a 50% budget.
    const hog = [proc(1, 100, 10), proc(2, 100, 200), proc(3, 100, 1)]
    const first = plan(input({ processes: hog, tabs: cpuTabs() }))
    expect(first.actions).toEqual([
      expect.objectContaining({ kind: 'throttle', tabId: 'miner', rate: 4 })
    ])
    const sustained = plan(
      input({ processes: hog, tabs: cpuTabs(), memory: memoryWith({ cpu: 1 }) })
    )
    expect(sustained.actions).toEqual([expect.objectContaining({ kind: 'freeze', tabId: 'miner' })])
  })

  it('freezes instead of throttling a hidden page that shares its renderer with a visible one', () => {
    // One renderer at 250% of a core shared by both pages → 31% each, 63% of the machine in total.
    const shared = [proc(1, 100, 250), proc(3, 100, 1)]
    const tabs = (): TabSample[] => [
      tab('shown', { visible: true, active: true, pids: [1] }),
      tab('sibling', { pids: [1], lastActiveAt: NOW }),
      tab('quiet', { pids: [3] })
    ]
    const p = plan(input({ processes: shared, tabs: tabs(), memory: memoryWith({ cpu: 3 }) }))
    expect(kinds(p, 'throttle')).toEqual([])
    expect(p.actions).toEqual([expect.objectContaining({ kind: 'freeze', tabId: 'sibling' })])
  })

  it('throttles a single page right away when it alone burns more than half the budget', () => {
    // miner at 200% = half the machine, well over 25% (half of the 50% budget).
    const p = plan(
      input({ processes: [proc(1, 100, 10), proc(2, 100, 200), proc(3, 100, 1)], tabs: cpuTabs() })
    )
    expect(p.actions).toEqual([
      expect.objectContaining({ kind: 'throttle', tabId: 'miner', rate: 4 })
    ])
  })

  it('escalates 4 → 8 → 16 → freeze → discard and respects the cooldown', () => {
    const sustained = memoryWith({ cpu: 5 })
    const at8 = plan(input({ processes, tabs: cpuTabs({ cpuThrottle: 4 }), memory: sustained }))
    expect(at8.actions[0]).toMatchObject({ kind: 'throttle', rate: 8 })
    const cooling = plan(
      input({
        processes,
        tabs: cpuTabs({ cpuThrottle: 4, lastThrottledAt: NOW - THROTTLE_COOLDOWN_MS / 2 }),
        memory: sustained
      })
    )
    expect(cooling.actions).toEqual([])
    const frozen = plan(input({ processes, tabs: cpuTabs({ cpuThrottle: 16 }), memory: sustained }))
    expect(frozen.actions[0]).toMatchObject({ kind: 'freeze', tabId: 'miner' })
    const gone = plan(input({ processes, tabs: cpuTabs({ frozen: true }), memory: sustained }))
    expect(gone.actions[0]).toMatchObject({ kind: 'discard', tabId: 'miner' })
  })

  it('throttles visible panes only in strict mode and the active tab only in extreme mode', () => {
    const tabs = (): TabSample[] => [
      tab('shown', { visible: true, active: true, pids: [1] }),
      tab('pane', { visible: true, pids: [2] })
    ]
    const heavy = [proc(1, 100, 150), proc(2, 100, 150)] // 75% of 4 cores
    const balanced = plan(input({ processes: heavy, tabs: tabs(), memory: memoryWith({ cpu: 3 }) }))
    expect(balanced.actions).toEqual([])
    const strict = plan(
      input({
        settings: settings({ enforcement: 'strict' }),
        processes: heavy,
        tabs: tabs(),
        memory: memoryWith({ cpu: 3 })
      })
    )
    expect(strict.actions).toEqual([
      expect.objectContaining({ kind: 'throttle', tabId: 'pane', rate: 2 })
    ])
    const extreme = plan(
      input({
        settings: settings({ enforcement: 'extreme' }),
        processes: heavy,
        tabs: tabs(),
        memory: memoryWith({ cpu: 3 })
      })
    )
    expect(kinds(extreme, 'throttle').sort()).toEqual(['pane', 'shown'])
  })

  it('relaxes throttling: visible pages at once, hidden pages one step after a calm streak', () => {
    const calm = [proc(1, 100, 4), proc(2, 100, 4)]
    const tabs = (): TabSample[] => [
      tab('shown', { visible: true, active: true, pids: [1], cpuThrottle: 2 }),
      tab('hidden', { pids: [2], cpuThrottle: 16, lastActiveAt: NOW })
    ]
    const early = plan(input({ processes: calm, tabs: tabs() }))
    expect(early.actions).toEqual([
      expect.objectContaining({ kind: 'unthrottle', tabId: 'shown', rate: 1 })
    ])
    const m = emptyPlannerMemory()
    m.underStreak.cpu = 3
    const later = plan(input({ processes: calm, tabs: tabs(), memory: m }))
    expect(kinds(later, 'unthrottle').sort()).toEqual(['hidden', 'shown'])
    expect(later.actions.find((a) => a.tabId === 'hidden')?.rate).toBe(8)
  })
})

describe('plan – gpu ladder', () => {
  it('pauses muted background media, purges, and discards one page per cycle once sustained', () => {
    // GPU at 560 MB against a 500 MB budget: over, but not by the 25% that triggers action at once.
    const processes = [
      proc(1, 100, 0, 'Browser'),
      proc(50, 560, 0, 'GPU'),
      proc(2, 100),
      proc(3, 100)
    ]
    const tabs = (): TabSample[] => [
      tab('shown', { visible: true, active: true, pids: [1] }),
      tab('video', { pids: [2], mediaPlaying: true, lastActiveAt: NOW }),
      tab('old', { pids: [3], lastActiveAt: NOW - 3 * MINUTE })
    ]
    const first = plan(input({ settings: settings({ gpuMemoryMb: 500 }), processes, tabs: tabs() }))
    expect(first.pressure).toEqual(['gpu'])
    expect(kinds(first, 'pause-media')).toEqual(['video'])
    expect(kinds(first, 'purge')).toEqual(['old'])
    expect(kinds(first, 'discard')).toEqual([])
    const sustained = plan(
      input({
        settings: settings({ gpuMemoryMb: 500 }),
        processes,
        tabs: tabs(),
        memory: memoryWith({ gpu: 1 })
      })
    )
    expect(kinds(sustained, 'discard')).toEqual(['old'])
  })
})

describe('plan – streaks', () => {
  it('counts consecutive over / under samples per resource', () => {
    const over = plan(
      input({
        processes: [proc(1, 1200)],
        tabs: [tab('shown', { visible: true, active: true, pids: [1] })]
      })
    )
    expect(over.memory.overStreak.memory).toBe(1)
    expect(over.memory.underStreak.memory).toBe(0)
    const under = plan(
      input({
        processes: [proc(1, 100)],
        tabs: [tab('shown', { visible: true, active: true, pids: [1] })],
        memory: over.memory
      })
    )
    expect(under.memory.overStreak.memory).toBe(0)
    expect(under.memory.underStreak.memory).toBe(1)
    // Unlimited resources always count as comfortably under.
    expect(under.memory.underStreak.gpu).toBe(2)
  })
})

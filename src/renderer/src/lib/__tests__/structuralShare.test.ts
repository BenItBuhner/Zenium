import { describe, expect, it } from 'vitest'
import { shareUnchanged } from '../structuralShare'

/*
 * The snapshots' structural sharing (W8-A1-PERF): a fresh snapshot comes back as a tree in
 * which every subtree that did not change is the previous snapshot's object, and only that –
 * the values the chrome reads are the fresh snapshot's, whichever object holds them. Copy-on-
 * write: the fresh snapshot is never written (on Android it is the core's own objects, handed
 * to every listener as one), nor is the previous one.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Freezes every plain object and array in `value`, so any write throws (modules are strict). */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

describe('shareUnchanged', () => {
  it('hands back a fresh root whose unchanged children are the previous snapshot’s', () => {
    const prev = {
      tabs: {
        a: { id: 'a', title: 'A', loading: false },
        b: { id: 'b', title: 'B', loading: true }
      },
      order: ['a', 'b'],
      settings: { theme: 'dark', zoom: 1 }
    }
    const next = clone(prev)
    next.tabs.b.loading = false
    const out = shareUnchanged(prev, next)
    expect(out).not.toBe(prev)
    expect(out.tabs.a).toBe(prev.tabs.a)
    expect(out.tabs.b).toBe(next.tabs.b)
    expect(out.order).toBe(prev.order)
    expect(out.settings).toBe(prev.settings)
    expect(out).toEqual({
      ...prev,
      tabs: { ...prev.tabs, b: { id: 'b', title: 'B', loading: false } }
    })
  })

  it('keeps a wholly unchanged snapshot’s children, and still hands back a fresh root', () => {
    const prev = { tabs: { a: { id: 'a' } }, order: ['a'], n: 1, s: 'x', nil: null }
    const next = clone(prev)
    const out = shareUnchanged(prev, next)
    expect(out).not.toBe(prev)
    expect(out.tabs).toBe(prev.tabs)
    expect(out.order).toBe(prev.order)
    expect(out).toEqual(prev)
    const prevList = [{ id: 1 }, { id: 2 }]
    const nextList = clone(prevList)
    const list = shareUnchanged(prevList, nextList)
    expect(list).not.toBe(prevList)
    expect(list).not.toBe(nextList)
    expect(list[0]).toBe(prevList[0])
    expect(list[1]).toBe(prevList[1])
    expect(list).toEqual(prevList)
  })

  it('never writes into the fresh snapshot or the previous one', () => {
    const prev = deepFreeze({
      tabs: { a: { id: 'a', n: 1 }, b: { id: 'b', n: 1 } },
      list: [{ id: 1 }, { id: 2 }, { id: 3 }],
      same: { deep: { x: 1 } }
    })
    const next = deepFreeze(clone(prev))
    const fresh = clone(next)
    const out = shareUnchanged(prev, next)
    expect(next).toEqual(fresh)
    expect(next.tabs.a).not.toBe(prev.tabs.a)
    expect(next.list[0]).not.toBe(prev.list[0])
    expect(out.tabs).toBe(prev.tabs)
    expect(out.list).toBe(prev.list)
    expect(out.same).toBe(prev.same)

    const changed = deepFreeze({
      tabs: { a: { id: 'a', n: 1 }, b: { id: 'b', n: 2 } },
      list: [{ id: 1 }, { id: 5 }, { id: 3 }],
      same: { deep: { x: 1 } }
    })
    const changedFresh = clone(changed)
    const out2 = shareUnchanged(prev, changed)
    expect(changed).toEqual(changedFresh)
    expect(changed.tabs.a).not.toBe(prev.tabs.a)
    expect(changed.list[0]).not.toBe(prev.list[0])
    expect(out2.tabs.a).toBe(prev.tabs.a)
    expect(out2.tabs.b).toBe(changed.tabs.b)
    expect(out2.list[0]).toBe(prev.list[0])
    expect(out2.list[1]).toBe(changed.list[1])
    expect(out2.list[2]).toBe(prev.list[2])
    expect(out2.same).toBe(prev.same)
    expect(out2).toEqual(changedFresh)
  })

  it('a changed child yields a new parent whose unchanged siblings are the previous snapshot’s', () => {
    const prev = {
      tabs: { a: { id: 'a', x: { y: 1 } }, b: { id: 'b', x: { y: 1 } }, c: { id: 'c' } },
      list: [{ id: 1, x: { y: 1 } }, { id: 2 }, { id: 3 }]
    }
    const next = clone(prev)
    next.tabs.b.x.y = 2
    next.list[1] = { id: 2, extra: true } as (typeof next.list)[number]
    const out = shareUnchanged(prev, next)
    expect(out.tabs).not.toBe(prev.tabs)
    expect(out.tabs).not.toBe(next.tabs)
    expect(out.tabs.a).toBe(prev.tabs.a)
    expect(out.tabs.b).toBe(next.tabs.b)
    expect(out.tabs.c).toBe(prev.tabs.c)
    expect(Object.keys(out.tabs)).toEqual(['a', 'b', 'c'])
    expect(out.list).not.toBe(prev.list)
    expect(out.list).not.toBe(next.list)
    expect(out.list[0]).toBe(prev.list[0])
    expect(out.list[1]).toBe(next.list[1])
    expect(out.list[2]).toBe(prev.list[2])
    expect(out).toEqual(clone(next))
    expect(next.tabs.a).not.toBe(prev.tabs.a)
    expect(next.list[0]).not.toBe(prev.list[0])
  })

  it('rebuilds only the path to a change', () => {
    const prev = {
      a: { b: { c: 1, d: { e: 1 } }, f: { g: 1 } },
      h: { i: 1 }
    }
    const next = clone(prev)
    next.a.b.c = 2
    const out = shareUnchanged(prev, next)
    expect(out.a).not.toBe(prev.a)
    expect(out.a).not.toBe(next.a)
    expect(out.a.b).not.toBe(prev.a.b)
    expect(out.a.b.c).toBe(2)
    expect(out.a.b.d).toBe(prev.a.b.d)
    expect(out.a.f).toBe(prev.a.f)
    expect(out.h).toBe(prev.h)
    expect(out).toEqual(clone(next))
  })

  it('takes the fresh node itself wherever a key, its order, a length or a leaf differs and nothing below it is shared', () => {
    const prev: Record<string, unknown> = {
      added: { a: 1 },
      removed: { a: 1, b: 2 },
      reordered: { a: 1, b: 2 },
      longer: [1, 2],
      shorter: [1, 2, 3],
      leaf: { v: 1 },
      kind: { v: 1 },
      undef: { v: undefined }
    }
    const next: Record<string, unknown> = {
      added: { a: 1, b: 2 },
      removed: { a: 1 },
      reordered: { b: 2, a: 1 },
      longer: [1, 2, 3],
      shorter: [1, 2],
      leaf: { v: 2 },
      kind: { v: '1' },
      undef: { v: null }
    }
    const fresh = clone(next)
    const out = shareUnchanged(prev, next)
    expect(out).toBe(next)
    for (const key of Object.keys(next)) {
      expect(out[key]).toBe(next[key])
    }
    expect(out).toEqual(fresh)
    expect(Object.keys(out.reordered as object)).toEqual(['b', 'a'])
  })

  it('treats anything but a plain object or array as a leaf, same only by identity', () => {
    const date = new Date(0)
    const map = new Map([['k', 1]])
    const prev = { date: new Date(0), map: new Map([['k', 1]]), same: date, sameMap: map }
    const next = { date: new Date(0), map: new Map([['k', 1]]), same: date, sameMap: map }
    const out = shareUnchanged(prev, next)
    expect(out.date).toBe(next.date)
    expect(out.map).toBe(next.map)
    expect(out.same).toBe(date)
    expect(out.sameMap).toBe(map)
  })

  it('tells an array from an object and a null from an object at the same key', () => {
    const prev = {
      a: [1, 2] as unknown,
      b: { x: 1 } as unknown,
      c: null as unknown,
      d: { x: 1 } as unknown
    }
    const next = {
      a: { 0: 1, 1: 2 } as unknown,
      b: [1] as unknown,
      c: { x: 1 } as unknown,
      d: null as unknown
    }
    const out = shareUnchanged(prev, next)
    expect(out.a).toBe(next.a)
    expect(out.b).toBe(next.b)
    expect(out.c).toBe(next.c)
    expect(out.d).toBeNull()
    expect(Array.isArray(out.a)).toBe(false)
  })

  it('keeps NaN and signed zeros as the fresh snapshot carries them', () => {
    const prev = { nan: { v: NaN }, zero: { v: 0 } }
    const next = { nan: { v: NaN }, zero: { v: -0 } }
    const out = shareUnchanged(prev, next)
    expect(out.nan).toBe(prev.nan)
    expect(out.zero).toBe(next.zero)
    expect(Object.is(out.zero.v, -0)).toBe(true)
  })

  it('keeps a copied node’s prototype: a null-prototype record stays one', () => {
    const prev = {
      bare: Object.assign(Object.create(null) as Record<string, unknown>, { a: { x: 1 }, b: 1 })
    }
    const next = {
      bare: Object.assign(Object.create(null) as Record<string, unknown>, { a: { x: 1 }, b: 2 })
    }
    const out = shareUnchanged(prev, next)
    expect(out.bare).not.toBe(prev.bare)
    expect(out.bare).not.toBe(next.bare)
    expect(Object.getPrototypeOf(out.bare)).toBeNull()
    expect(out.bare.a).toBe(prev.bare.a)
    expect(out.bare.b).toBe(2)
  })

  it('hands the fresh snapshot back untouched without a previous one', () => {
    const next = { tabs: { a: { id: 'a' } } }
    const fresh = clone(next)
    expect(shareUnchanged(null, next)).toBe(next)
    expect(shareUnchanged(undefined, next)).toBe(next)
    expect(next).toEqual(fresh)
    expect(shareUnchanged(next, next)).toBe(next)
  })
})

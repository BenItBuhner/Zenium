import { describe, expect, it } from 'vitest'
import { shareUnchanged } from '../structuralShare'

/*
 * The snapshots' structural sharing (W8-A1-PERF): a fresh snapshot keeps the identity of every
 * subtree that did not change, and only that – the values the chrome reads are the fresh
 * snapshot's, whichever object holds them.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('shareUnchanged', () => {
  it('returns the fresh root, with each unchanged child the previous snapshot’s object', () => {
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
    expect(out).toBe(next)
    expect(out.tabs).toBe(next.tabs)
    expect(out.tabs.a).toBe(prev.tabs.a)
    expect(out.tabs.b).toBe(next.tabs.b)
    expect(out.order).toBe(prev.order)
    expect(out.settings).toBe(prev.settings)
    expect(out).toEqual({
      ...prev,
      tabs: { ...prev.tabs, b: { id: 'b', title: 'B', loading: false } }
    })
  })

  it('keeps a wholly unchanged snapshot’s children, and still hands back the fresh root', () => {
    const prev = { tabs: { a: { id: 'a' } }, order: ['a'], n: 1, s: 'x', nil: null }
    const next = clone(prev)
    const out = shareUnchanged(prev, next)
    expect(out).toBe(next)
    expect(out.tabs).toBe(prev.tabs)
    expect(out.order).toBe(prev.order)
    expect(out).toEqual(prev)
  })

  it('takes the fresh node wherever a key, its order, a length or a leaf differs', () => {
    const prev = {
      added: { a: 1 },
      removed: { a: 1, b: 2 },
      reordered: { a: 1, b: 2 },
      longer: [1, 2],
      shorter: [1, 2, 3],
      leaf: { v: 1 },
      kind: { v: 1 },
      undef: { v: undefined }
    }
    const next = {
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
    for (const key of Object.keys(next) as Array<keyof typeof next>) {
      expect(out[key]).toBe(next[key])
    }
    expect(out).toEqual(fresh)
    expect(Object.keys(out.reordered)).toEqual(['b', 'a'])
  })

  it('shares the unchanged items of a changed array, and the unchanged fields of a changed object', () => {
    const prev = {
      list: [{ id: 1, x: { y: 1 } }, { id: 2 }, { id: 3 }],
      obj: { a: { b: 1 }, c: 2 }
    }
    const next = clone(prev)
    next.list[1] = { id: 2, extra: true } as (typeof next.list)[number]
    next.obj.c = 3
    const out = shareUnchanged(prev, next)
    expect(out.list).toBe(next.list)
    expect(out.list[0]).toBe(prev.list[0])
    expect(out.list[1]).toBe(next.list[1])
    expect(out.list[2]).toBe(prev.list[2])
    expect(out.obj).toBe(next.obj)
    expect(out.obj.a).toBe(prev.obj.a)
    expect(out.obj.c).toBe(3)
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

  it('hands the fresh snapshot back untouched without a previous one', () => {
    const next = { tabs: { a: { id: 'a' } } }
    const fresh = clone(next)
    expect(shareUnchanged(null, next)).toBe(next)
    expect(shareUnchanged(undefined, next)).toBe(next)
    expect(next).toEqual(fresh)
    expect(shareUnchanged(next, next)).toBe(next)
  })
})

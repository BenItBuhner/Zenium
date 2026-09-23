// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createRef, useLayoutEffect, useRef, type JSX, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@renderer/lib/api', () => ({ cmd: vi.fn(async () => null), run: vi.fn() }))

const { FAKEBOX_PILL_VAR, FAKEBOX_VAR, fakeboxScrolled, fakeboxScrubTravel, registerFakebox } =
  await import('@renderer/lib/fakeboxMorph')
const { useFakeboxSurface } = await import('../useFakeboxSurface')

/*
 * The hook's runtime (hooks/useFakeboxSurface.ts): a component's element takes the new tab page
 * morph's two values on its own inline style for as long as it is mounted – neither inherits
 * from the root (main.css, `@property`), so a rule reading them on the element sees these values
 * or the properties' initial 0. Which elements must use the hook, and the registry's own
 * runtime, are `lib/__tests__/fakeboxSurfaces.test.ts`'s.
 */

function Surface({ surfaceRef }: { surfaceRef?: RefObject<HTMLDivElement | null> }): JSX.Element {
  const own = useRef<HTMLDivElement>(null)
  const ref = surfaceRef ?? own
  useFakeboxSurface(ref)
  return <div ref={ref} className="surface" />
}

let root: Root | null = null
let mount: HTMLElement | null = null
const releases: Array<() => void> = []

function render(tree: JSX.Element = <Surface />): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(tree))
  return mount.querySelector<HTMLElement>('.surface')!
}

/** A new tab page's field registered as the page mounts it: 52 tall at 200 from the top. */
function page(): { scrub: (fraction: number) => void; release: () => void } {
  const column = document.createElement('div')
  column.className = 'zen-ntp-scroll zen-ntp-fades'
  const field = document.createElement('div')
  field.className = 'zen-ntp-field'
  column.appendChild(field)
  document.body.appendChild(column)
  Object.defineProperty(field, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 16,
      top: 200,
      width: 380,
      height: 52,
      x: 16,
      y: 200,
      right: 396,
      bottom: 252
    })
  })
  const unregister = registerFakebox('t', field, column)
  const release = (): void => {
    unregister()
    column.remove()
  }
  releases.push(release)
  return {
    scrub: (fraction) => act(() => fakeboxScrolled(fakeboxScrubTravel()! * fraction)),
    release
  }
}

const values = (el: HTMLElement): [string, string] => [
  el.style.getPropertyValue(FAKEBOX_VAR),
  el.style.getPropertyValue(FAKEBOX_PILL_VAR)
]

/**
 * Mounted after a surface in the same commit: reports what a layout effect of its own finds on
 * the surface – React runs the layout effects of one commit in tree order, the surface's before
 * this one's, and every one of them before the browser paints, while a passive effect (`useEffect`)
 * runs after the commit, after this reads, and may run after the paint.
 */
function Probe({
  of,
  seen
}: {
  of: RefObject<HTMLElement | null>
  seen: (found: [string, string]) => void
}): null {
  useLayoutEffect(() => {
    seen(values(of.current!))
  }, [of, seen])
  return null
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  for (const r of releases.splice(0)) r()
})

describe('useFakeboxSurface', () => {
  it('writes both values on the element while a page is registered, every frame the scrub moves, and nothing before or after', () => {
    const el = render()
    expect(values(el)).toEqual(['', ''])
    const p = page()
    expect(values(el)).toEqual(['0.0000', '0.0000'])
    p.scrub(0.85)
    expect(values(el)).toEqual(['0.0000', '0.5000'])
    p.scrub(1)
    expect(values(el)).toEqual(['0.0000', '1.0000'])
    act(() => p.release())
    expect(values(el)).toEqual(['', ''])
  })

  it('an element mounting under a page part way through the scrub carries the pose before it paints (a layout effect): a layout effect mounted beside it in the same commit already reads the values', () => {
    const p = page()
    p.scrub(0.85)
    const surface = createRef<HTMLDivElement>()
    const seen: Array<[string, string]> = []
    const el = render(
      <>
        <Surface surfaceRef={surface} />
        <Probe of={surface} seen={(found) => seen.push(found)} />
      </>
    )
    // Were the hook a passive effect, the probe's layout effect would find the element bare
    // ('' / '') and the values would arrive only after the commit – a frame of 0 on the surface.
    expect(seen).toEqual([['0.0000', '0.5000']])
    expect(surface.current).toBe(el)
    expect(values(el)).toEqual(['0.0000', '0.5000'])
  })

  it('unmounting releases the element: the next frames leave it alone', () => {
    const el = render()
    const p = page()
    p.scrub(0.85)
    expect(values(el)).toEqual(['0.0000', '0.5000'])
    act(() => root!.unmount())
    root = null
    expect(values(el)).toEqual(['', ''])
    p.scrub(1)
    expect(values(el)).toEqual(['', ''])
  })
})

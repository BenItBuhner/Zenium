// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, type JSX } from 'react'
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

function Surface(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFakeboxSurface(ref)
  return <div ref={ref} className="surface" />
}

let root: Root | null = null
let mount: HTMLElement | null = null
const releases: Array<() => void> = []

function render(): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Surface />))
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
    value: () => ({ left: 16, top: 200, width: 380, height: 52, x: 16, y: 200, right: 396, bottom: 252 })
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

  it('an element mounting under a page part way through the scrub carries the pose before it paints (a layout effect)', () => {
    const p = page()
    p.scrub(0.85)
    const el = render()
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

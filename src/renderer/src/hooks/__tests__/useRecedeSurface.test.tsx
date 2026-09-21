// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, useRef, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { registerRecedeLayer, type RecedeHandle } from '@renderer/lib/motion/recede'
import { useRecedeSurface } from '../useRecedeSurface'

/*
 * The hook's runtime (hooks/useRecedeSurface.ts): a component's element takes the recede's value
 * on its own inline style for as long as it is mounted – `--zen-recede` does not inherit from
 * the root (main.css, `@property`), so a rule reading it on the element sees this value or the
 * property's initial 0. Which elements must use the hook is `lib/__tests__/recedeSurfaces.test.ts`'s
 * (the stylesheets' readers, paired over the source); the registry's arithmetic is `recede.test.ts`'s.
 */

function Surface(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useRecedeSurface(ref)
  return <div ref={ref} className="surface" />
}

let root: Root | null = null
let mount: HTMLElement | null = null
const handles: RecedeHandle[] = []

function render(): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Surface />))
  return mount.querySelector<HTMLElement>('.surface')!
}

function layer(): RecedeHandle {
  const h = registerRecedeLayer()
  handles.push(h)
  return h
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  for (const h of handles.splice(0)) h.release()
})

describe('useRecedeSurface', () => {
  it('writes the value on the element every frame a sheet is up, and nothing before or after', () => {
    const el = render()
    expect(el.style.getPropertyValue('--zen-recede')).toBe('')
    const h = layer()
    expect(el.style.getPropertyValue('--zen-recede')).toBe('0.0000')
    act(() => h.progress(0.5))
    expect(el.style.getPropertyValue('--zen-recede')).toBe('0.5000')
    act(() => h.progress(1))
    expect(el.style.getPropertyValue('--zen-recede')).toBe('1.0000')
    act(() => h.release())
    expect(el.style.getPropertyValue('--zen-recede')).toBe('')
  })

  it('a surface mounting under a sheet already up carries the value before it paints (a layout effect)', () => {
    const h = layer()
    h.progress(0.8)
    const el = render()
    expect(el.style.getPropertyValue('--zen-recede')).toBe('0.8000')
  })

  it('unmounting releases the element: the next frames leave it alone', () => {
    const el = render()
    const h = layer()
    act(() => h.progress(0.4))
    expect(el.style.getPropertyValue('--zen-recede')).toBe('0.4000')
    act(() => root!.unmount())
    root = null
    expect(el.style.getPropertyValue('--zen-recede')).toBe('')
    act(() => h.progress(0.9))
    expect(el.style.getPropertyValue('--zen-recede')).toBe('')
  })
})

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { useChromeSurface } from '../useChromeSurface'

/*
 * A chrome surface that answers a page (hooks/useChromeSurface.ts): the component tells the core
 * it is up while mounted and takes that back on unmount (`ui.surface`), so the core holds a
 * page's request – a picker, a share, an install prompt – open only where a chrome can answer it,
 * and answers as a cancel would elsewhere. A component that is the surface on some hosts only
 * registers on those alone.
 */

function Picker({ mounted }: { mounted?: boolean }): null {
  useChromeSurface('screenCapture', mounted)
  return null
}

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.mocked(run).mockClear()
})

function mount(element: ReturnType<typeof createElement>): void {
  root = createRoot(document.createElement('div'))
  act(() => root!.render(element))
}

describe('useChromeSurface', () => {
  it('registers the surface as the component mounts and takes it back as it unmounts', () => {
    mount(createElement(Picker))
    expect(vi.mocked(run).mock.calls).toEqual([
      ['ui.surface', { surface: 'screenCapture', mounted: true }]
    ])
    act(() => root!.unmount())
    root = null
    expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
      'ui.surface',
      { surface: 'screenCapture', mounted: false }
    ])
  })

  it('registers nothing for a component that is not the surface on this host', () => {
    mount(createElement(Picker, { mounted: false }))
    expect(vi.mocked(run)).not.toHaveBeenCalled()
    act(() => root?.unmount())
    root = null
    expect(vi.mocked(run)).not.toHaveBeenCalled()
  })

  it('follows a component that becomes the surface later', () => {
    mount(createElement(Picker, { mounted: false }))
    expect(vi.mocked(run)).not.toHaveBeenCalled()
    act(() => root!.render(createElement(Picker, { mounted: true })))
    expect(vi.mocked(run).mock.calls).toEqual([
      ['ui.surface', { surface: 'screenCapture', mounted: true }]
    ])
  })
})

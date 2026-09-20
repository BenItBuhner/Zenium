// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, useRef, useState, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { usePopover } from '../usePopover'

/*
 * The chassis's keyboard hook (v2 draft §9.22): focus moves into the popover once, when it
 * becomes active – to the element the caller names – and stays where the user put it through
 * the re-renders that follow (a state push repaints the popover; callers pass `initial` inline,
 * a fresh function each time, and that is not a reason to take the keyboard back). Escape and the
 * return of focus on unmount are exercised with the surfaces that use them.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
})

/** A popover with a field and a second control; `version` is a state push that repaints it. */
function Popover({ active, version }: { active: boolean; version: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  usePopover(ref, {
    onClose: () => undefined,
    active,
    // Inline, as the surfaces write it: a new function on every render.
    initial: () => fieldRef.current
  })
  return (
    <div ref={ref} role="dialog" tabIndex={-1} data-version={version}>
      <input ref={fieldRef} data-field />
      <button type="button" data-swatch>
        Swatch
      </button>
    </div>
  )
}

function Harness({ active = true }: { active?: boolean }): JSX.Element {
  const [version, setVersion] = useState(0)
  return (
    <>
      <button type="button" data-push onClick={() => setVersion((v) => v + 1)}>
        push
      </button>
      <Popover active={active} version={version} />
    </>
  )
}

describe('usePopover', () => {
  it('focuses the element `initial` names once the popover is active', () => {
    const el = render(<Harness />)
    expect(document.activeElement).toBe(el.querySelector('[data-field]'))
  })

  it('does not take the keyboard back on a re-render with a fresh `initial`', () => {
    const el = render(<Harness />)
    const swatch = el.querySelector<HTMLElement>('[data-swatch]')!
    act(() => swatch.focus())
    expect(document.activeElement).toBe(swatch)
    act(() => el.querySelector<HTMLElement>('[data-push]')!.click())
    expect(el.querySelector('[role="dialog"]')?.getAttribute('data-version')).toBe('1')
    expect(document.activeElement).toBe(swatch)
  })

  it('waits for `active` before moving focus in', () => {
    const el = render(<Harness active={false} />)
    expect(document.activeElement).not.toBe(el.querySelector('[data-field]'))
    act(() => root!.render(<Harness active />))
    expect(document.activeElement).toBe(el.querySelector('[data-field]'))
  })
})

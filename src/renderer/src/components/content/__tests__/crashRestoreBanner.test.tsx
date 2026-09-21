// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
 * "Restore pages?" on the frame's band (desktop shell pass (c), M6): the strip the
 * default-browser banner draws – a window surface, the sentence, no glyph, no `data-control` set
 * by hand (§9.34) – with Dismiss before the primary Restore (§9.11), each answering the core.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: vi.fn(),
  onEvent: () => () => undefined
}))

const { CrashRestoreBanner } = await import('../CrashRestoreBanner')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  run.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const band = (): HTMLElement => container.querySelector<HTMLElement>('[data-crash-restore]')!
const buttons = (): HTMLButtonElement[] => [...band().querySelectorAll('button')]
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the Restore pages band', () => {
  it('is the frame strip: a window surface with the sentence, no glyph, no data-control of its own', () => {
    act(() => root.render(<CrashRestoreBanner offer={{ tabCount: 3, windowCount: 2 }} />))
    const el = band()
    expect(el.classList.contains('zen-frame-strip')).toBe(true)
    expect(el.getAttribute('data-surface')).toBe('window')
    expect(el.getAttribute('role')).toBe('status')
    // Flush with the frame: the band is the root, in no padded wrapper.
    expect(container.firstElementChild).toBe(el)
    expect(el.querySelector('svg')).toBeNull()
    expect(container.querySelector('[data-control]')).toBeNull()
    expect(el.querySelector('.zen-frame-strip-text')!.textContent).toBe(
      'Zenium did not shut down correctly. Restore 3 pages in 2 windows?'
    )
  })

  it('counts one page and one window in the singular, the window unsaid', () => {
    act(() => root.render(<CrashRestoreBanner offer={{ tabCount: 1, windowCount: 1 }} />))
    expect(band().querySelector('.zen-frame-strip-text')!.textContent).toBe(
      'Zenium did not shut down correctly. Restore 1 page?'
    )
  })

  it('offers Dismiss then the primary Restore as v2 buttons, each answering the core', () => {
    act(() => root.render(<CrashRestoreBanner offer={{ tabCount: 2, windowCount: 1 }} />))
    const [dismiss, restore] = buttons()
    expect(buttons()).toHaveLength(2)
    expect(dismiss.textContent).toBe('Dismiss')
    expect(dismiss.classList.contains('zen-v2-button')).toBe(true)
    expect(dismiss.hasAttribute('data-primary')).toBe(false)
    expect(restore.textContent).toBe('Restore')
    expect(restore.classList.contains('zen-v2-button')).toBe(true)
    expect(restore.hasAttribute('data-primary')).toBe(true)
    click(restore)
    expect(run).toHaveBeenLastCalledWith('session.crashRestore', { restore: true })
    click(dismiss)
    expect(run).toHaveBeenLastCalledWith('session.crashRestore', { restore: false })
  })
})

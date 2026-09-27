// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BrowsingDataRange, BrowsingDataType } from '@shared/types'

const cmd = vi.fn<(name: string, args?: unknown) => Promise<unknown>>()
vi.mock('@renderer/lib/api', () => ({
  cmd: (name: string, args?: unknown) => cmd(name, args),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
const pushToast = vi.fn<(message: string) => number>(() => 1)
vi.mock('@renderer/lib/ui', () => ({ pushToast: (message: string) => pushToast(message) }))

import { RANGE_OPTIONS } from '@renderer/lib/browsingData'
import { useClearForm } from '../useClearForm'

/*
 * The Delete browsing data form's done toast (W8-7, round two): the shared hook hands the range
 * it just cleared to `clearedToast`, so the desktop dialog and the phone's sheet both read Chrome
 * Android's quick-delete line – "Last hour deleted" … "Last 4 weeks deleted", "Deleted" for all
 * time – in the picker's own words, whatever types were ticked.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The form's picker and primary as buttons: pick a range, then Delete data. */
function Probe({ onDone }: { onDone: () => void }): JSX.Element {
  const form = useClearForm(onDone)
  return createElement(
    'div',
    null,
    ...RANGE_OPTIONS.map((o) =>
      createElement('button', {
        key: o.value,
        type: 'button',
        'data-range': o.value,
        onClick: () => form.setRange(o.value)
      })
    ),
    createElement('button', { type: 'button', 'data-submit': '', onClick: () => form.submit() })
  )
}

let root: Root
let container: HTMLDivElement
const onDone = vi.fn()

function answer(cleared: BrowsingDataType[]): void {
  cmd.mockImplementation(async (name) => {
    if (name === 'privacy.clearBrowsingDataCounts') return []
    if (name === 'privacy.clearBrowsingData') return { status: 'ok', value: { cleared } }
    return null
  })
}

function press(selector: string): void {
  const button = container.querySelector<HTMLButtonElement>(selector)
  if (!button) throw new Error(`no ${selector}`)
  button.click()
}

async function clear(range: BrowsingDataRange): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { onDone }))
  })
  await act(async () => {
    press(`[data-range="${range}"]`)
  })
  await act(async () => {
    press('[data-submit]')
  })
}

beforeEach(() => {
  cmd.mockReset()
  pushToast.mockClear()
  onDone.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useClearForm’s done toast', () => {
  it('names the period it cleared in the picker’s words, never the types', async () => {
    answer(['history', 'cookies', 'cache'])
    await clear('month')
    expect(cmd).toHaveBeenCalledWith(
      'privacy.clearBrowsingData',
      expect.objectContaining({ range: 'month', types: ['history', 'cookies', 'cache'] })
    )
    expect(pushToast).toHaveBeenCalledTimes(1)
    expect(pushToast).toHaveBeenCalledWith('Last 4 weeks deleted')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('reads the default range’s line – "Last hour deleted" – with no range chosen', async () => {
    answer(['history'])
    await clear('hour')
    expect(pushToast).toHaveBeenCalledWith('Last hour deleted')
  })

  it('reads "Deleted" alone for all time', async () => {
    answer(['history', 'cookies', 'cache'])
    await clear('all')
    expect(pushToast).toHaveBeenCalledWith('Deleted')
  })

  it('reads "Nothing deleted" when the core cleared nothing', async () => {
    answer([])
    await clear('day')
    expect(pushToast).toHaveBeenCalledWith('Nothing deleted')
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

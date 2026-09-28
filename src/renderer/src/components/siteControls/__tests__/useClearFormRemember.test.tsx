// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BrowsingDataRange, UIState } from '@shared/types'

const cmd = vi.fn<(name: string, args?: unknown) => Promise<unknown>>()
const run = vi.fn<(name: string, args?: unknown) => void>()
vi.mock('@renderer/lib/api', () => ({
  cmd: (name: string, args?: unknown) => cmd(name, args),
  run: (name: string, args?: unknown) => run(name, args),
  onEvent: vi.fn(() => () => undefined)
}))
vi.mock('@renderer/lib/ui', () => ({ pushToast: vi.fn(() => 1) }))

import { RANGE_OPTIONS } from '@renderer/lib/browsingData'
import { browserStore } from '@renderer/lib/browserStore'
import { QUICK_DELETE_FORM, useClearForm, type ClearFormOptions } from '../useClearForm'

/*
 * The Delete browsing data dialog remembers the last period (services pass 13, seed #20) as
 * Chrome's desktop dialog remembers `browser.clear_data.time_period`: the form opens on the
 * range the user last deleted with (`Settings.clearBrowsingDataRange`, the last hour until
 * then) and a Delete writes the range it goes with – before the clear, whatever the clear then
 * says (`clear_browsing_data_dialog.ts` `onDeleteBrowsingDataClick_`: `timePicker.
 * sendPrefChange()`, then `clearBrowsingData`). A pick alone is not remembered (Chrome's
 * `onTimePeriodClick_` moves the selection only), a range already remembered is not written
 * again, and the phone's Quick Delete form opens on its fixed 15 minutes and writes nothing.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The form's picker and primary as buttons, the current range on the root. */
function Probe({ options }: { options?: ClearFormOptions }): JSX.Element {
  const form = useClearForm(() => undefined, options)
  return createElement(
    'div',
    { 'data-current': form.form.range },
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

/** The chrome's mirror of the core's state, with the remembered range alone filled in. */
function remembered(range: BrowsingDataRange | undefined): void {
  browserStore.set({
    state:
      range === undefined
        ? null
        : ({ settings: { clearBrowsingDataRange: range } } as unknown as UIState)
  })
}

function answer(outcome: unknown): void {
  cmd.mockImplementation(async (name) => {
    if (name === 'privacy.clearBrowsingDataCounts') return []
    if (name === 'privacy.clearBrowsingData') return outcome
    return null
  })
}

const current = (): string | null =>
  container.firstElementChild?.getAttribute('data-current') ?? null

async function render(options?: ClearFormOptions): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { options }))
  })
}

async function press(selector: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(selector)
  if (!button) throw new Error(`no ${selector}`)
  await act(async () => {
    button.click()
  })
}

const settingsWrites = (): unknown[] =>
  run.mock.calls.filter(([name]) => name === 'settings.update').map(([, args]) => args)

beforeEach(() => {
  cmd.mockReset()
  run.mockReset()
  answer({ status: 'ok', value: { cleared: ['history'] } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  browserStore.set({ state: null })
})

describe('the desktop dialog remembers the last period (seed #20)', () => {
  it('opens on the range the user last deleted with, and reads the counts for it', async () => {
    remembered('week')
    await render()
    expect(current()).toBe('week')
    expect(cmd).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'week' })
    expect(cmd).not.toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'hour' })
  })

  it('opens on the last hour before any deletion – the setting’s default – and before the state is loaded', async () => {
    remembered('hour')
    await render()
    expect(current()).toBe('hour')
    act(() => root.unmount())
    root = createRoot(container)

    remembered(undefined)
    await render()
    expect(current()).toBe('hour')
    expect(cmd).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'hour' })
  })

  it('a Delete writes the range it goes with, before the clear is asked for', async () => {
    remembered('hour')
    await render()
    await press('[data-range="all"]')
    expect(settingsWrites()).toEqual([])

    await press('[data-submit]')
    expect(settingsWrites()).toEqual([{ clearBrowsingDataRange: 'all' }])
    const write =
      run.mock.invocationCallOrder[run.mock.calls.findIndex(([n]) => n === 'settings.update')]
    const clearAt = cmd.mock.calls.findIndex(([n]) => n === 'privacy.clearBrowsingData')
    expect(clearAt).toBeGreaterThanOrEqual(0)
    expect(write).toBeLessThan(cmd.mock.invocationCallOrder[clearAt] ?? 0)
    expect(cmd).toHaveBeenCalledWith(
      'privacy.clearBrowsingData',
      expect.objectContaining({ range: 'all' })
    )
  })

  it('a pick alone is not remembered: a look at another range and no Delete writes nothing', async () => {
    remembered('week')
    await render()
    await press('[data-range="all"]')
    await press('[data-range="day"]')
    expect(current()).toBe('day')
    expect(cmd).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'day' })
    expect(settingsWrites()).toEqual([])
  })

  it('a Delete with the range already remembered writes nothing again', async () => {
    remembered('week')
    await render()
    await press('[data-submit]')
    expect(cmd).toHaveBeenCalledWith(
      'privacy.clearBrowsingData',
      expect.objectContaining({ range: 'week' })
    )
    expect(settingsWrites()).toEqual([])
  })

  it('a Delete the vault stops for its passphrase has remembered the range already, as Chrome commits the period before the clear', async () => {
    answer({ status: 'passphrase' })
    remembered('hour')
    await render()
    await press('[data-range="month"]')
    await press('[data-submit]')
    expect(settingsWrites()).toEqual([{ clearBrowsingDataRange: 'month' }])
  })
})

describe('the phone’s Quick Delete form keeps its own 15 minutes', () => {
  it('opens on the 15 minutes whatever the desktop remembered, and its Delete writes nothing', async () => {
    remembered('week')
    await render(QUICK_DELETE_FORM)
    expect(current()).toBe('15min')
    expect(cmd).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: '15min' })

    await press('[data-range="all"]')
    await press('[data-submit]')
    expect(cmd).toHaveBeenCalledWith(
      'privacy.clearBrowsingData',
      expect.objectContaining({ range: 'all' })
    )
    expect(settingsWrites()).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })
})

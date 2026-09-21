// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
 * Settings › Downloads › Location asks the engine where downloads go right now
 * (`download.directory`) while the section is open, and again once the setting moves – a
 * Change… or Use default – so the line shows the resolved path as Chrome's row does (HB-20).
 */

type Invoke = (name: string, args?: unknown) => Promise<unknown>
const invoke = vi.fn<Invoke>(async () => '/home/me/Downloads')
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useDownloadDirectory } = await import('../downloadDirectory')

let root: Root | null = null
let host: HTMLElement | null = null
let seen: Array<string | null> = []

function Probe({ enabled, setting }: { enabled: boolean; setting: string | null }): null {
  seen.push(useDownloadDirectory(enabled, setting))
  return null
}

async function render(enabled: boolean, setting: string | null): Promise<void> {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => root?.render(createElement(Probe, { enabled, setting })))
}

beforeEach(() => {
  invoke.mockClear()
  seen = []
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('useDownloadDirectory', () => {
  it('asks the engine while enabled and hands the path over; asks nothing while not', async () => {
    await render(false, null)
    expect(invoke).not.toHaveBeenCalled()
    expect(seen.at(-1)).toBeNull()
    await render(true, null)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('download.directory', undefined)
    expect(seen.at(-1)).toBe('/home/me/Downloads')
  })

  it('asks again when the setting moves, and reads an unusable answer as empty', async () => {
    await render(true, null)
    expect(invoke).toHaveBeenCalledTimes(1)
    invoke.mockResolvedValueOnce('/home/me/Files')
    await render(true, '/home/me/Files')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(seen.at(-1)).toBe('/home/me/Files')
    // The same setting again asks nothing more.
    await render(true, '/home/me/Files')
    expect(invoke).toHaveBeenCalledTimes(2)
    invoke.mockRejectedValueOnce(new Error('no host'))
    await render(true, null)
    expect(seen.at(-1)).toBe('')
  })
})

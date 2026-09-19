// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  claimChromeShortcut,
  offerChromeShortcut,
  resetChromeShortcutClaims,
  useChromeShortcut
} from '../chromeShortcuts'

/*
 * Chrome shortcuts a page tab claims (lib/chromeShortcuts.ts): the chrome offers a claimable
 * event to the pages' claims before acting on it; the latest claim answers first; a claim that
 * declines passes the event on; nothing claimed keeps the chrome's meaning.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const find = { tabId: 't1', text: '' }

beforeEach(() => resetChromeShortcutClaims())

describe('claimChromeShortcut / offerChromeShortcut', () => {
  it('leaves an event no one claimed to the chrome', () => {
    expect(offerChromeShortcut('find.open', find)).toBe(false)
  })

  it('hands the event to a claim that takes it, with the payload', () => {
    const claim = vi.fn(() => true)
    claimChromeShortcut('find.open', claim)
    expect(offerChromeShortcut('find.open', { tabId: 't1', text: '', again: 'next' })).toBe(true)
    expect(claim).toHaveBeenCalledWith({ tabId: 't1', text: '', again: 'next' })
  })

  it('asks the latest claim first and passes on what it declines', () => {
    const order: string[] = []
    claimChromeShortcut('find.open', () => {
      order.push('page')
      return true
    })
    claimChromeShortcut('find.open', () => {
      order.push('sheet')
      return false
    })
    expect(offerChromeShortcut('find.open', find)).toBe(true)
    expect(order).toEqual(['sheet', 'page'])
  })

  it('stops at the first claim that takes the event', () => {
    const beneath = vi.fn(() => true)
    claimChromeShortcut('find.open', beneath)
    claimChromeShortcut('find.open', () => true)
    offerChromeShortcut('find.open', find)
    expect(beneath).not.toHaveBeenCalled()
  })

  it('forgets a released claim', () => {
    const release = claimChromeShortcut('find.open', () => true)
    release()
    expect(offerChromeShortcut('find.open', find)).toBe(false)
    // Releasing twice is harmless.
    release()
  })

  it('a claim that only takes its own tab lets another tab’s event through', () => {
    claimChromeShortcut('find.open', (payload) => payload.tabId === 't1')
    expect(offerChromeShortcut('find.open', { tabId: 't2', text: '' })).toBe(false)
    expect(offerChromeShortcut('find.open', { tabId: 't1', text: '' })).toBe(true)
  })
})

describe('useChromeShortcut', () => {
  let root: Root | null = null
  let mount: HTMLElement | null = null

  function render(el: ReactElement): void {
    if (!root) {
      mount = document.createElement('div')
      document.body.appendChild(mount)
      root = createRoot(mount)
    }
    act(() => root!.render(el))
  }

  afterEach(() => {
    if (root) act(() => root!.unmount())
    root = null
    mount?.remove()
    mount = null
  })

  function Page({ claim }: { claim: ((tabId: string) => boolean) | null }): JSX.Element {
    useChromeShortcut('find.open', claim ? (payload) => claim(payload.tabId) : null)
    return <div>page</div>
  }

  it('claims while mounted and releases on unmount', () => {
    const claim = vi.fn(() => true)
    render(<Page claim={claim} />)
    expect(offerChromeShortcut('find.open', find)).toBe(true)
    expect(claim).toHaveBeenCalledWith('t1')
    act(() => root!.unmount())
    root = null
    expect(offerChromeShortcut('find.open', find)).toBe(false)
  })

  it('runs the latest claim without losing its place in the order', () => {
    const first = vi.fn(() => true)
    const second = vi.fn(() => true)
    render(<Page claim={first} />)
    // A surface mounted later would be asked first; re-rendering the page must not jump ahead.
    const releaseLater = claimChromeShortcut('find.open', () => false)
    render(<Page claim={second} />)
    offerChromeShortcut('find.open', find)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    releaseLater()
  })

  it('a null claim claims nothing', () => {
    render(<Page claim={null} />)
    expect(offerChromeShortcut('find.open', find)).toBe(false)
    render(<Page claim={() => true} />)
    expect(offerChromeShortcut('find.open', find)).toBe(true)
    render(<Page claim={null} />)
    expect(offerChromeShortcut('find.open', find)).toBe(false)
  })
})

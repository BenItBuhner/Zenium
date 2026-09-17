import { describe, expect, it } from 'vitest'
import {
  WEB_NAVIGATION_EVENTS,
  isFragmentNavigation,
  netErrorName,
  transitionFor
} from '../api/webNavigation'

describe('transitionFor', () => {
  it('reports reloads and history moves, typed URLs from the address bar, links otherwise', () => {
    expect(transitionFor({ isMainFrame: true })).toEqual({
      transitionType: 'link',
      transitionQualifiers: []
    })
    expect(transitionFor({ isMainFrame: true, reload: true })).toEqual({
      transitionType: 'reload',
      transitionQualifiers: []
    })
    expect(transitionFor({ isMainFrame: true, history: true })).toEqual({
      transitionType: 'link',
      transitionQualifiers: ['forward_back']
    })
    expect(transitionFor({ isMainFrame: true, typed: true })).toEqual({
      transitionType: 'typed',
      transitionQualifiers: ['from_address_bar']
    })
    expect(transitionFor({ isMainFrame: true, formSubmit: true }).transitionType).toBe(
      'form_submit'
    )
    expect(transitionFor({ isMainFrame: true, typed: true, serverRedirect: true })).toEqual({
      transitionType: 'typed',
      transitionQualifiers: ['server_redirect', 'from_address_bar']
    })
  })

  it('classifies sub-frame loads by who started them', () => {
    expect(transitionFor({ isMainFrame: false }).transitionType).toBe('auto_subframe')
    expect(transitionFor({ isMainFrame: false, rendererInitiated: true }).transitionType).toBe(
      'auto_subframe'
    )
    expect(transitionFor({ isMainFrame: false, rendererInitiated: false }).transitionType).toBe(
      'manual_subframe'
    )
    // A reload of a sub-frame is still a reload.
    expect(transitionFor({ isMainFrame: false, reload: true }).transitionType).toBe('reload')
  })
})

describe('netErrorName', () => {
  it('prefers the engine description, prefixed with net:: once', () => {
    expect(netErrorName(-105, 'ERR_NAME_NOT_RESOLVED')).toBe('net::ERR_NAME_NOT_RESOLVED')
    expect(netErrorName(-105, 'net::ERR_NAME_NOT_RESOLVED')).toBe('net::ERR_NAME_NOT_RESOLVED')
    expect(netErrorName(-3, '')).toBe('net::ERR_-3')
  })
})

describe('isFragmentNavigation', () => {
  it('is true only when the URLs differ in their fragment alone', () => {
    expect(isFragmentNavigation('https://a.com/p', 'https://a.com/p#x')).toBe(true)
    expect(isFragmentNavigation('https://a.com/p#x', 'https://a.com/p#y')).toBe(true)
    expect(isFragmentNavigation('https://a.com/p#x', 'https://a.com/p')).toBe(true)
    expect(isFragmentNavigation('https://a.com/p#x', 'https://a.com/p#x')).toBe(true)
    expect(isFragmentNavigation('https://a.com/p', 'https://a.com/p')).toBe(false)
    expect(isFragmentNavigation('https://a.com/p', 'https://a.com/q#x')).toBe(false)
    expect(isFragmentNavigation('https://a.com/p?a=1', 'https://a.com/p?a=2#x')).toBe(false)
  })
})

describe('WEB_NAVIGATION_EVENTS', () => {
  it('lists the nine Chrome events', () => {
    expect([...WEB_NAVIGATION_EVENTS].sort()).toEqual(
      [
        'onBeforeNavigate',
        'onCommitted',
        'onDOMContentLoaded',
        'onCompleted',
        'onErrorOccurred',
        'onCreatedNavigationTarget',
        'onReferenceFragmentUpdated',
        'onTabReplaced',
        'onHistoryStateUpdated'
      ].sort()
    )
  })
})

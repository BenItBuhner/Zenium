import { describe, expect, it } from 'vitest'
import type { Tab, UIState } from '@shared/types'
import {
  BLOCKED_PERMISSIONS,
  blockedPermissionLabel,
  blockedPermissionsOf,
  captureGlyph,
  captureLabel,
  permissionSiteOf
} from '../siteChips'

/*
 * The URL pill's readings of a site's permissions (omnibox-38): which blocks the pill shows
 * (a stored deny of the site's own, in the pill's order, and only the four with an icon), keyed
 * by the engine's site (the origin; one site for local files), and the in-use chip's glyph and
 * name for what the page holds.
 */

const tab = (url: string): Tab => ({ id: 't1', url }) as unknown as Tab
const state = (rules: UIState['permissionRules']): UIState =>
  ({ permissionRules: rules }) as unknown as UIState

describe('blocked permissions of a site', () => {
  it('reads the site’s own deny rules, in the pill’s order, and only the four with an icon', () => {
    const rules = state([
      { origin: 'https://meet.example', permission: 'notifications', decision: 'deny' },
      { origin: 'https://meet.example', permission: 'camera', decision: 'deny' },
      { origin: 'https://meet.example', permission: 'microphone', decision: 'allow' },
      { origin: 'https://meet.example', permission: 'midi', decision: 'deny' },
      { origin: 'https://meet.example', permission: 'popups', decision: 'deny' },
      { origin: 'https://other.example', permission: 'geolocation', decision: 'deny' }
    ])
    expect(blockedPermissionsOf(rules, tab('https://meet.example/call?x=1'))).toEqual([
      'camera',
      'notifications'
    ])
    expect(blockedPermissionsOf(rules, tab('https://other.example/'))).toEqual(['geolocation'])
    expect(blockedPermissionsOf(rules, tab('https://nothing.example/'))).toEqual([])
    expect(blockedPermissionsOf(rules, null)).toEqual([])
    expect(BLOCKED_PERMISSIONS).toEqual(['camera', 'microphone', 'geolocation', 'notifications'])
  })

  it('keys by the engine’s site: the origin, and one shared site for local files', () => {
    expect(permissionSiteOf('https://meet.example:8443/a/b')).toBe('https://meet.example:8443')
    expect(permissionSiteOf('file:///home/ada/page.html')).toBe('file://')
    expect(permissionSiteOf('zen://settings')).toBeNull()
    expect(permissionSiteOf('not a url')).toBeNull()
    const rules = state([{ origin: 'file://', permission: 'microphone', decision: 'deny' }])
    expect(blockedPermissionsOf(rules, tab('file:///home/ada/page.html'))).toEqual(['microphone'])
  })

  it('names each blocked icon', () => {
    expect(BLOCKED_PERMISSIONS.map(blockedPermissionLabel)).toEqual([
      'Camera blocked',
      'Microphone blocked',
      'Location blocked',
      'Notifications blocked'
    ])
  })
})

describe('the in-use chip’s glyph and name', () => {
  it('draws the camera when the camera is on, the microphone alone, the sharing glyph for the screen', () => {
    expect(captureGlyph({ camera: true, microphone: true, display: false })).toBe('camera')
    expect(captureGlyph({ camera: true, microphone: false, display: true })).toBe('camera')
    expect(captureGlyph({ camera: false, microphone: true, display: true })).toBe('microphone')
    expect(captureGlyph({ camera: false, microphone: false, display: true })).toBe('display')
  })

  it('names everything the page holds', () => {
    expect(captureLabel({ camera: true, microphone: true, display: false })).toBe(
      'This page is using your camera and microphone'
    )
    expect(captureLabel({ camera: true, microphone: false, display: false })).toBe(
      'This page is using your camera'
    )
    expect(captureLabel({ camera: false, microphone: true, display: false })).toBe(
      'This page is using your microphone'
    )
    expect(captureLabel({ camera: false, microphone: false, display: true })).toBe(
      'This page is sharing your screen'
    )
    expect(captureLabel({ camera: false, microphone: true, display: true })).toBe(
      'This page is using your microphone and sharing your screen'
    )
  })
})

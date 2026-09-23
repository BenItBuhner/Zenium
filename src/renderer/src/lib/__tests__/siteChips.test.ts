import { describe, expect, it } from 'vitest'
import type { TabCapture } from '@shared/captureState'
import type { Tab, UIState } from '@shared/types'
import {
  BLOCKED_PERMISSIONS,
  blockedPermissionLabel,
  blockedPermissionsLabel,
  blockedPermissionsOf,
  captureGlyph,
  captureLabel,
  permissionSiteOf,
  siteChipName,
  siteSlotState
} from '../siteChips'

/*
 * The URL pill's readings of a site's permissions (omnibox-38): which blocks the pill shows
 * (a stored deny of the site's own, in the pill's order, and only the four with an icon), keyed
 * by the engine's site (the origin; one site for local files), the glyph and name for what the
 * page holds, and the site-information slot's one state at a time (§9.29's precedence).
 */

const tab = (url: string, capture: TabCapture | null = null): Tab =>
  ({ id: 't1', url, capture }) as unknown as Tab
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

  it('names each blocked permission', () => {
    expect(BLOCKED_PERMISSIONS.map(blockedPermissionLabel)).toEqual([
      'Camera blocked',
      'Microphone blocked',
      'Location blocked',
      'Notifications blocked'
    ])
  })

  it('lists every blocked permission in one name, in the pill’s order', () => {
    expect(blockedPermissionsLabel(['camera', 'microphone'])).toBe('Camera and microphone blocked')
    expect(blockedPermissionsLabel(['camera', 'geolocation', 'notifications'])).toBe(
      'Camera, location and notifications blocked'
    )
    expect(blockedPermissionsLabel(['camera', 'microphone', 'geolocation', 'notifications'])).toBe(
      'Camera, microphone, location and notifications blocked'
    )
    expect(blockedPermissionsLabel(['notifications'])).toBe('Notifications blocked')
  })
})

describe('the site-information slot’s state (§9.29)', () => {
  const both = { camera: true, microphone: true, display: false }
  const rules = state([
    { origin: 'https://meet.example', permission: 'notifications', decision: 'deny' },
    { origin: 'https://meet.example', permission: 'microphone', decision: 'deny' }
  ])
  const none = state([])

  it('is the connection’s glyph alone while nothing is captured and nothing is blocked', () => {
    expect(siteSlotState(none, tab('https://meet.example/'), 'secure')).toBeNull()
    expect(siteSlotState(none, null, 'secure')).toBeNull()
    expect(siteChipName(null)).toBe('Site information')
  })

  it('a live capture beats a standing block: the capture’s glyph, and its sentence as the name', () => {
    const slot = siteSlotState(rules, tab('https://meet.example/', both), 'secure')
    expect(slot).toEqual({
      kind: 'capture',
      glyph: 'camera',
      label: 'This page is using your camera and microphone'
    })
    expect(siteChipName(slot)).toBe(
      'Site information · This page is using your camera and microphone'
    )
    const share = siteSlotState(
      none,
      tab('https://meet.example/', { camera: false, microphone: false, display: true }),
      'secure'
    )
    expect(share).toMatchObject({ kind: 'capture', glyph: 'display' })
  })

  it('a standing block beats the connection’s glyph: the first blocked permission’s glyph, every one in the name', () => {
    const slot = siteSlotState(rules, tab('https://meet.example/'), 'secure')
    expect(slot).toEqual({
      kind: 'blocked',
      glyph: 'microphone-off',
      permissions: ['microphone', 'notifications'],
      label: 'Microphone and notifications blocked'
    })
    expect(siteChipName(slot)).toBe('Site information · Microphone and notifications blocked')
    // The pill's order, whatever the rules': a camera block leads.
    const camera = state([
      ...rules.permissionRules,
      { origin: 'https://meet.example', permission: 'camera', decision: 'deny' }
    ])
    expect(siteSlotState(camera, tab('https://meet.example/'), 'insecure')).toMatchObject({
      glyph: 'camera-off',
      label: 'Camera, microphone and notifications blocked'
    })
    // A block on another site, or an allow, is no state.
    expect(siteSlotState(rules, tab('https://other.example/'), 'secure')).toBeNull()
  })

  it('a certificate error beats both: the slot keeps the danger glyph', () => {
    expect(siteSlotState(rules, tab('https://meet.example/', both), 'certificate-error')).toBeNull()
    expect(siteSlotState(rules, tab('https://meet.example/'), 'certificate-error')).toBeNull()
  })
})

describe('the live capture’s glyph and name', () => {
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

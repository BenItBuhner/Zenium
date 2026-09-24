import { describe, expect, it } from 'vitest'
import type { TabCapture } from '@shared/captureState'
import type { PermissionPrompt, Tab, UIState } from '@shared/types'
import {
  BLOCKED_PERMISSIONS,
  MEMORY_SAVER_LEAF_MS,
  blockedPermissionLabel,
  blockedPermissionsLabel,
  blockedPermissionsOf,
  captureGlyph,
  captureLabel,
  memorySaverLeaf,
  permissionSiteOf,
  quietBell,
  siteChipName,
  siteSlotState
} from '../siteChips'

/*
 * The URL pill's readings of a site's permissions (omnibox-38): which blocks the pill shows
 * (a stored deny of the site's own, in the pill's order, and only the four with an icon), keyed
 * by the engine's site (the origin; one site for local files), the glyph and name for what the
 * page holds, the bell of a quiet notification request (NOT-03), and the site-information
 * slot's one state at a time (§9.29's precedence).
 */

const tab = (url: string, capture: TabCapture | null = null): Tab =>
  ({ id: 't1', url, capture }) as unknown as Tab
const state = (
  rules: UIState['permissionRules'],
  permissionPrompts: PermissionPrompt[] = []
): UIState => ({ permissionRules: rules, permissionPrompts }) as unknown as UIState

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

  describe('the Memory Saver leaf of a tab just woken from sleep (omnibox-40)', () => {
    const wokeAt = Date.parse('2026-09-24T04:00:00Z')
    const woken = (url = 'https://docs.example/'): Tab =>
      ({ id: 't1', url, capture: null, memorySaver: { savedMb: 312, wokeAt } }) as unknown as Tab
    const leaf = {
      kind: 'memory-saver',
      glyph: 'leaf',
      savedMb: 312,
      label: 'Memory Saver freed up 312 MB'
    }

    it('stands for ten seconds from the wake, then leaves the slot to the connection’s glyph', () => {
      expect(siteSlotState(none, woken(), 'secure', { now: wokeAt })).toEqual(leaf)
      expect(siteSlotState(none, woken(), 'insecure', { now: wokeAt + 9_999 })).toEqual(leaf)
      expect(
        siteSlotState(none, woken(), 'secure', { now: wokeAt + MEMORY_SAVER_LEAF_MS })
      ).toBeNull()
      expect(siteSlotState(none, woken(), 'secure', { now: wokeAt + 60_000 })).toBeNull()
      expect(memorySaverLeaf(woken(), { now: wokeAt + 60_000 })).toBeNull()
      expect(siteChipName(memorySaverLeaf(woken(), { now: wokeAt }))).toBe(
        'Site information · Memory Saver freed up 312 MB'
      )
      expect(MEMORY_SAVER_LEAF_MS).toBe(10_000)
    })

    it('stays while its bubble is open, whatever the clock says', () => {
      expect(
        siteSlotState(none, woken(), 'secure', { now: wokeAt + 60_000, leafHeld: true })
      ).toEqual(leaf)
    })

    it('yields to a live capture, a standing block and a certificate error; a tab without a wake has none', () => {
      const asleepBefore = { ...woken('https://meet.example/'), capture: both }
      expect(siteSlotState(rules, asleepBefore, 'secure', { now: wokeAt })).toMatchObject({
        kind: 'capture'
      })
      expect(
        siteSlotState(rules, woken('https://meet.example/'), 'secure', { now: wokeAt })
      ).toMatchObject({ kind: 'blocked', glyph: 'microphone-off' })
      expect(siteSlotState(none, woken(), 'certificate-error', { now: wokeAt })).toBeNull()
      expect(
        siteSlotState(none, tab('https://docs.example/'), 'secure', { now: wokeAt })
      ).toBeNull()
      expect(memorySaverLeaf(null)).toBeNull()
    })
  })

  describe('the bell of a quiet notification request (NOT-03, omnibox-38)', () => {
    const wokeAt = Date.parse('2026-09-24T05:00:00Z')
    const ask = (id: string, tabId: string): PermissionPrompt => ({
      id,
      tabId,
      origin: 'https://news.example',
      permission: 'notifications',
      message: 'Notifications blocked',
      detail: 'You usually block notifications. To let news.example notify you, choose Allow.',
      allowLabel: 'Allow',
      blockLabel: 'Keep blocking',
      allowOnce: false,
      requestedAt: wokeAt,
      quiet: true
    })
    /** The loud ask of the same site: a sheet or a bubble in its turn, no bell. */
    const loud = (id: string, tabId: string): PermissionPrompt => ({
      ...ask(id, tabId),
      message: 'Allow news.example to send notifications?',
      blockLabel: 'Block',
      quiet: undefined
    })
    const bell = {
      kind: 'quiet',
      glyph: 'notifications-off',
      promptId: 'perm-q1',
      label: 'Notifications blocked'
    }
    const quiet = state([], [ask('perm-q1', 't1')])

    it('is the crossed-out bell for the quiet prompt pending on the tab, named as Chrome names it', () => {
      expect(quietBell(quiet, tab('https://news.example/'))).toEqual(bell)
      expect(siteSlotState(quiet, tab('https://news.example/'), 'secure')).toEqual(bell)
      expect(siteChipName(quietBell(quiet, tab('https://news.example/')))).toBe(
        'Site information · Notifications blocked'
      )
      // The same words the slot uses for a standing block of notifications, and the prompt's title.
      expect(bell.label).toBe(blockedPermissionLabel('notifications'))
      expect(ask('perm-q1', 't1').message).toBe(bell.label)
    })

    it('stands for the tab’s own quiet prompt alone: another tab’s, a loud one, or none is no bell', () => {
      const others = state([], [ask('perm-q2', 't2'), loud('perm-p3', 't1')])
      expect(quietBell(others, tab('https://news.example/'))).toBeNull()
      expect(siteSlotState(others, tab('https://news.example/'), 'secure')).toBeNull()
      expect(quietBell(none, tab('https://news.example/'))).toBeNull()
      expect(quietBell(quiet, null)).toBeNull()
      // A state built without the list (a test's) reads as no request, not a crash.
      expect(quietBell(state([]), tab('https://news.example/'))).toBeNull()
      // Two quiet prompts on the tab: the first in the queue is the bell's (the core keeps one
      // per tab; a second request joins it).
      const two = state([], [ask('perm-q1', 't1'), ask('perm-q9', 't1')])
      expect(quietBell(two, tab('https://news.example/'))?.promptId).toBe('perm-q1')
    })

    it('ranks below a live capture and a standing block, above the leaf; a certificate error takes the slot', () => {
      const woken = {
        ...tab('https://news.example/'),
        memorySaver: { savedMb: 120, wokeAt }
      } as Tab
      // Over the leaf: a question waiting on the user beats a passing notice.
      expect(siteSlotState(quiet, woken, 'secure', { now: wokeAt })).toEqual(bell)
      // The leaf's bubble held open changes nothing: the bell still leads.
      expect(siteSlotState(quiet, woken, 'secure', { now: wokeAt, leafHeld: true })).toEqual(bell)
      // Under a standing block of another permission: the user's decision over the open question.
      const camera = state(
        [{ origin: 'https://news.example', permission: 'camera', decision: 'deny' }],
        [ask('perm-q1', 't1')]
      )
      expect(siteSlotState(camera, tab('https://news.example/'), 'secure')).toMatchObject({
        kind: 'blocked',
        glyph: 'camera-off'
      })
      // Under a live capture.
      expect(siteSlotState(quiet, tab('https://news.example/', both), 'secure')).toMatchObject({
        kind: 'capture'
      })
      // Under the danger tier.
      expect(siteSlotState(quiet, tab('https://news.example/'), 'certificate-error')).toBeNull()
      // The bell gone (answered or withdrawn): the leaf is back while its ten seconds run.
      expect(siteSlotState(none, woken, 'secure', { now: wokeAt })).toMatchObject({
        kind: 'memory-saver'
      })
    })
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

import { describe, expect, it } from 'vitest'
import { CONTENT_SETTINGS, contentSetting, contentSettingsFor } from '../contentSettings'

const ids = (platform: 'desktop' | 'android'): string[] =>
  contentSettingsFor(platform).map((setting) => setting.id)

// Pass 10 (PR #507): a row leaves one host's Site settings only where that host has no
// enforcement path (`support.<host>: 'n-a'`); it is never greyed, and it stays on the other host.
describe('contentSettingsFor: the per-host catalogue (pass 10)', () => {
  it('hides Third-party sign-in and Payment handlers on the phone – the WebView has no FedCM and ships no PaymentRequest – and keeps Insecure content', () => {
    const phone = ids('android')
    expect(phone).not.toContain('third-party-sign-in')
    expect(phone).not.toContain('payment-handler')
    expect(phone).not.toContain('pdf')
    expect(phone).toContain('insecure-content')
    for (const id of [
      'images',
      'javascript',
      'sensors',
      'automatic-downloads',
      'on-device-site-data'
    ]) {
      expect(phone).toContain(id)
    }
  })

  it('hides Insecure content on the desktop – Electron has no per-site path for a live view – and keeps the rows the phone hides', () => {
    const desktop = ids('desktop')
    expect(desktop).not.toContain('insecure-content')
    for (const id of [
      'third-party-sign-in',
      'payment-handler',
      'pdf',
      'images',
      'javascript',
      'sensors',
      'automatic-downloads',
      'on-device-site-data'
    ]) {
      expect(desktop).toContain(id)
    }
  })

  it('lists a row by its own host’s support alone: every hidden row is n-a there, every listed row acts, and nothing is stored-only any more', () => {
    for (const platform of ['desktop', 'android'] as const) {
      const listed = contentSettingsFor(platform)
      expect(listed.every((setting) => setting.support[platform] !== 'n-a')).toBe(true)
      const hidden = CONTENT_SETTINGS.filter((setting) => !listed.includes(setting))
      expect(hidden.every((setting) => setting.support[platform] === 'n-a')).toBe(true)
      expect(contentSettingsFor(platform, ['stored'])).toEqual([])
      expect(contentSettingsFor(platform, ['enforced'])).toEqual(listed)
    }
    // A row neither host can honour is listed nowhere.
    expect(ids('desktop')).not.toContain('zoom-levels')
    expect(ids('android')).not.toContain('zoom-levels')
  })
})

/*
 * The catalogue's per-host filter (`contentSettingsFor`): a row a host neither honours nor
 * remembers (`support: 'n-a'`) is not the host's to show – Settings and the site card list
 * nothing for it – while the row keeps its meaning for a stored answer on the other host.
 */
describe('contentSettingsFor', () => {
  it('lists Automatic picture-in-picture on both hosts now that Android’s auto-enter reads it (the root’s ruling on #506: a row is a promise)', () => {
    const desktop = contentSettingsFor('desktop').map((s) => s.id)
    const android = contentSettingsFor('android').map((s) => s.id)
    expect(desktop).toContain('auto-picture-in-picture')
    expect(android).toContain('auto-picture-in-picture')
    // The row sits with the other Additional permissions after Fullscreen on both hosts.
    expect(desktop.indexOf('auto-picture-in-picture')).toBe(desktop.indexOf('fullscreen') + 1)
    expect(android.indexOf('auto-picture-in-picture')).toBe(android.indexOf('fullscreen') + 1)
    // Enforced on both: the desktop enters when the tab leaves the screen, Android from a
    // fullscreen video on Home (`MediaSessionInfo.autoPictureInPicture`); allow is the default.
    expect(contentSetting('auto-picture-in-picture')).toMatchObject({
      label: 'Automatic picture-in-picture',
      builtInDefault: 'allow',
      choices: ['allow', 'deny'],
      support: { desktop: 'enforced', android: 'enforced' }
    })
  })

  it('still hides a row a host has no feature for, and lists it when asked for everything', () => {
    const android = contentSettingsFor('android').map((s) => s.id)
    expect(android).not.toContain('pointerLock')
    // Hidden, not gone: `n-a` is a filter, not an absence.
    expect(contentSettingsFor('android', ['enforced', 'stored', 'n-a']).map((s) => s.id)).toContain(
      'pointerLock'
    )
    expect(contentSetting('pointerLock')).toMatchObject({
      support: { desktop: 'enforced', android: 'n-a' }
    })
  })
})

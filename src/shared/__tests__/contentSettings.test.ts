import { describe, expect, it } from 'vitest'
import { contentSetting, contentSettingsFor } from '../contentSettings'

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

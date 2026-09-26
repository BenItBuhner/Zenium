import { describe, expect, it } from 'vitest'
import { contentSetting, contentSettingsFor } from '../contentSettings'

/*
 * The catalogue's per-host filter (`contentSettingsFor`): a row a host neither honours nor
 * remembers (`support: 'n-a'`) is not the host's to show – Settings and the site card list
 * nothing for it – while the row keeps its meaning for a stored answer on the other host.
 */
describe('contentSettingsFor', () => {
  it('lists Automatic picture-in-picture on the desktop and hides it on the phone until Android’s hook reads it (the root’s ruling on #506)', () => {
    const desktop = contentSettingsFor('desktop').map((s) => s.id)
    const android = contentSettingsFor('android').map((s) => s.id)
    expect(desktop).toContain('auto-picture-in-picture')
    expect(android).not.toContain('auto-picture-in-picture')
    // The row sits with the other Additional permissions after Fullscreen where it is listed.
    expect(desktop.indexOf('auto-picture-in-picture')).toBe(desktop.indexOf('fullscreen') + 1)
    // Hidden, not gone: the catalogue still names the setting, so a stored answer keeps its label.
    expect(contentSetting('auto-picture-in-picture')).toMatchObject({
      label: 'Automatic picture-in-picture',
      support: { desktop: 'enforced', android: 'n-a' }
    })
    // Asked for everything, the phone's list has it too – `n-a` is a filter, not an absence.
    expect(contentSettingsFor('android', ['enforced', 'stored', 'n-a']).map((s) => s.id)).toContain(
      'auto-picture-in-picture'
    )
  })
})

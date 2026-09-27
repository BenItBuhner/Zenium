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

/*
 * Services pass 11 (seed 3): every row with a choice beyond its built-in default carries its own
 * line for that choice (`descriptions`), in the register of the design lead's #523 ruling – the
 * Block line "Sites cannot …", the Allow line "Sites can …", one sentence in sentence case, the
 * subject the row's own where the built-in line has one. The lines are proposals for the lead;
 * these pins hold whatever words the lead settles on, and the shape rules hold regardless.
 */
describe('the rows’ per-value description lines (services pass 11, seed 3)', () => {
  it('pins each row’s lines for the choices beyond its built-in default', () => {
    const table = Object.fromEntries(
      CONTENT_SETTINGS.filter((s) => s.descriptions).map((s) => [s.id, s.descriptions])
    )
    expect(table).toEqual({
      geolocation: { deny: 'Sites cannot see your location' },
      camera: { deny: 'Sites cannot use your camera' },
      microphone: { deny: 'Sites cannot use your microphone' },
      notifications: { deny: 'Sites cannot send notifications' },
      'background-sync': {
        deny: 'Recently closed sites cannot finish sending or receiving data'
      },
      sensors: { deny: 'Sites cannot use motion sensors' },
      'automatic-downloads': {
        allow: 'Sites can download multiple files without asking',
        deny: 'Sites cannot download multiple files automatically'
      },
      midi: { deny: 'Sites cannot connect to MIDI devices' },
      usb: { deny: 'Sites cannot connect to USB devices' },
      serial: { deny: 'Sites cannot connect to serial ports' },
      hid: { deny: 'Sites cannot connect to HID devices' },
      bluetooth: { deny: 'Sites cannot connect to Bluetooth devices' },
      fileSystem: { deny: 'Sites cannot edit files or folders on your device' },
      'clipboard-read': { deny: 'Sites cannot see text or images on your clipboard' },
      'payment-handler': { deny: 'Sites cannot install payment handlers' },
      'insecure-content': { allow: 'Secure sites can show insecure content' },
      'window-management': { deny: 'Sites cannot use information about your screens' },
      'local-network-access': {
        deny: 'Sites cannot look for or connect to devices on your local network'
      },
      images: { deny: 'Sites cannot show images' },
      javascript: { deny: 'Sites cannot use JavaScript' },
      popups: { allow: 'Sites can send pop-ups and use redirects' },
      ads: { allow: 'Sites can show ads and trackers' },
      sound: { deny: 'Sites cannot play sound' },
      'background-video': { allow: 'Sites can keep playing video in the background' },
      pdf: { deny: 'PDF files download instead of opening in Zenium' },
      mediaKeySystem: {
        allow: 'Sites can play protected content without asking',
        deny: 'Sites cannot play protected content'
      },
      'third-party-sign-in': {
        deny: 'Sites cannot show sign-in prompts from identity services'
      },
      'on-device-site-data': { deny: 'Sites cannot save data on your device' },
      openExternal: { deny: 'Sites cannot open links in another app' },
      'storage-access': {
        allow: 'Embedded sites can use the cookies they stored without asking',
        deny: 'Embedded sites cannot use the cookies they stored'
      },
      'top-level-storage-access': {
        allow: 'Sites can let the sites they embed use their cookies without asking',
        deny: 'Sites cannot let the sites they embed use their cookies'
      },
      'idle-detection': { deny: 'Sites cannot know when you are actively using your device' },
      fullscreen: { deny: 'Sites cannot go fullscreen' },
      'auto-picture-in-picture': {
        deny: 'Sites cannot move a playing video to a small window when you leave its tab'
      },
      pointerLock: { deny: 'Sites cannot hide or capture the pointer' },
      keyboardLock: { deny: 'Fullscreen sites cannot capture system keys' },
      'speaker-selection': { deny: 'Sites cannot pick which speaker plays their sound' },
      'clipboard-sanitized-write': { deny: 'Sites cannot copy text or images to your clipboard' },
      'display-capture': { deny: 'Sites cannot share your screen, a window or a tab' }
    })
    // 39 rows carry lines (38 new beside #523's Background video), 43 lines in all.
    expect(Object.keys(table)).toHaveLength(39)
    expect(Object.values(table).flatMap((own) => Object.values(own!))).toHaveLength(43)
  })

  it('writes a line for every choice beyond the built-in default and for nothing else; a row with one choice has no field', () => {
    for (const setting of CONTENT_SETTINGS) {
      const others = setting.choices.filter((value) => value !== setting.builtInDefault)
      if (others.length === 0) {
        expect(setting.descriptions, setting.id).toBeUndefined()
        continue
      }
      expect(Object.keys(setting.descriptions ?? {}).sort(), setting.id).toEqual(others.sort())
    }
  })

  it('keeps every line to the lead’s register: one sentence in sentence case without a full stop (the catalogue’s), Block as "… cannot …", Allow as "… can …", never the built-in’s own line', () => {
    for (const setting of CONTENT_SETTINGS) {
      for (const [value, line] of Object.entries(setting.descriptions ?? {})) {
        const where = `${setting.id} ${value}`
        expect(line, where).toMatch(/^[A-Z][^.!?]*[^.!?\s]$/)
        if (value === 'deny') expect(line, where).toMatch(/\b(cannot|instead of)\b/)
        if (value === 'allow') expect(line, where).toMatch(/\bcan\b/)
        expect(line, where).not.toBe(setting.description)
      }
    }
  })
})

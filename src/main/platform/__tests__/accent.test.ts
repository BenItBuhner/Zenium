import { describe, expect, it } from 'vitest'
import {
  MAC_SYSTEM_COLORS_NOTIFICATION,
  accentHex,
  readSystemAccent,
  systemAccentOverride,
  systemAccentReadable,
  watchSystemAccent,
  type SystemAccentSource
} from '../accent'

/*
 * The OS accent read for Settings › Appearance › Use system accent colour (settings-116):
 * Electron's `systemPreferences.getAccentColor()` on Windows (DWM's `RRGGBBAA`) and macOS, absent
 * on Linux; the change events per OS; the drives' `--test-system-accent` stand-in.
 */

/** Electron's `systemPreferences` as each OS exposes it, with what it says. */
function system(overrides: Partial<SystemAccentSource> = {}): SystemAccentSource {
  return { ...overrides }
}

describe('accentHex', () => {
  it('reads Electron’s RRGGBBAA, a bare RRGGBB and a `#`-prefixed one as the chrome’s #rrggbb', () => {
    expect(accentHex('0078D4FF')).toBe('#0078d4')
    expect(accentHex('0078d4')).toBe('#0078d4')
    expect(accentHex('#0078D4')).toBe('#0078d4')
    expect(accentHex(' #0078D4ff ')).toBe('#0078d4')
  })

  it('is null for anything that is not a colour', () => {
    expect(accentHex('')).toBeNull()
    expect(accentHex('blue')).toBeNull()
    expect(accentHex('#0078')).toBeNull()
    expect(accentHex('0078D4FFA')).toBeNull()
    expect(accentHex(undefined)).toBeNull()
    expect(accentHex(0x0078d4)).toBeNull()
  })
})

describe('readSystemAccent / systemAccentReadable', () => {
  it('Windows: the DWM accent through getAccentColor, a change through accent-color-changed', () => {
    const listeners: Array<(event: unknown, color: string) => void> = []
    const sys = system({
      getAccentColor: () => '0078D4FF',
      on: (_event, listener) => {
        listeners.push(listener)
        return sys
      }
    })
    expect(systemAccentReadable(sys, 'win32')).toBe(true)
    expect(readSystemAccent(sys, 'win32')).toBe('#0078d4')
    let heard = 0
    watchSystemAccent(sys, 'win32', () => {
      heard += 1
    })
    expect(listeners).toHaveLength(1)
    listeners[0]!({}, 'FF8C00FF')
    expect(heard).toBe(1)
  })

  it('macOS: the Appearance pane’s accent, a change through the system colours notification', () => {
    const subscribed: string[] = []
    const sys = system({
      getAccentColor: () => 'FF8C00',
      subscribeNotification: (event) => {
        subscribed.push(event)
        return 1
      }
    })
    expect(systemAccentReadable(sys, 'darwin')).toBe(true)
    expect(readSystemAccent(sys, 'darwin')).toBe('#ff8c00')
    watchSystemAccent(sys, 'darwin', () => undefined)
    expect(subscribed).toEqual([MAC_SYSTEM_COLORS_NOTIFICATION])
  })

  it('Linux: nothing to read (the method is absent there) and nothing to watch – even were the method present', () => {
    const bare = system()
    expect(systemAccentReadable(bare, 'linux')).toBe(false)
    expect(readSystemAccent(bare, 'linux')).toBeNull()
    let watched = 0
    const chatty = system({
      getAccentColor: () => '0078D4FF',
      on: () => {
        watched += 1
        return chatty
      },
      subscribeNotification: () => {
        watched += 1
        return 1
      }
    })
    expect(systemAccentReadable(chatty, 'linux')).toBe(false)
    expect(readSystemAccent(chatty, 'linux')).toBeNull()
    watchSystemAccent(chatty, 'linux', () => undefined)
    expect(watched).toBe(0)
  })

  it('a reading that throws, or that is not a colour, is no accent rather than a crash', () => {
    expect(
      readSystemAccent(
        system({
          getAccentColor: () => {
            throw new Error('no DWM')
          }
        }),
        'win32'
      )
    ).toBeNull()
    expect(readSystemAccent(system({ getAccentColor: () => 'transparent' }), 'win32')).toBeNull()
  })

  it('the drives’ override stands in for the OS on any platform, Linux’s X server included', () => {
    const bare = system()
    expect(systemAccentReadable(bare, 'linux', '#0078d4')).toBe(true)
    expect(readSystemAccent(bare, 'linux', '#0078d4')).toBe('#0078d4')
    // The override wins over the OS reading too: the drives choose the colour they measure.
    expect(readSystemAccent(system({ getAccentColor: () => 'FF8C00FF' }), 'win32', '#0078d4')).toBe(
      '#0078d4'
    )
  })
})

describe('systemAccentOverride', () => {
  it('reads --test-system-accent=<hex> off argv, in any of the hex spellings; a normal launch carries none', () => {
    expect(systemAccentOverride(['zenium', '--test-system-accent=#0078D4'])).toBe('#0078d4')
    expect(systemAccentOverride(['zenium', '--test-system-accent=0078d4ff'])).toBe('#0078d4')
    expect(systemAccentOverride(['zenium', 'https://example.com/'])).toBeNull()
    expect(systemAccentOverride(['zenium', '--test-system-accent'])).toBeNull()
    expect(systemAccentOverride(['zenium', '--test-system-accent=blue'])).toBeNull()
  })
})

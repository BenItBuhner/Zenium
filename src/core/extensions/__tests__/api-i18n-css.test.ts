import { describe, expect, it } from 'vitest'
import {
  cssSubstitutionMap,
  localizeCss,
  predefinedMessages,
  substituteFromMap,
  type LocaleMessages
} from '../api/i18n'

const ID = 'cmeakgjggjdlcpncigglobpjbkabhmjl'

const MESSAGES: LocaleMessages = {
  accentColor: { message: '#1b2838' },
  Font_Stack: { message: '"Motiva Sans", sans-serif' }
}

describe('predefinedMessages', () => {
  it('spells the locale as a _locales directory does and gives the language its direction', () => {
    expect(predefinedMessages('en-US')).toEqual({
      '@@ui_locale': 'en_US',
      '@@bidi_dir': 'ltr',
      '@@bidi_reversed_dir': 'rtl',
      '@@bidi_start_edge': 'left',
      '@@bidi_end_edge': 'right'
    })
    expect(predefinedMessages('ar', ID)).toEqual({
      '@@ui_locale': 'ar',
      '@@bidi_dir': 'rtl',
      '@@bidi_reversed_dir': 'ltr',
      '@@bidi_start_edge': 'right',
      '@@bidi_end_edge': 'left',
      '@@extension_id': ID
    })
    expect(predefinedMessages('he-IL')['@@bidi_dir']).toBe('rtl')
    expect(predefinedMessages('de')['@@extension_id']).toBeUndefined()
  })
})

describe('localizeCss', () => {
  it('substitutes __MSG_@@extension_id__ and the other predefined messages in a stylesheet', () => {
    // Steam Inventory Helper's sheet names its images by the extension's id.
    const css = `.sih-icon{background:url(chrome-extension://__MSG_@@extension_id__/img/icon.png)}
html[dir=__MSG_@@bidi_dir__] .sih-panel{float:__MSG_@@bidi_start_edge__;margin-__MSG_@@bidi_end_edge__:4px}
.sih-locale::after{content:"__MSG_@@ui_locale__"}`
    expect(localizeCss(css, ID, 'en-US', null)).toBe(
      `.sih-icon{background:url(chrome-extension://${ID}/img/icon.png)}
html[dir=ltr] .sih-panel{float:left;margin-right:4px}
.sih-locale::after{content:"en_US"}`
    )
  })

  it("substitutes the extension's own messages, case-insensitively, and leaves an unknown name", () => {
    const css =
      '.a{color:__MSG_accentColor__;font-family:__MSG_font_stack__}.b{--x:__MSG_missing__}'
    expect(localizeCss(css, ID, 'en', MESSAGES)).toBe(
      '.a{color:#1b2838;font-family:"Motiva Sans", sans-serif}.b{--x:__MSG_missing__}'
    )
    // No messages at all: the predefined ones still substitute, the rest stays.
    expect(localizeCss('.a{color:__MSG_accentColor__}', ID, 'en', null)).toBe(
      '.a{color:__MSG_accentColor__}'
    )
  })

  it('returns a sheet without placeholders as it is', () => {
    const css = 'body{color:red}'
    expect(localizeCss(css, ID, 'en', MESSAGES)).toBe(css)
  })
})

describe('cssSubstitutionMap', () => {
  it("is the flat map a host localizes served stylesheets from: the extension's names lowercased, the predefined ones on top", () => {
    const map = cssSubstitutionMap(ID, 'pt-BR', {
      ...MESSAGES,
      empty: { message: '' },
      // An extension may spell a predefined name itself; Chrome's reserved messages win.
      '@@ui_locale': { message: 'nope' }
    })
    expect(map).toEqual({
      accentcolor: '#1b2838',
      font_stack: '"Motiva Sans", sans-serif',
      '@@ui_locale': 'pt_BR',
      '@@bidi_dir': 'ltr',
      '@@bidi_reversed_dir': 'rtl',
      '@@bidi_start_edge': 'left',
      '@@bidi_end_edge': 'right',
      '@@extension_id': ID
    })
    expect(cssSubstitutionMap(ID, 'en', null)).toEqual(predefinedMessages('en', ID))
  })

  it('substitutes a sheet through the map exactly as localizeCss does', () => {
    const css =
      '.a{color:__MSG_AccentColor__;background:url(chrome-extension://__MSG_@@extension_id__/i.png)}.b{--x:__MSG_missing__}'
    const map = cssSubstitutionMap(ID, 'en-US', MESSAGES)
    expect(substituteFromMap(css, map)).toBe(localizeCss(css, ID, 'en-US', MESSAGES))
    expect(substituteFromMap(css, map)).toBe(
      `.a{color:#1b2838;background:url(chrome-extension://${ID}/i.png)}.b{--x:__MSG_missing__}`
    )
  })
})

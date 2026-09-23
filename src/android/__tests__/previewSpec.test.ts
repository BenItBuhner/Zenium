import { describe, expect, it } from 'vitest'
import {
  PREVIEW_MEDIA,
  PREVIEW_OVERLAYS,
  PREVIEW_PRIVATE_SURFACES,
  PREVIEW_PULL_MAX,
  PREVIEW_WEBAPP_SURFACES,
  parsePreviewSeed,
  parsePreviewSpec,
  parsePreviewSteps
} from '../previewSpec'

describe('parsePreviewSeed', () => {
  it('seeds the private tabs’ lock and the device’s screen lock on any spec, leaving the rest alone', () => {
    expect(parsePreviewSeed('private=page')).toEqual({
      rules: null,
      lock: false,
      screenLock: null,
      bar: null,
      siteData: null
    })
    // The lock on (INC-05): the cover over a private tab in front, or over the Private pane.
    expect(parsePreviewSeed('private=page&lock=on')).toMatchObject({ lock: true })
    expect(parsePreviewSeed('#private=overview&lock=1')).toMatchObject({ lock: true })
    expect(parsePreviewSeed('private=page&lock=off')).toMatchObject({ lock: false })
    // No screen lock on the device (SET-17): the switch disabled; `on` says one is set.
    expect(parsePreviewSeed('page=settings&section=privacy&screenlock=off')).toMatchObject({
      screenLock: false
    })
    expect(parsePreviewSeed('page=settings&screenlock=on')).toMatchObject({ screenLock: true })
    // `rules=` rides along as before.
    expect(parsePreviewSeed('page=settings&rules=3&lock=on&screenlock=off')).toEqual({
      rules: 3,
      lock: true,
      screenLock: false,
      bar: null,
      siteData: null
    })
  })

  it('seeds the site-data policy and the viewer’s sample from `sitedata=`', () => {
    // The sample alone: some origins listed, the active tab's site on no list.
    expect(parsePreviewSeed('page=settings&section=privacy&sitedata=some')).toMatchObject({
      siteData: { origins: 'some', site: null, blockAll: false, exit: false }
    })
    // The active tab's site on a list (Chrome's names and the lists' own), the browser-wide
    // block-all, the clear-on-exit types on; the sample defaults to `some` when only they are named.
    expect(parsePreviewSeed('siteinfo=cookies&sitedata=many,never')).toMatchObject({
      siteData: { origins: 'many', site: 'block' }
    })
    expect(parsePreviewSeed('sitedata=block')).toMatchObject({
      siteData: { origins: 'some', site: 'block' }
    })
    expect(parsePreviewSeed('sitedata=allow')).toMatchObject({ siteData: { site: 'allow' } })
    expect(parsePreviewSeed('sitedata=clear,exit')).toMatchObject({
      siteData: { site: 'clearOnExit', exit: true }
    })
    expect(parsePreviewSeed('sitedata=none,BlockAll')).toMatchObject({
      siteData: { origins: 'none', blockAll: true, site: null }
    })
    // Unknown words are left alone.
    expect(parsePreviewSeed('sitedata=whatever')).toMatchObject({
      siteData: { origins: 'some', site: null, blockAll: false, exit: false }
    })
  })

  it('docks the phone bar where the spec says, leaving the setting alone otherwise', () => {
    expect(parsePreviewSeed('page=newtab&bar=top')).toMatchObject({ bar: 'top' })
    expect(parsePreviewSeed('page=newtab&ntp=scrub:40&bar=bottom')).toMatchObject({
      bar: 'bottom'
    })
    expect(parsePreviewSeed('page=newtab&bar=left')).toMatchObject({ bar: null })
    expect(parsePreviewSeed('page=newtab')).toMatchObject({ bar: null })
  })
})

describe('parsePreviewSpec', () => {
  it('opens a known overlay by name', () => {
    expect(parsePreviewSpec('overlay=history')).toEqual({ kind: 'overlay', overlay: 'history' })
    for (const overlay of PREVIEW_OVERLAYS) {
      expect(parsePreviewSpec(`overlay=${overlay}`)).toEqual({ kind: 'overlay', overlay })
    }
  })

  it('types into the find bar, decoding the text as a query string would', () => {
    expect(parsePreviewSpec('find=coffee')).toEqual({ kind: 'find', text: 'coffee' })
    expect(parsePreviewSpec('find=hot%20tea+please')).toEqual({
      kind: 'find',
      text: 'hot tea please'
    })
    expect(parsePreviewSpec('find=')).toEqual({ kind: 'find', text: '' })
  })

  it('prefers the overlay when both are given and ignores a leading hash', () => {
    expect(parsePreviewSpec('#overlay=downloads&find=x')).toEqual({
      kind: 'overlay',
      overlay: 'downloads'
    })
    expect(parsePreviewSpec('#find=x')).toEqual({ kind: 'find', text: 'x' })
  })

  it('lands on an overlay’s section when one is named', () => {
    expect(parsePreviewSpec('overlay=history&section=host:a.test')).toEqual({
      kind: 'overlay',
      overlay: 'history',
      section: 'host:a.test'
    })
    expect(parsePreviewSpec('overlay=history&section=')).toEqual({
      kind: 'overlay',
      overlay: 'history'
    })
  })

  it('takes steps on an overlay once it is up: a row held for selection mode, a row tapped', () => {
    expect(parsePreviewSpec('overlay=history&then=hold:Example Domain;tap:Wikipedia')).toEqual({
      kind: 'overlay',
      overlay: 'history',
      then: [
        { kind: 'hold', text: 'Example Domain' },
        { kind: 'tap', text: 'Wikipedia' }
      ]
    })
  })

  it('knows no Settings, Shortcuts or Sync overlay: on this host Settings is a tab (page=settings)', () => {
    expect(parsePreviewSpec('overlay=settings')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('overlay=settings&section=accessibility')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('overlay=shortcuts')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('overlay=sync')).toEqual({ kind: 'idle' })
  })

  it('opens the zoom sheet at a factor, or as it is', () => {
    expect(parsePreviewSpec('zoom=1.5')).toEqual({ kind: 'zoom', factor: 1.5 })
    expect(parsePreviewSpec('zoom=')).toEqual({ kind: 'zoom', factor: null })
    expect(parsePreviewSpec('zoom=abc')).toEqual({ kind: 'zoom', factor: null })
    expect(parsePreviewSpec('find=x&zoom=2')).toEqual({ kind: 'find', text: 'x' })
  })

  it('docks the read-aloud player at a scripted status, speed and with its voice picker', () => {
    expect(parsePreviewSpec('readAloud=')).toEqual({
      kind: 'readAloud',
      status: 'playing',
      rate: 1,
      voices: false
    })
    expect(parsePreviewSpec('readAloud=paused&rate=1.5')).toEqual({
      kind: 'readAloud',
      status: 'paused',
      rate: 1.5,
      voices: false
    })
    expect(parsePreviewSpec('readAloud=loading&voices')).toEqual({
      kind: 'readAloud',
      status: 'loading',
      rate: 1,
      voices: true
    })
    // An unknown status is the default; a rate off the model's range too.
    expect(parsePreviewSpec('readAloud=idle&rate=9')).toEqual({
      kind: 'readAloud',
      status: 'playing',
      rate: 1,
      voices: false
    })
    expect(parsePreviewSpec('zoom=2&readAloud=paused')).toEqual({ kind: 'zoom', factor: 2 })
    expect(parsePreviewSpec('readAloud=error&reader=article')).toEqual({
      kind: 'readAloud',
      status: 'error',
      rate: 1,
      voices: false
    })
  })

  it('puts the active tab in Reader View on the stand-in article, with or without its text sheet', () => {
    expect(parsePreviewSpec('reader=article')).toEqual({ kind: 'reader', preferences: false })
    expect(parsePreviewSpec('reader=preferences')).toEqual({ kind: 'reader', preferences: true })
    expect(parsePreviewSpec('zoom=2&reader=article')).toEqual({ kind: 'zoom', factor: 2 })
    expect(parsePreviewSpec('reader=article&error=-105')).toEqual({
      kind: 'reader',
      preferences: false
    })
  })

  it('groups the active tab with this many members, behind a page but ahead of an overlay, its steps kept', () => {
    expect(parsePreviewSpec('group=3')).toEqual({ kind: 'group', members: 3 })
    expect(parsePreviewSpec('group=12&then=tap:Show group, Research;overview')).toEqual({
      kind: 'group',
      members: 12,
      then: [{ kind: 'tap', text: 'Show group, Research' }, { kind: 'overview' }]
    })
    // A group is at least the tab itself and at most what a strip can be asked to scroll.
    expect(parsePreviewSpec('group=0')).toEqual({ kind: 'group', members: 1 })
    expect(parsePreviewSpec('group=99')).toEqual({ kind: 'group', members: 24 })
    expect(parsePreviewSpec('group=')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('group=abc')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('group=3&overlay=history')).toEqual({ kind: 'group', members: 3 })
    expect(parsePreviewSpec('page=settings&group=3')).toEqual({ kind: 'page', page: 'settings' })
  })

  it('opens the app menu, behind an overlay but ahead of the bars', () => {
    expect(parsePreviewSpec('menu=app')).toEqual({ kind: 'menu', menu: 'app' })
    expect(parsePreviewSpec('menu=app&show=Desktop Site')).toEqual({
      kind: 'menu',
      menu: 'app',
      show: 'Desktop Site'
    })
    expect(parsePreviewSpec('menu=app&find=x')).toEqual({ kind: 'menu', menu: 'app' })
    expect(parsePreviewSpec('menu=app&zoom=2')).toEqual({ kind: 'menu', menu: 'app' })
    // `article`: the page reads as an article, for the items an article enables.
    expect(parsePreviewSpec('menu=app&show=Listen to This Page&article')).toEqual({
      kind: 'menu',
      menu: 'app',
      show: 'Listen to This Page',
      article: true
    })
    expect(parsePreviewSpec('overlay=history&menu=app')).toEqual({
      kind: 'overlay',
      overlay: 'history'
    })
    // The Tabs button's quick menu is the other one; a menu with no sheet of its own is idle.
    expect(parsePreviewSpec('menu=tabs')).toEqual({ kind: 'menu', menu: 'tabs' })
    expect(parsePreviewSpec('menu=context')).toEqual({ kind: 'idle' })
  })

  it('opens one of the chrome’s sheets by name, behind the menu, its rows tapped or held', () => {
    expect(parsePreviewSpec('sheet=extensions')).toEqual({ kind: 'sheet', sheet: 'extensions' })
    expect(parsePreviewSpec('sheet=extensions&extensions=installed')).toEqual({
      kind: 'sheet',
      sheet: 'extensions'
    })
    expect(
      parsePreviewSpec('sheet=extensions&then=hold:Dark Reader;tap:Remove from Zenium')
    ).toEqual({
      kind: 'sheet',
      sheet: 'extensions',
      then: [
        { kind: 'hold', text: 'Dark Reader' },
        { kind: 'tap', text: 'Remove from Zenium' }
      ]
    })
    expect(parsePreviewSpec('sheet=customise')).toEqual({ kind: 'sheet', sheet: 'customise' })
    expect(parsePreviewSpec('sheet=promo')).toEqual({ kind: 'sheet', sheet: 'promo' })
    expect(parsePreviewSpec('menu=app&sheet=extensions')).toEqual({ kind: 'menu', menu: 'app' })
    expect(parsePreviewSpec('sheet=extensions&prompt=camera')).toEqual({
      kind: 'sheet',
      sheet: 'extensions'
    })
    expect(parsePreviewSpec('sheet=recently-closed')).toEqual({ kind: 'idle' })
    expect(parsePreviewSteps('hold:Dark Reader;hold:;hold')).toEqual([
      { kind: 'hold', text: 'Dark Reader' }
    ])
  })

  it('opens an extension’s page as a tab by id and path, behind an internal page but ahead of a group', () => {
    const id = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'
    expect(parsePreviewSpec(`extension-page=${id}/ui/options/index.html`)).toEqual({
      kind: 'extension-page',
      id,
      path: 'ui/options/index.html'
    })
    expect(parsePreviewSpec(`extension-page=${id}&extensions=installed&then=overview`)).toEqual({
      kind: 'extension-page',
      id,
      path: '',
      then: [{ kind: 'overview' }]
    })
    expect(parsePreviewSpec(`extension-page=${id}//options.html`)).toEqual({
      kind: 'extension-page',
      id,
      path: 'options.html'
    })
    expect(parsePreviewSpec(`extension-page=${id}/options.html&group=3`)).toEqual({
      kind: 'extension-page',
      id,
      path: 'options.html'
    })
    expect(parsePreviewSpec(`page=settings&extension-page=${id}/options.html`)).toEqual({
      kind: 'page',
      page: 'settings'
    })
    // Not an id as Chrome forms them: no such state.
    expect(parsePreviewSpec('extension-page=dark-reader/options.html')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('extension-page=')).toEqual({ kind: 'idle' })
  })

  it('shows a private tab and the overview panes by surface', () => {
    for (const surface of PREVIEW_PRIVATE_SURFACES) {
      expect(parsePreviewSpec(`private=${surface}`)).toEqual({
        kind: 'private',
        surface,
        url: null
      })
    }
    expect(parsePreviewSpec('private=page&url=https://example.org/')).toEqual({
      kind: 'private',
      surface: 'page',
      url: 'https://example.org/'
    })
    // The bare `private` flag belongs to a download.
    expect(parsePreviewSpec('download=a.pdf&private')).toMatchObject({
      kind: 'download',
      download: { private: true }
    })
    // Ahead of the bars and of everything below them (#135's slot), behind the sheets.
    expect(parsePreviewSpec('private=newtab&webapp=banner')).toEqual({
      kind: 'private',
      surface: 'newtab',
      url: null
    })
    expect(parsePreviewSpec('private=empty&download=a.pdf')).toMatchObject({ kind: 'private' })
    expect(parsePreviewSpec('menu=app&private=empty')).toEqual({ kind: 'menu', menu: 'app' })
    // The third-party cookie setting for the new tab page's switch: a known mode rides along on
    // any private surface, an unknown one is dropped.
    expect(parsePreviewSpec('private=newtab&cookies=allow')).toEqual({
      kind: 'private',
      surface: 'newtab',
      url: null,
      cookies: 'allow'
    })
    expect(parsePreviewSpec('private=new&cookies=block')).toMatchObject({ cookies: 'block' })
    expect(parsePreviewSpec('private=newtab&cookies=maybe')).toEqual({
      kind: 'private',
      surface: 'newtab',
      url: null
    })
    // Steps once the surface is up: the overview's header menu and its question; none, no key.
    expect(
      parsePreviewSpec('private=overview&then=tap:More;tap:Close%20Private%20Tabs%20(1)')
    ).toEqual({
      kind: 'private',
      surface: 'overview',
      url: null,
      then: [
        { kind: 'tap', text: 'More' },
        { kind: 'tap', text: 'Close Private Tabs (1)' }
      ]
    })
    expect(parsePreviewSpec('private=overview&then=')).toEqual({
      kind: 'private',
      surface: 'overview',
      url: null
    })
  })

  it('puts up messages and the load bar together', () => {
    expect(parsePreviewSpec('toast=Tab%20closed&action=Undo&banners=2&progress=0.6')).toEqual({
      kind: 'messages',
      toast: { message: 'Tab closed', action: 'Undo', error: false },
      banners: 2,
      progress: 0.6
    })
    expect(parsePreviewSpec('toast=Failed&kind=error')).toEqual({
      kind: 'messages',
      toast: { message: 'Failed', action: null, error: true },
      banners: 0,
      progress: null
    })
    // Counts and fractions are clamped; junk reads as none.
    expect(parsePreviewSpec('banners=9&progress=7')).toMatchObject({ banners: 3, progress: 1 })
    expect(parsePreviewSpec('banners=x&progress=y')).toMatchObject({ banners: 0, progress: null })
    // Find wins over the messages.
    expect(parsePreviewSpec('find=x&toast=y')).toEqual({ kind: 'find', text: 'x' })
  })

  it('raises an "Add to Home screen" surface by name', () => {
    for (const surface of PREVIEW_WEBAPP_SURFACES) {
      expect(parsePreviewSpec(`webapp=${surface}`)).toEqual({ kind: 'webapp', surface })
    }
    expect(parsePreviewSpec('webapp=splash')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('find=x&webapp=banner')).toEqual({ kind: 'find', text: 'x' })
  })

  it('opens the tab overview, behind every other state', () => {
    expect(parsePreviewSpec('overview')).toEqual({ kind: 'overview' })
    expect(parsePreviewSpec('overview=1')).toEqual({ kind: 'overview' })
    expect(parsePreviewSpec('find=x&overview')).toEqual({ kind: 'find', text: 'x' })
    // Steps once the grid is up: the header's menu into the select-tabs mode, a card picked, a
    // card's hold sheet by a resting finger (`press`); an empty list leaves the key off.
    expect(
      parsePreviewSpec('overview&then=tap:More;tap:Select Tabs;tap:Coffee;press:Tea;bogus:x')
    ).toEqual({
      kind: 'overview',
      then: [
        { kind: 'tap', text: 'More' },
        { kind: 'tap', text: 'Select Tabs' },
        { kind: 'tap', text: 'Coffee' },
        { kind: 'press', text: 'Tea' }
      ]
    })
    expect(parsePreviewSpec('overview&then=')).toEqual({ kind: 'overview' })
  })

  it('treats idle, an unknown overlay and junk as idle', () => {
    expect(parsePreviewSpec('idle')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('overlay=kitchen-sink')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('nonsense&more=1')).toEqual({ kind: 'idle' })
  })

  it('scrolls a row of an overlay into view when asked', () => {
    expect(parsePreviewSpec('overlay=addons&show=Dark%20Reader')).toEqual({
      kind: 'overlay',
      overlay: 'addons',
      show: 'Dark Reader'
    })
    expect(parsePreviewSpec('overlay=addons&show=')).toEqual({
      kind: 'overlay',
      overlay: 'addons'
    })
  })

  it('holds a pull at a percentage of the threshold, or lets go past it', () => {
    expect(parsePreviewSpec('pull=40')).toEqual({ kind: 'pull', progress: 0.4, released: false })
    expect(parsePreviewSpec('pull=100')).toEqual({ kind: 'pull', progress: 1, released: false })
    expect(parsePreviewSpec('pull=refresh')).toEqual({
      kind: 'pull',
      progress: PREVIEW_PULL_MAX,
      released: true
    })
    // Clamped to what the page can show, and never negative.
    expect(parsePreviewSpec('pull=900')).toEqual({
      kind: 'pull',
      progress: PREVIEW_PULL_MAX,
      released: false
    })
    expect(parsePreviewSpec('pull=-5')).toEqual({ kind: 'pull', progress: 0, released: false })
    expect(parsePreviewSpec('pull=')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('pull=lots')).toEqual({ kind: 'idle' })
    // The find bar and overlays come first.
    expect(parsePreviewSpec('find=x&pull=40')).toEqual({ kind: 'find', text: 'x' })
  })

  it("fails the active tab's load with a Chromium net:: code, naming the URL that failed", () => {
    expect(parsePreviewSpec('error=-105&url=http%3A%2F%2Fnonexistent.invalid%2F')).toEqual({
      kind: 'error',
      code: -105,
      url: 'http://nonexistent.invalid/'
    })
    expect(parsePreviewSpec('error=-102&url=http://localhost:1/')).toEqual({
      kind: 'error',
      code: -102,
      url: 'http://localhost:1/'
    })
    expect(parsePreviewSpec('error=-106')).toEqual({ kind: 'error', code: -106, url: null })
    expect(parsePreviewSpec('error=-1&url=')).toEqual({ kind: 'error', code: -1, url: null })
    expect(parsePreviewSpec('error=')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('error=dns')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('error=-1.5')).toEqual({ kind: 'idle' })
    // A pull comes first.
    expect(parsePreviewSpec('pull=40&error=-105')).toEqual({
      kind: 'pull',
      progress: 0.4,
      released: false
    })
  })

  it('opens an internal page in its tab, on a section, searched, scrolled, then stepped through', () => {
    expect(parsePreviewSpec('page=settings')).toEqual({ kind: 'page', page: 'settings' })
    expect(parsePreviewSpec('page=settings&section=look&search=dark&show=Enable%20Glance')).toEqual(
      {
        kind: 'page',
        page: 'settings',
        section: 'look',
        search: 'dark',
        show: 'Enable Glance'
      }
    )
    // The page wins over an overlay and a find in the same spec; an unknown page is not a page.
    expect(parsePreviewSpec('page=settings&overlay=history&find=x').kind).toBe('page')
    expect(parsePreviewSpec('page=nope&find=x')).toEqual({ kind: 'find', text: 'x' })

    expect(
      parsePreviewSpec('page=settings&section=containers&then=tap:Work;tap:Delete%20container')
    ).toEqual({
      kind: 'page',
      page: 'settings',
      section: 'containers',
      then: [
        { kind: 'tap', text: 'Work' },
        { kind: 'tap', text: 'Delete container' }
      ]
    })
    expect(parsePreviewSpec('page=settings&then=overview')).toEqual({
      kind: 'page',
      page: 'settings',
      then: [{ kind: 'overview' }]
    })
    expect(parsePreviewSpec('page=settings&then=urlbar;back')).toEqual({
      kind: 'page',
      page: 'settings',
      then: [{ kind: 'urlbar' }, { kind: 'back' }]
    })
    // Blanks, an empty tap and unknown steps are dropped; no steps means no `then` at all.
    expect(parsePreviewSteps(' tap:Colour scheme ; ; tap: ; wave ; back ')).toEqual([
      { kind: 'tap', text: 'Colour scheme' },
      { kind: 'back' }
    ])
    expect(parsePreviewSteps(null)).toEqual([])
    expect(parsePreviewSpec('page=settings&then=')).toEqual({ kind: 'page', page: 'settings' })
    expect(parsePreviewSpec('page=settings&then=wave')).toEqual({ kind: 'page', page: 'settings' })
  })

  it('stages an autofill surface, a manager one scrolled and stepped through like a page', () => {
    expect(parsePreviewSpec('autofill=save-login')).toEqual({
      kind: 'autofill',
      surface: 'save-login'
    })
    expect(
      parsePreviewSpec(
        'autofill=manager&show=Payment%20methods&then=tap:Visa%20%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%204242'
      )
    ).toEqual({
      kind: 'autofill',
      surface: 'manager',
      show: 'Payment methods',
      then: [{ kind: 'tap', text: 'Visa \u2022\u2022\u2022\u2022 4242' }]
    })
    expect(parsePreviewSpec('autofill=manager&show=&then=')).toEqual({
      kind: 'autofill',
      surface: 'manager'
    })
    expect(parsePreviewSpec('autofill=bogus')).toEqual({ kind: 'idle' })
  })

  it('navigates the active tab to a sample PDF, the find bar and the steps taken along', () => {
    expect(parsePreviewSpec('pdf=sample')).toEqual({ kind: 'pdf', variant: 'sample' })
    for (const variant of ['sample', 'locked', 'broken', 'slow'] as const) {
      expect(parsePreviewSpec(`pdf=${variant}`)).toEqual({ kind: 'pdf', variant })
    }
    // `pdf` takes `find=` along as the bar over the viewer (empty opens it blank)...
    expect(parsePreviewSpec('pdf=sample&find=tide')).toEqual({
      kind: 'pdf',
      variant: 'sample',
      find: 'tide'
    })
    expect(parsePreviewSpec('pdf=sample&find=')).toEqual({
      kind: 'pdf',
      variant: 'sample',
      find: ''
    })
    // ...and steps: the bar's controls, a sheet's rows, a password typed.
    expect(
      parsePreviewSpec('pdf=locked&then=tap:Unlock;type:pdf-password=zenium;tap:Unlock')
    ).toEqual({
      kind: 'pdf',
      variant: 'locked',
      then: [
        { kind: 'tap', text: 'Unlock' },
        { kind: 'type', id: 'pdf-password', text: 'zenium' },
        { kind: 'tap', text: 'Unlock' }
      ]
    })
    // Behind autofill, ahead of a plain find.
    expect(parsePreviewSpec('autofill=save-login&pdf=sample')).toEqual({
      kind: 'autofill',
      surface: 'save-login'
    })
    expect(parsePreviewSpec('pdf=bogus&find=x')).toEqual({ kind: 'find', text: 'x' })
  })

  it('asks for a sheet on its expanded detent', () => {
    expect(parsePreviewSpec('overlay=downloads&expand')).toEqual({
      kind: 'overlay',
      overlay: 'downloads',
      expand: true
    })
    expect(parsePreviewSpec('overlay=downloads')).not.toHaveProperty('expand')
  })

  it('has the page report media by variant, the in-app player opened on request', () => {
    for (const variant of PREVIEW_MEDIA) {
      expect(parsePreviewSpec(`media=${variant}`)).toEqual({
        kind: 'media',
        variant,
        player: false
      })
      expect(parsePreviewSpec(`media=${variant}&player`)).toEqual({
        kind: 'media',
        variant,
        player: true
      })
    }
    expect(parsePreviewSpec('media=podcast')).toEqual({ kind: 'idle' })
    // `sheet=` names the chrome's own sheets, so beside `media=` a bare `sheet` opens nothing;
    // a named one wins over the media, as the precedence has it.
    expect(parsePreviewSpec('media=audio&sheet')).toEqual({
      kind: 'media',
      variant: 'audio',
      player: false
    })
    expect(parsePreviewSpec('media=audio&sheet=extensions')).toEqual({
      kind: 'sheet',
      sheet: 'extensions'
    })
    // An "Add to Home screen" surface wins over it; it wins over a transfer.
    expect(parsePreviewSpec('webapp=banner&media=audio')).toEqual({
      kind: 'webapp',
      surface: 'banner'
    })
    expect(parsePreviewSpec('media=video&download=a.bin').kind).toBe('media')
  })

  it('describes a transfer for the stand-in downloader, with sensible defaults', () => {
    expect(parsePreviewSpec('download=zenium-0.3.14-arm64.apk')).toEqual({
      kind: 'download',
      download: {
        filename: 'zenium-0.3.14-arm64.apk',
        url: 'https://downloads.example.com/zenium-0.3.14-arm64.apk',
        mimeType: 'application/vnd.android.package-archive',
        totalBytes: 48_217_088,
        receivedBytes: Math.round(48_217_088 * 0.4),
        bytesPerSecond: 2_400_000,
        paused: false,
        error: null,
        retrying: 0,
        deleted: false,
        private: false
      }
    })
    expect(
      parsePreviewSpec(
        'download=notes.txt&size=1000&at=25&speed=10&paused&fail=network-timeout&retrying=2&deleted&private&url=https%3A%2F%2Fx.test%2Fn&mime=text%2Fmarkdown'
      )
    ).toEqual({
      kind: 'download',
      download: {
        filename: 'notes.txt',
        url: 'https://x.test/n',
        mimeType: 'text/markdown',
        totalBytes: 1000,
        receivedBytes: 250,
        bytesPerSecond: 10,
        paused: true,
        error: 'network-timeout',
        retrying: 2,
        deleted: true,
        private: true
      }
    })
    // Junk numbers fall back; a percentage past the whole file is the whole file; a pull wins.
    const junk = parsePreviewSpec('download=a.bin&size=big&at=140')
    expect(junk.kind === 'download' && junk.download.totalBytes).toBe(48_217_088)
    expect(junk.kind === 'download' && junk.download.receivedBytes).toBe(48_217_088)
    expect(junk.kind === 'download' && junk.download.mimeType).toBe('application/octet-stream')
    expect(parsePreviewSpec('pull=40&download=a.bin').kind).toBe('pull')
    expect(parsePreviewSpec('error=-105&download=a.bin').kind).toBe('error')
    expect(parsePreviewSpec('download=')).toEqual({ kind: 'idle' })
  })

  it('pins the layering at its seams: unresponsive over error over screenshot over the messages, and qr between download and popups', () => {
    // The parser's order is the doc sentence's: the earlier surface wins the spec when two are
    // given, whatever the parameters' order in the string.
    expect(parsePreviewSpec('error=-105&unresponsive').kind).toBe('unresponsive')
    expect(parsePreviewSpec('unresponsive&error=-105').kind).toBe('unresponsive')
    expect(parsePreviewSpec('screenshot=card&error=-105').kind).toBe('error')
    expect(parsePreviewSpec('unresponsive&screenshot=card').kind).toBe('unresponsive')
    expect(parsePreviewSpec('toast=Saved&screenshot=card').kind).toBe('screenshot')
    expect(parsePreviewSpec('screenshot=card&banners=1&progress=0.5').kind).toBe('screenshot')
    // A crash stands ahead of the unresponsive prompt; a network state ahead of the crash.
    expect(parsePreviewSpec('unresponsive&crash=').kind).toBe('crash')
    expect(parsePreviewSpec('crash=&network=offline').kind).toBe('network')
    // `qr` sits between `download` and `popups`: a transfer wins it, it wins the blocked pop-ups.
    expect(parsePreviewSpec('qr=&download=a.bin').kind).toBe('download')
    expect(parsePreviewSpec('popups=2&qr=wifi')).toEqual({ kind: 'qr', script: 'wifi' })
    expect(parsePreviewSpec('qr=')).toEqual({ kind: 'qr', script: 'url' })
    expect(parsePreviewSpec('media=audio&qr=').kind).toBe('media')
    // Past `popups`: the security prompt, voice, the overview, the URL bar's editor, idle.
    expect(parsePreviewSpec('prompt=http-auth&popups=1').kind).toBe('popups')
    expect(parsePreviewSpec('voice=&prompt=http-auth').kind).toBe('prompt')
    expect(parsePreviewSpec('overview&voice=').kind).toBe('voice')
    expect(parsePreviewSpec('urlbar=&overview').kind).toBe('overview')
  })

  it('raises a permission prompt from the active page, behind the menu but ahead of the bars', () => {
    expect(parsePreviewSpec('prompt=camera')).toEqual({ kind: 'permission', permission: 'camera' })
    expect(parsePreviewSpec('prompt=notifications&find=x')).toEqual({
      kind: 'permission',
      permission: 'notifications'
    })
    expect(parsePreviewSpec('menu=app&prompt=camera')).toEqual({ kind: 'menu', menu: 'app' })
    expect(parsePreviewSpec('prompt=')).toEqual({ kind: 'idle' })
    // The security dialogs' two `prompt=` values are theirs (#62), and come up after the bars.
    expect(parsePreviewSpec('prompt=http-auth')).toMatchObject({
      kind: 'prompt',
      prompt: 'http-auth'
    })
    expect(parsePreviewSpec('prompt=certificate&find=x')).toEqual({ kind: 'find', text: 'x' })
  })

  it('opens a private tab, blank or on a page, as #135 first spelt it', () => {
    const blank = { kind: 'private', surface: 'newtab', url: null }
    expect(parsePreviewSpec('private=new')).toEqual(blank)
    expect(parsePreviewSpec('private=1')).toEqual(blank)
    expect(parsePreviewSpec('private=https%3A%2F%2Fexample.com%2F')).toEqual({
      kind: 'private',
      surface: 'page',
      url: 'https://example.com/'
    })
    expect(parsePreviewSpec('private=')).toEqual({ kind: 'idle' })
    // A sheet comes first, the bars after.
    expect(parsePreviewSpec('private=new&prompt=camera')).toEqual({
      kind: 'permission',
      permission: 'camera'
    })
    expect(parsePreviewSpec('private=new&find=x')).toEqual(blank)
  })

  it('reads the pill editor: its text, a new tab, the stand-in clipboard and its steps', () => {
    // Search-ready over the page: nothing typed, the clipboard untouched.
    expect(parsePreviewSpec('urlbar=')).toEqual({
      kind: 'urlbar',
      text: '',
      newTab: false,
      clip: null
    })
    expect(parsePreviewSpec('urlbar=wiki&newtab')).toEqual({
      kind: 'urlbar',
      text: 'wiki',
      newTab: true,
      clip: null
    })
    // The clipboard row: the stand-in clipboard seeded (an empty `clip=` clears it), Show pressed.
    expect(parsePreviewSpec('urlbar=&clip=https%3A%2F%2Fexample.com%2F&then=tap:Show')).toEqual({
      kind: 'urlbar',
      text: '',
      newTab: false,
      clip: 'https://example.com/',
      then: [{ kind: 'tap', text: 'Show' }]
    })
    expect(parsePreviewSpec('urlbar=&clip=')).toMatchObject({ clip: '' })
    // A form filled in: `type:<id>=<text>` keeps every `=` after the first in the text.
    expect(
      parsePreviewSpec(
        'page=settings&section=search&then=tap:Add search engine;type:search-engine-url=https://x.test/?q=%s;type:=x;type:name'
      )
    ).toMatchObject({
      then: [
        { kind: 'tap', text: 'Add search engine' },
        { kind: 'type', id: 'search-engine-url', text: 'https://x.test/?q=%s' }
      ]
    })
    // A download wins over the editor; no `urlbar` is idle.
    expect(parsePreviewSpec('download=a.bin&urlbar=').kind).toBe('download')
    expect(parsePreviewSpec('newtab')).toEqual({ kind: 'idle' })
  })
})

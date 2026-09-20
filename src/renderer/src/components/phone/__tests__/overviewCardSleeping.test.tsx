// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Tab } from '@shared/types'
import { OverviewCard } from '../OverviewCard'

/*
 * A sleeping page's card in the phone tab overview (CT-22, Edge's faded tab): the card carries
 * `data-discarded`, its title row shows the moon glyph the sidebar's row shows, its name to a
 * screen reader says the page is sleeping, and main.css fades the title, the favicon, the glyph
 * and the picture to the deemphasised 69% under that attribute – the card itself keeps its
 * elevation, since its tap is what wakes the page.
 */

function tab(patch: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    spaceId: 'space',
    containerId: 'default',
    url: 'https://news.example/story',
    title: 'The story',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    ...patch
  } as Tab
}

function card(t: Tab): string {
  return renderToStaticMarkup(
    createElement(OverviewCard, {
      tab: t,
      position: 2,
      count: 3,
      active: false,
      hidden: false,
      onPick: () => undefined,
      onClose: () => undefined,
      lift: {
        enabled: true,
        swipeable: true,
        scroller: () => null,
        onMenu: () => undefined,
        onHover: () => null,
        onDrop: () => undefined
      }
    })
  )
}

describe('a sleeping tab in the overview', () => {
  it('marks the card, shows the moon by the title and says so to a screen reader', () => {
    const markup = card(tab({ discarded: true }))
    expect(markup).toContain('data-discarded="true"')
    // The composed name (A11Y-01): title, place, then the sleeping state as one more word.
    expect(markup).toContain('aria-label="The story, tab 2 of 3, sleeping"')
    expect(markup).toContain('zen-overview-card-sleeping')
    expect(markup).toContain('data-sleeping=""')
    // The close button stays: a sleeping tab closes like any other.
    expect(markup).toContain('aria-label="Close The story"')
  })

  it('draws a loaded page without any of it', () => {
    const markup = card(tab())
    expect(markup).not.toContain('data-discarded')
    expect(markup).toContain('aria-label="The story, tab 2 of 3"')
    expect(markup).not.toContain('zen-overview-card-sleeping')
  })

  it('fades the title, favicon, glyph and picture to 69% under the attribute, never the card', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8').replace(
      /\s+/g,
      ' '
    )
    for (const part of ['title', 'favicon', 'sleeping', 'preview']) {
      expect(css).toContain(`.zen-overview-card[data-discarded='true'] .zen-overview-card-${part}`)
    }
    const rule = css.match(
      /\.zen-overview-card\[data-discarded='true'\] \.zen-overview-card-preview \{([^}]*)\}/
    )?.[1]
    expect(rule).toContain('opacity: 0.69')
    expect(css).not.toMatch(/\.zen-overview-card\[data-discarded='true'\] \{/)
    // The pieces the rule names are the ones the card draws.
    const markup = card(tab({ discarded: true }))
    for (const part of ['title', 'favicon', 'preview']) {
      expect(markup).toContain(`zen-overview-card-${part}`)
    }
  })
})

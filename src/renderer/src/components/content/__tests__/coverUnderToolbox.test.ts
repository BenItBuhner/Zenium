import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The page's cover under a docked developer toolbox (design language v2 §9.29). With a menu or
 * an overlay up the chrome swaps the live view for the host's picture of the page; the picture
 * is the page's part of the frame's box alone – the toolbox is not in `capturePage` – and drawn
 * `object-cover` it was scaled up over the whole box, the page's text 1.4× and the toolbox
 * gone (the W4-13 drive's `extra-devtools-menu-while-docked` still). Docked, the picture is
 * drawn at its own size in the page's corner instead – and the toolbox's own picture, the
 * host's capture of its frontend at the box's size, lies under it (W5-5, the lead's ruling 6 on
 * #414): the menu leaves the toolbox in view rather than the frame's ground.
 */

const source = readFileSync(resolve(__dirname, '../ContentArea.tsx'), 'utf8')

describe('the cover under a docked toolbox (§9.29)', () => {
  it('draws the page’s picture in the page’s corner at its own size while a toolbox is docked in the frame – the corner the toolbox leaves it', () => {
    expect(source).toContain(
      "import { devtoolsDockOf, devtoolsDockedInFrame } from '@renderer/lib/contentRadius'"
    )
    expect(source).toContain('const toolboxDocked = devtoolsDockedInFrame(state)')
    // The tab in front's own dock (`Tab.devtools`): the page's picture is anchored top-left with
    // the toolbox at the bottom or the right, top-right with the toolbox at the left.
    expect(source).toContain('const toolboxDock = tab ? devtoolsDockOf(state, tab.id) : null')
    expect(source).toMatch(
      /const coverFit =\s*toolboxDocked && !group\s*\?\s*toolboxDock === 'left'\s*\?\s*'object-contain object-right-top'\s*:\s*'object-contain object-left-top'\s*:\s*'object-cover object-top'/
    )
    expect(source).toMatch(/className=\{cn\('relative h-full w-full', coverFit\)\}/)
  })

  it('lays the toolbox’s picture under the page’s, the whole box, while the tab’s toolbox is docked – an untracked cover, so the page view waits for the page’s picture alone', () => {
    const toolbox = source.slice(source.indexOf('data-testid="toolbox-cover"'))
    expect(toolbox.length).toBeGreaterThan(0)
    expect(source).toMatch(/\{ui\.toolboxSnapshot && toolboxDocked && !group \? \(\s*<img/)
    expect(toolbox).toContain('src={ui.toolboxSnapshot}')
    expect(toolbox).toContain('decoding="sync"')
    expect(toolbox).toMatch(
      /className="absolute inset-0 h-full w-full object-contain object-left-top"/
    )
    // The toolbox's picture goes before the page's in order, and the page's is positioned: it
    // paints over the toolbox's, covering the page's hole in it.
    expect(source.indexOf('data-testid="toolbox-cover"')).toBeLessThan(
      source.indexOf("cn('relative h-full w-full', coverFit)")
    )
    // The toolbox's picture is not a `CoverImage`: nothing of it is tracked as the page's cover.
    const before = source.slice(0, source.indexOf('data-testid="toolbox-cover"'))
    const tag = before.slice(before.lastIndexOf('<'))
    expect(tag.startsWith('<img')).toBe(true)
  })
})

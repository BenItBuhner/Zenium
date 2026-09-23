import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The page's cover under a docked developer toolbox (design language v2 §9.29). With a menu or
 * an overlay up the chrome swaps the live view for the host's picture of the page; the picture
 * is the page's part of the frame's box alone – the toolbox is not in `capturePage` – and drawn
 * `object-cover` it was scaled up over the whole box, the page's text 1.4× and the toolbox
 * gone (the W4-13 drive's `extra-devtools-menu-while-docked` still). Docked, the picture is
 * drawn at its own size in the page's corner instead, the toolbox's band left to the frame's
 * ground.
 */

const source = readFileSync(resolve(__dirname, '../ContentArea.tsx'), 'utf8')

describe('the cover under a docked toolbox (§9.29)', () => {
  it('draws the picture in the page’s corner at its own size while a toolbox is docked in the frame', () => {
    expect(source).toContain("import { devtoolsDockedInFrame } from '@renderer/lib/contentRadius'")
    expect(source).toContain('const toolboxDocked = devtoolsDockedInFrame(state)')
    expect(source).toMatch(
      /toolboxDocked && !group\s*\?\s*'object-contain object-left-top'\s*:\s*'object-cover object-top'/
    )
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HoverCardFrame } from '@renderer/lib/hoverCard'
import { hoverCardPost } from '../hoverCardPost'

/*
 * What leaves the chrome on `chrome.hoverCard` (TABLET-05): the controller's frame as it is on
 * the tablet layout, a take-down for `null` – and a take-down for any frame on the phone layout,
 * the card being the tablet's by rule (`boot.ts`'s `syncHoverCard` reads the layout per frame).
 */

const frame: HoverCardFrame = {
  visible: true,
  tabId: 'b',
  title: 'B',
  host: 'b.example',
  lines: [],
  preview: true,
  url: 'https://b.example/page',
  anchor: { x: 8, y: 120, width: 224, height: 44 },
  sidebar: { x: 0, y: 56, width: 240, height: 744 },
  viewport: { width: 1280, height: 800 },
  by: 'pointer'
}

describe('hoverCardPost', () => {
  it('on the tablet layout the frame goes out as it is', () => {
    expect(hoverCardPost(frame, false)).toBe(frame)
  })

  it('on the phone layout a frame goes out as a take-down: no card stands over a phone page', () => {
    expect(hoverCardPost(frame, true)).toEqual({ visible: false })
  })

  it('null is a take-down on either layout', () => {
    expect(hoverCardPost(null, false)).toEqual({ visible: false })
    expect(hoverCardPost(null, true)).toEqual({ visible: false })
  })

  // The boot module is nothing a test imports (it boots the core), so its one line for the card
  // is pinned as source: the host's `apply` posts what `hoverCardPost` makes of the frame, the
  // layout read as the frame leaves.
  it('`boot.ts` sends the host `hoverCardPost(frame, isPhone())`, per frame', () => {
    const boot = readFileSync(resolve(__dirname, '../boot.ts'), 'utf8')
    expect(boot).toMatch(
      /apply: \(frame\) => bridge\.post\('chrome\.hoverCard', hoverCardPost\(frame, isPhone\(\)\)\)/
    )
  })
})

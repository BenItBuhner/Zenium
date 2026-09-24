// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RowGroup, SettingsRow } from '../model'
import { GroupList, RowView, type SheetRequest } from '../rows'

/*
 * A row that closes a run stands under the builder's hairline (`RowBase.hairline`; the #453
 * lead check on Settings › Sync › Other devices): the one `--v2-border` line the landing draws
 * between its runs (`.zen-settings-hairline`), here between a run of glyph rows and the
 * glyph-less action row after them – a separator where the leading edges part, not a glyph or
 * an empty slot drawn for alignment. `GroupList` draws it before the flagged row and nowhere
 * else: never over a group's first row, never in a search's results, where a row stands alone.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const device = (id: string, label: string): SettingsRow => ({
  kind: 'info',
  id,
  label,
  leading: <svg data-testid="glyph" aria-hidden />,
  trailing: <span>Just now</span>
})

const action: SettingsRow = {
  kind: 'item',
  id: 'sync-remote-tabs',
  label: 'Tabs from other devices',
  description: '3 tabs on 2 devices',
  hairline: true,
  sheet: { title: 'Tabs from other devices', groups: [] }
}

const group = (rows: SettingsRow[]): RowGroup => ({
  id: 'sync-devices',
  heading: 'Other devices',
  rows
})

/** The group's children in order: `hr` for the hairline, else the row's id. */
const sequence = (h: HTMLElement): string[] =>
  [...h.querySelector('[data-group="sync-devices"]')!.children]
    .filter((el) => el.tagName !== 'H3')
    .map((el) => (el.tagName === 'HR' ? 'hr' : (el.getAttribute('data-row') ?? el.tagName)))

describe('the hairline over a row that closes a run', () => {
  it('is drawn once, right before the flagged row, on both layouts – the builder’s run separator, a `--v2-border` line and nothing else', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    for (const variant of ['desktop', 'phone'] as const) {
      const h = render(
        <GroupList
          groups={[
            group([
              device('sync-device:a', 'Home desktop'),
              device('sync-device:b', 'Work laptop'),
              action
            ])
          ]}
          ctx={{ open }}
          variant={variant}
        />
      )
      expect(sequence(h), variant).toEqual([
        'sync-device:a',
        'sync-device:b',
        'hr',
        'sync-remote-tabs'
      ])
      const hr = h.querySelector<HTMLHRElement>('hr')!
      expect(hr.className, variant).toBe('zen-settings-hairline')
      expect(hr.nextElementSibling?.getAttribute('data-row'), variant).toBe('sync-remote-tabs')
      // The line is a separator, not a row: nothing of a row's about it, no leading slot held
      // for it, and the flagged row itself has no empty leading slot for alignment.
      expect(hr.getAttribute('role'), variant).toBeNull()
      expect(hr.querySelector('*'), variant).toBeNull()
      expect(
        h.querySelector('[data-row="sync-remote-tabs"] .zen-settings-leading'),
        variant
      ).toBeNull()
      act(() => root?.unmount())
      host?.remove()
    }
  })

  it('is not drawn over a group’s first row (no run above it), nor for a row shown alone as a search result', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const h = render(<GroupList groups={[group([action])]} ctx={{ open }} variant="desktop" />)
    expect(sequence(h)).toEqual(['sync-remote-tabs'])
    expect(h.querySelector('hr')).toBeNull()
    act(() => root?.unmount())
    host?.remove()
    // A search's result renders the row on its own (`RowView`), its caption over it: no hairline.
    const alone = render(
      <RowView row={action} ctx={{ open }} caption="Sync › Other devices" variant="desktop" />
    )
    expect(alone.querySelector('hr')).toBeNull()
    expect(alone.querySelector('[data-row="sync-remote-tabs"]')).not.toBeNull()
  })

  it('is the landing’s run separator: one rule on the tokens, 1 tall, `--v2-border`, no border of its own', () => {
    const css = readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')
    const at = css.indexOf('.zen-settings-hairline {')
    expect(at).toBeGreaterThanOrEqual(0)
    const rule = css.slice(at, css.indexOf('}', at) + 1)
    expect(rule).toContain('height: 1px')
    expect(rule).toContain('background: var(--v2-border)')
    expect(rule).toContain('border: 0')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
    // The one rule: the hook adds no second selector for the row form.
    expect(css.indexOf('.zen-settings-hairline {', at + 1)).toBe(-1)
  })
})

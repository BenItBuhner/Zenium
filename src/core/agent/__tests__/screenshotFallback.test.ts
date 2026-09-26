import { describe, expect, it } from 'vitest'
import type { AgentCapture, AgentCaptureOptions, TabView } from '../../platform'
import type { AgentSession } from '../service'
import { AGENT_TOOLS } from '../tools'
import { fakeBrowser, textOf, type FakeBrowser } from './fakeBrowser'

/**
 * A staged page – a tab an agent works off the user's screen – paints its viewport and nothing
 * beyond it: the host answers a full-page or region capture with the visible area and marks the
 * picture `fallback: 'viewport'` (`views.ts`, `capture`). The tool's text line used to call that
 * picture a "full page"; it has to say what the picture is, why, and what gets the rest.
 */

/** A host whose `capture` paints the viewport only and says so for anything else asked. */
function viewportOnlyHost(view: TabView, calls: AgentCaptureOptions[]): void {
  view.capture = async (options) => {
    calls.push(options)
    const cap: AgentCapture = { data: 'AAAA', mimeType: 'image/jpeg', width: 1017, height: 772 }
    if (options.mode !== 'viewport') cap.fallback = 'viewport'
    return cap
  }
}

/** A host that paints what it is asked for. */
function fullHost(view: TabView): void {
  view.capture = async (options) => ({
    data: 'AAAA',
    mimeType: 'image/jpeg',
    width: options.mode === 'fullPage' ? 1017 : 400,
    height: options.mode === 'fullPage' ? 3400 : 300
  })
}

async function tabOf(
  host: (view: TabView, calls: AgentCaptureOptions[]) => void
): Promise<{ fake: FakeBrowser; A: AgentSession; id: string; calls: AgentCaptureOptions[] }> {
  const fake = fakeBrowser({ defaultMode: 'background' })
  const A = await fake.connect('A')
  const id = fake.openedTab(
    await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
  )
  const calls: AgentCaptureOptions[] = []
  host(fake.browser.tabs.view(id)!, calls)
  return { fake, A, id, calls }
}

describe('browser_take_screenshot on a page the host paints as the viewport only', () => {
  it('does not call the viewport a full page, and says why and what gets the rest', async () => {
    const { fake, A, id, calls } = await tabOf(viewportOnlyHost)
    const r = await fake.call(A, 'browser_take_screenshot', { tabId: id, fullPage: true })
    expect(r.isError).toBeFalsy()
    const text = textOf(r)
    expect(calls.at(-1)?.mode).toBe('fullPage')
    expect(text).toContain('Screenshot (viewport – not the full page')
    expect(text).not.toContain('Screenshot (full page')
    expect(text).toContain("a tab off the user's screen")
    expect(text).toContain('browser_scroll and capture again for the rest')
    expect(text).toContain('1017×772 px')
    expect(r.content.some((c) => c.type === 'image')).toBe(true)
    await fake.stop()
  })

  it('says an element picture is cut from the viewport and how to bring the element into view', async () => {
    const { fake, A, id, calls } = await tabOf(viewportOnlyHost)
    const r = await fake.call(A, 'browser_take_screenshot', { tabId: id, target: 'text=Go' })
    expect(r.isError).toBeFalsy()
    const text = textOf(r)
    expect(calls.at(-1)?.mode).toBe('region')
    expect(text).toMatch(/^Screenshot \(element button "Go"[^,]*, cut from the visible viewport – /)
    expect(text).toContain('any part outside the viewport is missing')
    expect(text).toContain('browser_scroll {"target":…} brings it into view first')
    await fake.stop()
  })

  it('leaves a viewport picture alone – it is what was asked for', async () => {
    const { fake, A, id, calls } = await tabOf(viewportOnlyHost)
    const r = await fake.call(A, 'browser_take_screenshot', { tabId: id })
    expect(calls.at(-1)?.mode).toBe('viewport')
    expect(textOf(r)).toMatch(/^Screenshot \(viewport, 1017×772 px, image\/jpeg\)/)
    await fake.stop()
  })

  it('leaves a full page or element the host painted whole alone', async () => {
    const { fake, A, id } = await tabOf((view) => fullHost(view))
    const full = await fake.call(A, 'browser_take_screenshot', { tabId: id, fullPage: true })
    expect(textOf(full)).toMatch(/^Screenshot \(full page, 1017×3400 px, image\/jpeg\)/)
    const el = await fake.call(A, 'browser_take_screenshot', { tabId: id, target: 'text=Go' })
    expect(textOf(el)).toMatch(/^Screenshot \(element button "Go"[^,]*, 400×300 px, image\/jpeg\)/)
    await fake.stop()
  })
})

describe('the screenshot tool tells the agent up front', () => {
  it("that fullPage and target on a tab off the user's screen return the viewport", () => {
    const def = AGENT_TOOLS.find((t) => t.definition.name === 'browser_take_screenshot')!.definition
    expect(def.description).toContain(
      "On a tab off the user's screen (background mode, or foreground without the screen taken) fullPage and target return the visible viewport instead"
    )
    expect(def.description).toContain("the result's text line says so")
  })
})

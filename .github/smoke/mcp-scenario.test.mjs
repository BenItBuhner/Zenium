import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { SOFT_CHECKS, Verdict } from '../../scripts/mcp-soak.mjs'
import {
  COLOUR_TOLERANCE,
  MCP_RESTART_SCENARIO,
  MCP_SCENARIO,
  MCP_SOAK,
  OOPIF_FRAME,
  OOPIF_PAGE,
  PORT_POOL,
  PROMPTS_PAGE,
  STAGE_PAGES,
  agentSettings,
  bindable,
  colourPage,
  ephemeralFloor,
  freePort,
  isColour,
  judgePixels,
  judgeStep,
  mark,
  oopifFrame,
  oopifPage,
  promptsPage,
  samplePoints,
  startStagePages
} from './mcp-scenario.mjs'

describe('the profile the scenario seeds', () => {
  it('turns the server on at the port, loopback only, new agents let in, scripts allowed', () => {
    expect(agentSettings(41739)).toEqual({
      enabled: true,
      port: 41739,
      lan: false,
      approveNewAgents: false,
      approvedNames: [],
      defaultMode: 'foreground',
      allowScripts: true,
      showCursor: true
    })
  })

  it('finds a free loopback port below the ephemeral range, where no bind(0) can take it', async () => {
    const port = await freePort()
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThanOrEqual(PORT_POOL.lo)
    expect(port).toBeLessThan(Math.min(PORT_POOL.hi, ephemeralFloor()))
    expect(await bindable(port)).toBe(true)
  })

  it('reads the ephemeral floor from the proc file, the Linux default without one', () => {
    expect(ephemeralFloor(() => '32768\t60999\n')).toBe(32768)
    expect(ephemeralFloor(() => '49152 65535')).toBe(49152)
    expect(
      ephemeralFloor(() => {
        throw new Error('ENOENT')
      })
    ).toBe(32768)
    expect(ephemeralFloor(() => 'garbage')).toBe(32768)
  })

  it('skips a port something already listens on (run 36451930938 seeded one that was taken)', async () => {
    const floor = 32768
    const span = Math.min(PORT_POOL.hi, floor) - PORT_POOL.lo
    // A roll that lands squarely in slot i of the pool: the pick is PORT_POOL.lo + i.
    const roll = (i) => (i + 0.5) / span
    const taken = await freePort({ random: () => roll(6000), floor })
    expect(taken).toBe(PORT_POOL.lo + 6000)
    const busy = net.createServer()
    await new Promise((resolve) => busy.listen(taken, '127.0.0.1', resolve))
    try {
      expect(await bindable(taken)).toBe(false)
      // The same pick first, then the next port along: the pick moves on.
      const rolls = [roll(6000), roll(6001)]
      const port = await freePort({ random: () => rolls.shift() ?? roll(6001), floor })
      expect(port).toBe(taken + 1)
      await expect(freePort({ random: () => roll(6000), floor, tries: 2 })).rejects.toThrow(
        /no free port in 20000–32767 after 2 tries \(last tried 26000\)/
      )
    } finally {
      await new Promise((resolve) => busy.close(resolve))
    }
  })

  it('uses the pool as is on a box whose ephemeral range starts too low to leave room', async () => {
    const port = await freePort({ floor: 1024 })
    expect(port).toBeGreaterThanOrEqual(PORT_POOL.lo)
    expect(port).toBeLessThan(PORT_POOL.hi)
  })

  it('keeps the CI soak short and names its two launches', () => {
    expect(MCP_SOAK.sessions * MCP_SOAK.rounds).toBeLessThanOrEqual(12)
    expect(MCP_SOAK.concurrency).toBeLessThanOrEqual(MCP_SOAK.sessions)
    expect(MCP_SOAK.shimSessions).toBeLessThanOrEqual(3)
    expect(MCP_SCENARIO).toBe('mcp')
    expect(MCP_RESTART_SCENARIO).toBe('mcp-restart')
  })
})

describe('judgeStep', () => {
  it('passes a step whose only failures are soft, and puts them in the detail', () => {
    const v = new Verdict()
    v.hard('initialize', true)
    const before = mark(v)
    v.sessions += 2
    v.calls += 9
    v.hard('zen_status', true)
    v.soft(SOFT_CHECKS.dropForceAdopt, false, 'still connected')
    v.soft(SOFT_CHECKS.dropForceAdopt, false, 'still connected')
    const { detail, error } = judgeStep(v, before)
    expect(error).toBeNull()
    expect(detail).toEqual({
      sessions: 2,
      calls: 9,
      hardFailures: 0,
      softFailures: 2,
      failed: {
        hard: [],
        soft: [
          {
            name: SOFT_CHECKS.dropForceAdopt,
            failures: 2,
            sample: 'still connected'
          }
        ]
      }
    })
  })

  it('fails a step on a background snapshot or screenshot that failed during it (hard since B)', () => {
    const v = new Verdict()
    const before = mark(v)
    v.hard('background-snapshot', false, 'viewport 0×0, headings [], 0 refs')
    v.hard('background-screenshot', false, 'no image part in the result')
    v.hard('foreground-screenshot', true)
    const { detail, error } = judgeStep(v, before)
    expect(error).toBe(
      '2 hard check(s) failed: background-snapshot ×1 (viewport 0×0, headings [], 0 refs); background-screenshot ×1 (no image part in the result)'
    )
    expect(detail.hardFailures).toBe(2)
    expect(detail.failed.soft).toEqual([])
  })

  it('fails a step on a hard check that failed during it, naming the check and what it quoted', () => {
    const v = new Verdict({ secrets: ['s3cret'] })
    v.hard('resurrection-with-token', false, 'HTTP 404 for Bearer s3cret')
    const before = mark(v)
    v.hard('zen_status after end', false, 'JSON-RPC error -32001 Unknown session')
    v.hard('zen_status after end', true)
    v.soft(SOFT_CHECKS.dropForceAdopt, false, 'still connected')
    const { detail, error } = judgeStep(v, before)
    expect(error).toBe(
      '1 hard check(s) failed: zen_status after end ×1 (JSON-RPC error -32001 Unknown session)'
    )
    expect(detail.hardFailures).toBe(1)
    expect(detail.softFailures).toBe(1)
    // The failure before the mark belongs to an earlier step.
    expect(detail.failed.hard.map((f) => f.name)).toEqual(['zen_status after end'])
    expect(JSON.stringify(detail)).not.toContain('s3cret')
  })
})

describe('the stage pages the hand-off is judged with', () => {
  it('are two colours told apart from each other and from the greys the chrome paints', () => {
    const { handOff, userSwitch } = STAGE_PAGES
    expect(isColour(handOff.rgb, userSwitch.rgb)).toBe(false)
    for (const page of [handOff, userSwitch]) {
      for (const grey of [0, 64, 128, 157, 192, 255])
        expect(isColour([grey, grey, grey], page.rgb)).toBe(false)
      expect(page.title).toMatch(/^Stage /)
    }
    expect(handOff.title).not.toBe(userSwitch.title)
  })

  it('are a page of nothing but the colour, titled for the sidebar row', () => {
    const html = colourPage(STAGE_PAGES.userSwitch)
    expect(html).toContain('<title>Stage user switch</title>')
    expect(html).toContain('background:rgb(0,102,255)')
    expect(html).not.toMatch(/<(h1|p|button)/)
  })

  it('are served on the loopback interface by name, and nothing else is', async () => {
    const pages = await startStagePages()
    try {
      const url = pages.url(STAGE_PAGES.handOff)
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hand-off$/)
      const res = await fetch(url)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(colourPage(STAGE_PAGES.handOff))
      expect((await fetch(url.replace('/hand-off', '/other'))).status).toBe(404)
    } finally {
      await pages.close()
    }
  })

  it('serve the native prompts page with each control the step drives', async () => {
    const pages = await startStagePages()
    try {
      const res = await fetch(pages.url(PROMPTS_PAGE))
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toBe(promptsPage())
      for (const id of ['direct', 'chooser', 'hidden', 'print', 'country'])
        expect(html).toContain(`id="${id}"`)
      expect(html).toContain('hidden.click()')
      expect(html).toContain('window.print()')
    } finally {
      await pages.close()
    }
  })

  it('frame the chooser from another site (localhost under 127.0.0.1)', async () => {
    const pages = await startStagePages()
    try {
      const url = pages.url(OOPIF_PAGE)
      expect(new URL(url).hostname).toBe('127.0.0.1')
      const html = await (await fetch(url)).text()
      const port = new URL(url).port
      const frameUrl = `http://localhost:${port}/${OOPIF_FRAME.name}`
      expect(html).toBe(oopifPage(frameUrl))
      const frame = await fetch(`http://127.0.0.1:${port}/${OOPIF_FRAME.name}`)
      expect(frame.status).toBe(200)
      const inner = await frame.text()
      expect(inner).toBe(oopifFrame())
      expect(inner).toContain(`getElementById('file').click()`)
      expect(inner).toContain("parent.postMessage('oopif: '")
    } finally {
      await pages.close()
    }
  })
})

describe('the pixels read where the tab is', () => {
  const rect = { x: 300, y: 100, width: 1000, height: 800, scale: 1 }

  it('are five points well inside the view – the centre and the quarter points – in device pixels', () => {
    expect(samplePoints(rect)).toEqual([
      { x: 800, y: 500 },
      { x: 550, y: 300 },
      { x: 1050, y: 300 },
      { x: 550, y: 700 },
      { x: 1050, y: 700 }
    ])
    // A display at 2× counts device pixels: the DIPs the main process reports, doubled.
    expect(samplePoints({ ...rect, scale: 2 })[0]).toEqual({ x: 1600, y: 1000 })
    for (const p of samplePoints(rect)) {
      expect(p.x).toBeGreaterThan(rect.x + rect.width * 0.2)
      expect(p.x).toBeLessThan(rect.x + rect.width * 0.8)
      expect(p.y).toBeGreaterThan(rect.y + rect.height * 0.2)
      expect(p.y).toBeLessThan(rect.y + rect.height * 0.8)
    }
  })

  it('match the colour within the tolerance per channel, and nothing off screen', () => {
    const orange = STAGE_PAGES.handOff.rgb
    expect(isColour([255, 136, 0], orange)).toBe(true)
    expect(
      isColour([255 - COLOUR_TOLERANCE, 136 + COLOUR_TOLERANCE, COLOUR_TOLERANCE], orange)
    ).toBe(true)
    expect(isColour([255, 136, COLOUR_TOLERANCE + 1], orange)).toBe(false)
    expect(isColour(null, orange)).toBe(false)
  })

  it('pass only when every point shows the colour, and say what each showed otherwise', () => {
    const orange = STAGE_PAGES.handOff.rgb
    const painted = { at: () => [255, 136, 0] }
    expect(judgePixels(painted, rect, orange)).toMatchObject({ matched: 5, of: 5, ok: true })
    // The page under the chrome: the window's grey where the page should be, but for one point.
    const underChrome = { at: (x, y) => (x === 800 && y === 500 ? [255, 136, 0] : [157, 157, 160]) }
    const judged = judgePixels(underChrome, rect, orange)
    expect(judged).toMatchObject({ matched: 1, of: 5, ok: false })
    expect(judged.seen).toEqual([
      '800,500→rgb(255,136,0)',
      '550,300→rgb(157,157,160)',
      '1050,300→rgb(157,157,160)',
      '550,700→rgb(157,157,160)',
      '1050,700→rgb(157,157,160)'
    ])
    // A view partly off the display: the grab has nothing there.
    expect(judgePixels({ at: () => null }, rect, orange).seen[0]).toBe('800,500→off screen')
  })
})

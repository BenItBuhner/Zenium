import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FRAME_RECT, buttonScreenPoint, fixturePages, startPopupFixture } from './popup-fixture.mjs'

/** GET `path` from the fixture's socket with the Host header a browser sends for `host`. */
function get(fixture, path, host) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: fixture.port, path, headers: { host } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      })
      .on('error', reject)
  })
}

describe('fixturePages', () => {
  const pages = fixturePages({
    topOrigin: 'http://127.0.0.1:1234',
    frameOrigin: 'http://localhost:1234'
  })

  it('embeds the frame from the other origin at the documented rectangle', () => {
    expect(pages['/']).toContain('<iframe id="frame" src="http://localhost:1234/frame.html"')
    expect(pages['/']).toContain(
      `left:${FRAME_RECT.left}px;top:${FRAME_RECT.top}px;width:${FRAME_RECT.width}px;height:${FRAME_RECT.height}px;border:0`
    )
  })

  it('has the frame open the pop-up on the top origin with a 500x600 feature string', () => {
    expect(pages['/frame.html']).toContain(
      "window.open('http://127.0.0.1:1234/popup.html', '_blank', 'width=500,height=600')"
    )
    // What the harness reads: the click count, whether the event was trusted, the return value.
    expect(pages['/frame.html']).toContain('window.__smoke.clicks++')
    expect(pages['/frame.html']).toContain('window.__smoke.trusted = e.isTrusted')
    expect(pages['/frame.html']).toContain('window.__smoke.opened = window.__popup !== null')
    expect(pages['/frame.html']).toContain("type: 'smoke-pong'")
  })

  it('has the pop-up ping its opener and expose the round trip as a promise', () => {
    expect(pages['/popup.html']).toContain('opener: window.opener !== null')
    expect(pages['/popup.html']).toContain('window.__roundTrip = new Promise(')
    expect(pages['/popup.html']).toContain("window.opener.postMessage({ type: 'smoke-ping'")
  })
})

describe('startPopupFixture', () => {
  let fixture
  beforeAll(async () => {
    fixture = await startPopupFixture()
  })
  afterAll(() => fixture.close())

  it('names two origins that differ in host only', () => {
    expect(fixture.topOrigin).toBe(`http://127.0.0.1:${fixture.port}`)
    expect(fixture.frameOrigin).toBe(`http://localhost:${fixture.port}`)
    expect(fixture.topUrl).toBe(`${fixture.topOrigin}/`)
    expect(fixture.frameUrl).toBe(`${fixture.frameOrigin}/frame.html`)
    expect(fixture.popupUrl).toBe(`${fixture.topOrigin}/popup.html`)
  })

  it('serves the three pages uncached, a blank favicon and nothing else', async () => {
    const top = await get(fixture, '/', `127.0.0.1:${fixture.port}`)
    expect(top.status).toBe(200)
    expect(top.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(top.headers['cache-control']).toBe('no-store')
    expect(top.body).toContain(`src="${fixture.frameUrl}"`)

    const frame = await get(fixture, '/frame.html', `localhost:${fixture.port}`)
    expect(frame.status).toBe(200)
    expect(frame.body).toContain(`window.open('${fixture.popupUrl}'`)

    const popup = await get(fixture, '/popup.html', `127.0.0.1:${fixture.port}`)
    expect(popup.status).toBe(200)
    expect(popup.body).toContain('window.__roundTrip')

    expect((await get(fixture, '/favicon.ico', `127.0.0.1:${fixture.port}`)).status).toBe(204)
    expect((await get(fixture, '/other', `127.0.0.1:${fixture.port}`)).status).toBe(404)
  })

  it('logs each request with the host name it came through', () => {
    expect(fixture.requests).toEqual(
      expect.arrayContaining([
        { path: '/', host: `127.0.0.1:${fixture.port}`, dest: undefined },
        { path: '/frame.html', host: `localhost:${fixture.port}`, dest: undefined }
      ])
    )
  })
})

describe('buttonScreenPoint', () => {
  const view = { x: 300, y: 100, width: 1000, height: 800 }
  const frame = FRAME_RECT
  const button = { left: 0, top: 0, width: FRAME_RECT.width, height: FRAME_RECT.height }

  it('lands on the centre of the button, offset by the frame and the view', () => {
    expect(buttonScreenPoint({ view, frame, button })).toEqual({ x: 660, y: 360, inside: true })
  })

  it('scales CSS pixels by the page zoom and the display scale factor', () => {
    expect(buttonScreenPoint({ view, frame, button, zoom: 1.25 })).toEqual({
      x: 750,
      y: 425,
      inside: true
    })
    expect(buttonScreenPoint({ view, frame, button, scale: 2 })).toEqual({
      x: 1320,
      y: 720,
      inside: true
    })
  })

  it('reports a button outside the view and follows one that does not fill the frame', () => {
    const short = { ...view, height: 200 }
    expect(buttonScreenPoint({ view: short, frame, button }).inside).toBe(false)
    const offset = { left: 700, top: 0, width: 100, height: 40 }
    expect(buttonScreenPoint({ view, frame, button: offset })).toEqual({
      x: 1090,
      y: 180,
      inside: true
    })
  })
})

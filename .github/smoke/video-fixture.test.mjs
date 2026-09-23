import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VIDEO_PAGE, VIDEO_SIZE, startVideoFixture, videoPage } from './video-fixture.mjs'

/** GET `path` from the fixture's socket. */
function get(fixture, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: fixture.port, path }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      })
      .on('error', reject)
  })
}

describe('videoPage', () => {
  const page = videoPage('http://127.0.0.1:1234')

  it('lays the video out at the canvas size and plays the canvas stream through it', () => {
    expect(VIDEO_SIZE).toEqual({ width: 640, height: 360 })
    expect(page).toContain(
      `<video id="video" width="${VIDEO_SIZE.width}" height="${VIDEO_SIZE.height}" playsinline`
    )
    expect(page).toContain(`canvas.width = ${VIDEO_SIZE.width}`)
    expect(page).toContain('const stream = canvas.captureStream(30)')
    expect(page).toContain('video.srcObject = stream')
    expect(page).toContain(`<title>${VIDEO_PAGE.title}</title>`)
    expect(page).toContain('http://127.0.0.1:1234')
  })

  it('adds a tone to the stream so the engine hears the video as audible', () => {
    expect(page).toContain('audio.createOscillator()')
    expect(page).toContain('audio.createMediaStreamDestination()')
    expect(page).toContain(
      'for (const track of sink.stream.getAudioTracks()) stream.addTrack(track)'
    )
    // The click that plays the video also resumes the context the autoplay policy left suspended.
    expect(page).toContain("if (audio.state !== 'running') audio.resume().catch(() => {})")
  })

  it('plays on load and again on a click, keeping the first refusal for the harness', () => {
    expect(page).toContain('window.__smoke = state')
    expect(page).toContain('state.playError = String((e && e.name) || e)')
    expect(page).toContain('if (!state.firstPlayError) state.firstPlayError = state.playError')
    expect(page).toContain("document.addEventListener('click', () => {")
    expect(page).toContain('if (video.paused) play()')
    expect(page).toContain(
      "video.addEventListener('enterpictureinpicture', () => state.pipEvents.push('enter'))"
    )
    expect(page).toContain(
      "video.addEventListener('leavepictureinpicture', () => state.pipEvents.push('leave'))"
    )
  })
})

describe('startVideoFixture', () => {
  let fixture
  beforeAll(async () => {
    fixture = await startVideoFixture()
  })
  afterAll(() => fixture.close())

  it('names the video page on its loopback origin', () => {
    expect(fixture.origin).toBe(`http://127.0.0.1:${fixture.port}`)
    expect(fixture.url).toBe(`${fixture.origin}${VIDEO_PAGE.path}`)
    expect(VIDEO_PAGE.path).toBe('/video.html')
    expect(fixture.title).toBe(VIDEO_PAGE.title)
  })

  it('serves the page uncached, a blank favicon and nothing else', async () => {
    const page = await get(fixture, VIDEO_PAGE.path)
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.body).toBe(videoPage(fixture.origin))

    expect((await get(fixture, '/favicon.ico')).status).toBe(204)
    expect((await get(fixture, '/other')).status).toBe(404)
  })

  it('logs each request', () => {
    expect(fixture.requests).toEqual(
      expect.arrayContaining([
        { path: VIDEO_PAGE.path, host: `127.0.0.1:${fixture.port}` },
        { path: '/other', host: `127.0.0.1:${fixture.port}` }
      ])
    )
  })
})

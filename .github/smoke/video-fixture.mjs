// The page behind the pip scenario (pip-02): one loopback HTTP server with a document whose
// `<video>` plays from the page's own canvas – `canvas.captureStream()` into `video.srcObject`,
// a frame counter drawn every animation frame – so the page needs no media file, no codec and
// nothing from the internet, and the video has frames the moment the tab paints. The stream also
// carries a tone (an oscillator through a MediaStreamDestination): Chromium's audibility, which
// the media hub's card reads as playing, is measured on rendered audio, so a video without an
// audio track never counts as playing however many frames it shows.
//
// The views' autoplay policy (document-user-activation-required) refuses the gesture-less
// `play()` the page makes on load; a click anywhere on the page calls `play()` again and resumes
// the audio context, and the harness clicks. The video is unmuted, so the page preload's media
// report reads it as audible (not muted, volume up) and as video (a width): what the media hub's
// card and its Picture in picture button turn on.
//
// The document records what happened on `window.__smoke`: whether `play()` resolved (or which
// error it threw, the first refusal kept), the audio context's state, the picture-in-picture
// events the element saw, and the click count.
import http from 'node:http'

export const VIDEO_PAGE = { path: '/video.html', title: 'Smoke fixture: video page' }

/** The canvas (and so the video's frames) in CSS pixels; the element is laid out at this size. */
export const VIDEO_SIZE = { width: 640, height: 360 }

const html = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="margin:0;background:#15141a;color:#eee;font:16px sans-serif">${body}</body></html>`

/** The document at `origin`. */
export function videoPage(origin) {
  const { width, height } = VIDEO_SIZE
  return html(
    VIDEO_PAGE.title,
    `<main style="margin:32px 40px">` +
      `<h1 style="margin:0 0 16px;font-size:32px;font-weight:600">Video page</h1>` +
      `<p>A video playing from this page's own canvas, served by the harness at <code>${origin}</code>.</p>` +
      `<video id="video" width="${width}" height="${height}" playsinline style="display:block;background:#000"></video>` +
      `<p id="status">starting</p>` +
      `</main>` +
      `<script>
(() => {
  const state = {
    played: false,
    playError: null,
    firstPlayError: null,
    plays: 0,
    clicks: 0,
    pipEvents: [],
    frames: 0,
    audioTracks: 0,
    audioState: null
  }
  window.__smoke = state
  const canvas = document.createElement('canvas')
  canvas.width = ${width}
  canvas.height = ${height}
  const ctx = canvas.getContext('2d')
  const draw = () => {
    state.frames++
    ctx.fillStyle = 'hsl(' + (state.frames % 360) + ' 60% 35%)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#fff'
    ctx.font = '48px sans-serif'
    ctx.fillText('frame ' + state.frames, 40, 200)
    requestAnimationFrame(draw)
  }
  draw()
  const stream = canvas.captureStream(30)
  const audio = new AudioContext()
  const tone = audio.createOscillator()
  tone.frequency.value = 440
  const gain = audio.createGain()
  gain.gain.value = 0.2
  const sink = audio.createMediaStreamDestination()
  tone.connect(gain).connect(sink)
  tone.start()
  for (const track of sink.stream.getAudioTracks()) stream.addTrack(track)
  state.audioTracks = stream.getAudioTracks().length
  const noteAudio = () => { state.audioState = audio.state }
  audio.addEventListener('statechange', noteAudio)
  noteAudio()
  const video = document.getElementById('video')
  const status = document.getElementById('status')
  video.srcObject = stream
  video.addEventListener('enterpictureinpicture', () => state.pipEvents.push('enter'))
  video.addEventListener('leavepictureinpicture', () => state.pipEvents.push('leave'))
  const play = () => {
    state.plays++
    if (audio.state !== 'running') audio.resume().catch(() => {})
    video.play().then(
      () => {
        state.played = true
        state.playError = null
        status.textContent = 'playing'
      },
      (e) => {
        state.playError = String((e && e.name) || e)
        if (!state.firstPlayError) state.firstPlayError = state.playError
        status.textContent = 'play refused: ' + state.playError
      }
    )
  }
  document.addEventListener('click', () => {
    state.clicks++
    if (video.paused) play()
  })
  play()
})()
</script>`
  )
}

/**
 * Starts the server on 127.0.0.1 (an ephemeral port): `origin`, `port`, `url` and `title` of the
 * video page, `requests` (the paths fetched) and `close()`.
 */
export function startVideoFixture() {
  const requests = []
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://fixture')
    requests.push({ path: pathname, host: req.headers.host })
    res.setHeader('cache-control', 'no-store')
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    if (pathname !== VIDEO_PAGE.path) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const origin = `http://${req.headers.host}`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(videoPage(origin))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const origin = `http://127.0.0.1:${port}`
      resolve({
        port,
        origin,
        url: `${origin}${VIDEO_PAGE.path}`,
        title: VIDEO_PAGE.title,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}

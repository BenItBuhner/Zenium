import { app, contentTracing } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * DIAG (sign-in smoke, runner-only gesture loss; temporary, W5-H): with `ZEN_INPUT_DIAG` set,
 * Chromium tracing of the input and compositor categories runs from boot (`input`: every
 * event's dispatch and the renderer's "Input Suppressed" with its reason bits; `cc`: each
 * renderer's BeginMainFrames and its `SetDeferMainFrameUpdate`/`SetDeferCommits` spans; `viz`:
 * the display's draws; `navigation`: the commits), and is written when the harness asks for it –
 * a `zen/input-diag-stop` file in the user data directory – to `zen/input-trace.json`, with
 * `zen/input-trace.json.done` once the file is complete. Until-full recording keeps the boot,
 * which is where the loss is. The GPU's feature status and driver are logged once, the runner's
 * compositor being suspect. Off in normal runs.
 */
export function startInputDiag(): void {
  if (!process.env.ZEN_INPUT_DIAG) return
  const log = (message: string): void =>
    console.log(`[signin-diag] t=${process.uptime().toFixed(3)} ${message}`)
  const dir = join(app.getPath('userData'), 'zen')
  const stopFile = join(dir, 'input-diag-stop')
  const traceFile = join(dir, 'input-trace.json')
  void contentTracing
    .startRecording({
      included_categories: ['input', 'cc', 'viz', 'navigation'],
      recording_mode: 'record-until-full',
      trace_buffer_size_in_kb: 160_000
    })
    .then(() => log('tracing started'))
    .catch((error) => log(`tracing failed to start: ${(error as Error)?.message ?? error}`))
  try {
    log(`gpu features ${JSON.stringify(app.getGPUFeatureStatus())}`)
  } catch (error) {
    log(`gpu features unavailable: ${(error as Error)?.message ?? error}`)
  }
  void app
    .getGPUInfo('complete')
    .then((info) => log(`gpu info ${JSON.stringify(info).slice(0, 1500)}`))
    .catch((error) => log(`gpu info unavailable: ${(error as Error)?.message ?? error}`))
  let stopping = false
  const timer = setInterval(() => {
    if (stopping || !existsSync(stopFile)) return
    stopping = true
    clearInterval(timer)
    log('tracing stop requested')
    void contentTracing
      .stopRecording(traceFile)
      .then((path) => {
        writeFileSync(`${traceFile}.done`, path)
        log(`tracing written ${path}`)
      })
      .catch((error) => {
        writeFileSync(`${traceFile}.done`, `error: ${(error as Error)?.message ?? error}`)
        log(`tracing stop failed: ${(error as Error)?.message ?? error}`)
      })
  }, 200)
}

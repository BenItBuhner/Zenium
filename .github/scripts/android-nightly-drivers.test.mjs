import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NEEDS,
  REPO_ROOT,
  SETUP_STEPS,
  SHARED_SCRIPT,
  checkManifest,
  classesOf,
  driversOf,
  environmentOf,
  matrix,
  readManifest,
  readResults,
  runnerKeysOf,
  setupSteps,
  shardNames,
  sourceDriverClasses,
  summarize,
  writePlan
} from './android-nightly-drivers.mjs'

const manifest = readManifest()
const runner = readFileSync(
  join(REPO_ROOT, '.github', 'scripts', 'android-nightly-drivers.sh'),
  'utf8'
)
const workflow = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'android-nightly-drivers.yml'),
  'utf8'
)

const temps = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightly-drivers-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the manifest against the sources', () => {
  it('names every concrete *Demo class under androidTest as a driver or a skip with a reason', () => {
    expect(checkManifest(manifest)).toEqual([])
  })

  it('reads the driver classes from the sources, abstract bases left out', () => {
    const classes = sourceDriverClasses()
    expect(classes.size).toBeGreaterThan(80)
    expect(classes.get('GestureDemo')).toBe('GestureDemo.kt')
    for (const name of classes.keys()) expect(name).toMatch(/Demo$/)
  })

  it('reports a class the manifest forgot, a skip without a reason and a landed absent class', () => {
    const sources = new Map([
      ['GestureDemo', 'GestureDemo.kt'],
      ['ForgottenDemo', 'ForgottenDemo.kt'],
      ['LandedDemo', 'LandedDemo.kt']
    ])
    const problems = checkManifest(
      {
        shards: { phone: { 'budget-minutes': 10, 'timeout-minutes': 20 } },
        drivers: [
          {
            id: 'gesture',
            class: 'GestureDemo',
            shard: 'phone',
            mirrors: 'x.yml',
            dir: 'gesture-demo',
            estimate: 2
          }
        ],
        skip: [{ class: 'NoReasonDemo' }, { class: 'LandedDemo', absent: true, reason: 'not yet' }]
      },
      sources
    )
    expect(problems.join('\n')).toContain('ForgottenDemo (ForgottenDemo.kt) is neither a driver')
    expect(problems.join('\n')).toContain('gives no reason')
    expect(problems.join('\n')).toContain('LandedDemo has landed')
  })

  it('keeps the shards the workflow offers as its shard choice in step with the manifest', () => {
    const block = workflow.match(/\n\s+shard:\n(?:\s+\S.*\n)*?\s+options:\n((?:\s+- .*\n)+)/)
    expect(block, 'the shard input has an options list').not.toBeNull()
    const options = block[1]
      .split('\n')
      .map((line) => line.trim().replace(/^- /, ''))
      .filter(Boolean)
    expect(options).toEqual(['all', ...shardNames(manifest)])
  })

  it('has the runner script know every setup step and every need the manifest may name', () => {
    for (const step of SETUP_STEPS) {
      expect(runner, `setup step ${step}`).toContain(`${step}) setup_${step.replace(/-/g, '_')} ;;`)
    }
    for (const need of NEEDS)
      expect(runner, `need ${need}`).toMatch(new RegExp(`^\\s+${need}\\)`, 'm'))
  })

  it('splits the drivers into shards of about an hour each, every shard under its budget', () => {
    for (const name of shardNames(manifest)) {
      const shard = manifest.shards[name]
      const minutes = driversOf(manifest, name).reduce((sum, d) => sum + d.estimate, 0)
      expect(minutes, `${name}: ${minutes} min of drivers`).toBeLessThanOrEqual(
        shard['budget-minutes']
      )
    }
  })
})

describe('the plan', () => {
  it('lays out one matrix row per shard, or the one asked for, with the recipe inputs', () => {
    const all = matrix(manifest)
    expect(all.include.map((row) => row.shard)).toEqual(shardNames(manifest))
    for (const row of all.include) {
      expect(row['api-level']).toMatch(/^\d+/)
      expect(row['emulator-options']).not.toContain('-gpu ')
      expect(typeof row['timeout-minutes']).toBe('number')
    }
    expect(matrix(manifest, 'tablet').include).toHaveLength(1)
    expect(() => matrix(manifest, 'moon')).toThrow(/no shard 'moon'/)
  })

  it('gives each driver its own workflow environment over the shard baseline', () => {
    const byId = new Map(manifest.drivers.map((d) => [d.id, d]))
    const qr = environmentOf(manifest, byId.get('qr'))
    expect(qr.DEMO_CLASS).toBe('app.zen.chromium.QrDemo')
    expect(qr.DEMO_REVOKE).toBe('android.permission.CAMERA')
    expect(qr.JANK_GATE).toBe('soft')
    expect(qr.DEMO_DISPLAY).toBe('720x1600@280')
    expect(qr.DEMO_VIDEO).toBe('qr.mp4')
    expect(environmentOf(manifest, byId.get('tablet')).DEMO_DISPLAY).toBe('1280x800@160')
    expect(environmentOf(manifest, byId.get('private')).WEBVIEW_APK).toBe(
      'artifacts/webview/SystemWebView.apk'
    )
    expect(environmentOf(manifest, byId.get('ntp-morph-private')).WEBVIEW_APK).toBe('')
    expect(environmentOf(manifest, byId.get('menu-perf')).DEMO_RECORD).toBe('0')
    expect(environmentOf(manifest, byId.get('a11y-chrome-private')).DEMO_SCENES).toBe('private')
    const keys = runnerKeysOf(byId.get('firstrun'))
    expect(keys.NIGHTLY_SCRIPT).toBe('.github/scripts/android-firstrun-demo.sh')
    expect(keys.NIGHTLY_RELOCATE).toBe('artifacts/android-firstrun-demo')
    expect(keys.NIGHTLY_NEEDS).toBe('browser-role')
    expect(runnerKeysOf(byId.get('gesture')).NIGHTLY_SCRIPT).toBe(SHARED_SCRIPT)
  })

  it('writes the shard plan as numbered env files in the manifest order', () => {
    const dir = temp()
    const ids = writePlan(manifest, 'tablet', dir)
    expect(ids).toEqual(driversOf(manifest, 'tablet').map((d) => d.id))
    const files = readdirSync(dir).sort()
    expect(files[0]).toBe('01-tablet.env')
    expect(files).toContain('shard.env')
    const env = readFileSync(join(dir, '01-tablet.env'), 'utf8')
    expect(env).toContain('NIGHTLY_ID=tablet\n')
    expect(env).toContain('DEMO_CLASS=app.zen.chromium.TabletLayoutDemo\n')
    expect(readFileSync(join(dir, 'shard.env'), 'utf8')).toContain('NIGHTLY_BUDGET_S=2700\n')
  })

  it('collects the setup steps a shard needs, each once', () => {
    expect(setupSteps(manifest, 'webview')).toEqual(['webview-snapshot'])
    expect(setupSteps(manifest, 'api35')).toEqual(['ffmpeg', 'perfetto-python'])
    const phoneA = setupSteps(manifest, 'phone-a')
    expect(new Set(phoneA).size).toBe(phoneA.length)
  })
})

describe('the table', () => {
  const shardResult = (root, shard, records, info = {}) => {
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'results.jsonl'),
      records.map((r) => JSON.stringify({ shard, ...r })).join('\n') + '\n'
    )
    writeFileSync(
      join(root, 'shard.json'),
      JSON.stringify({ shard, seconds: 1800, attempt: 1, ...info })
    )
  }
  const row = (id, result, extra = {}) => ({
    id,
    classes: classesOf(manifest.drivers.find((d) => d.id === id)),
    result,
    seconds: 120,
    reason: '',
    scenes: 0,
    touches: 3,
    touchFaults: 0,
    shots: 4,
    videos: 1,
    ...extra
  })

  it('fails the run on a failed driver, a driver without a result and a shard without results', () => {
    const dir = temp()
    const tablet = driversOf(manifest, 'tablet').map((d) => row(d.id, 'PASS'))
    shardResult(join(dir, 'nightly-drivers-shard-tablet-r1'), 'tablet', tablet)
    const [first, second] = driversOf(manifest, 'webview')
    shardResult(join(dir, 'nightly-drivers-shard-webview-r1'), 'webview', [
      row(first.id, 'PASS'),
      row(second.id, 'FAIL', { reason: '2 check(s) failed' })
    ])
    const { markdown, failed, counts } = summarize(manifest, readResults(dir), {
      artifactUrl: 'https://example.test/artifact',
      artifactName: 'nightly-drivers-2026-09-22'
    })
    expect(markdown).toContain(
      '| driver | result | scenes / checks | duration | jank verdict | artifact |'
    )
    expect(markdown).toContain(`| ${classesOf(second).join(', ')} | **FAIL** |`)
    expect(markdown).toContain('[webview/private/](https://example.test/artifact)')
    expect(markdown).toContain('`nightly-drivers-shard-tablet-r1/`')
    expect(failed.join('\n')).toContain('2 check(s) failed')
    expect(failed.join('\n')).toContain('no result: the shard stopped before it')
    expect(failed.join('\n')).toContain('the shard job left no results')
    expect(counts.PASS).toBe(tablet.length + 1)
    expect(counts.SKIP).toBe(manifest.skip.length)
    for (const skip of manifest.skip) expect(markdown).toContain(skip.reason.slice(0, 40))
  })

  it('is green when every driver of the shard asked for passed', () => {
    const dir = temp()
    shardResult(
      join(dir, 'nightly-drivers-shard-tablet-r1'),
      'tablet',
      driversOf(manifest, 'tablet').map((d) => row(d.id, 'PASS'))
    )
    const { failed, markdown } = summarize(manifest, readResults(dir), { shard: 'tablet' })
    expect(failed).toEqual([])
    expect(markdown).toMatch(
      new RegExp(`^\\*\\*${driversOf(manifest, 'tablet').length} passed, 0 failed`)
    )
  })

  it('keeps the latest attempt of a shard that was re-run', () => {
    const dir = temp()
    const drivers = driversOf(manifest, 'tablet')
    const [driver, ...rest] = drivers
    shardResult(
      join(dir, 'nightly-drivers-shard-tablet-r1'),
      'tablet',
      [row(driver.id, 'FAIL', { reason: 'cut' }), ...rest.map((d) => row(d.id, 'PASS'))],
      {
        attempt: 1
      }
    )
    shardResult(
      join(dir, 'nightly-drivers-shard-tablet-r2'),
      'tablet',
      drivers.map((d) => row(d.id, 'PASS')),
      {
        attempt: 2
      }
    )
    const results = readResults(dir)
    expect(results.get('tablet').dirName).toBe('nightly-drivers-shard-tablet-r2')
    expect(summarize(manifest, results, { shard: 'tablet' }).failed).toEqual([])
  })

  it('tells a budget skip and an emulator death from a driver failure', () => {
    const dir = temp()
    const [a, b, c] = driversOf(manifest, 'webview')
    shardResult(
      join(dir, 'nightly-drivers-shard-webview-r1'),
      'webview',
      [
        row(a.id, 'FAIL', { reason: 'the emulator went away under the driver' }),
        row(b.id, 'SKIP', { reason: 'the emulator went away earlier on this shard' }),
        row(c.id, 'SKIP', { reason: 'shard budget: 2 min left, the driver takes about 5 min' })
      ],
      { emulatorDied: true }
    )
    const { markdown, failed, notRun, counts } = summarize(manifest, readResults(dir), {
      shard: 'webview'
    })
    expect(markdown).toContain('**the emulator went away**')
    expect(markdown).toContain('### Not run')
    expect(markdown).toMatch(
      new RegExp(`^\\*\\*0 passed, \\d+ failed, 2 not run, ${manifest.skip.length} skipped\\*\\*`)
    )
    expect(failed).toHaveLength(1 + driversOf(manifest, 'webview').length - 3)
    expect(notRun).toHaveLength(2)
    expect(counts.NOT_RUN).toBe(2)
  })
})

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RM_OPTIONS, removeTree } from './remove-tree.mjs'

const temps = []
const profile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'remove-tree-'))
  temps.push(dir)
  const partition = join(dir, 'Zenium', 'Partitions', 'zen-default')
  mkdirSync(join(partition, 'Local Storage', 'leveldb'), { recursive: true })
  mkdirSync(join(dir, 'Zenium', 'zen'))
  writeFileSync(join(partition, 'Cookies'), 'sqlite')
  writeFileSync(join(partition, 'Local Storage', 'leveldb', 'LOG'), 'log')
  writeFileSync(join(dir, 'Zenium', 'zen', 'state.json'), '{}')
  return { dir, partition }
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, RM_OPTIONS)
})

/**
 * A process that writes into the partition as fast as it can – Chromium's helper flushing after
 * the browser process is gone – for `ms`, or until the directory is no longer there. It prints
 * `writing` after its first file so the test starts the removal while the writer is at work, and
 * the count of files it wrote when it stops.
 */
function writer(partition, ms) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const fs = require('node:fs');
       const dir = process.argv[1]; const until = Date.now() + Number(process.argv[2]);
       let n = 0;
       while (Date.now() < until) {
         try { fs.writeFileSync(dir + '/flush-' + n, 'x'); n++ } catch (e) { if (e.code === 'ENOENT') break; throw e }
         if (n === 1) process.stdout.write('writing\\n');
       }
       process.stdout.write('wrote ' + n + '\\n');`,
      partition,
      String(ms)
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  let out = ''
  const started = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.includes('writing')) resolve()
    })
  })
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })))
  return { started, done }
}

describe('RM_OPTIONS', () => {
  it('is the standing shape: recursive, force, five retries 100 ms apart', () => {
    expect(RM_OPTIONS).toEqual({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
})

describe('removeTree', () => {
  it('removes a tree nothing else touches in one pass, and a missing path in one', async () => {
    const { dir } = profile()
    expect(await removeTree(dir)).toBe(1)
    expect(existsSync(dir)).toBe(false)
    expect(await removeTree(join(dir, 'never-there'))).toBe(1)
  })

  it('runs every pass with the standing options', async () => {
    const calls = []
    const rm = (target, options) => calls.push({ target, options })
    await removeTree('/a/tree', { rm })
    expect(calls).toEqual([{ target: '/a/tree', options: RM_OPTIONS }])
  })

  it('repeats the pass while it fails and reports the one that got through', async () => {
    const { dir } = profile()
    let failures = 2
    const rm = (target, options) => {
      if (failures-- > 0) throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' })
      rmSync(target, options)
    }
    expect(await removeTree(dir, { rm, delayMs: 10 })).toBe(3)
    expect(existsSync(dir)).toBe(false)
  })

  it('throws the last error once the deadline is up', async () => {
    let passes = 0
    const rm = () => {
      passes++
      throw Object.assign(new Error(`pass ${passes} refused`), { code: 'ENOTEMPTY' })
    }
    await expect(removeTree('/a/tree', { rm, deadlineMs: 200, delayMs: 40 })).rejects.toThrow(
      /^pass [3-9] refused$/
    )
    expect(passes).toBeGreaterThanOrEqual(3)
  })

  it('outlasts a process still writing into the partition: the tree is gone once it stops', async () => {
    const { dir, partition } = profile()
    const straggler = writer(partition, 300)
    await straggler.started
    const pass = await removeTree(dir, { deadlineMs: 10000 })
    expect(existsSync(dir)).toBe(false)
    const { code, out } = await straggler.done
    expect(code).toBe(0)
    const wrote = Number(/wrote (\d+)/.exec(out)?.[1])
    expect(wrote).toBeGreaterThanOrEqual(1)
    // Pass 1 fails while the writer is at work – a plain rmSync throws ENOTEMPTY here, and so
    // does one with maxRetries (measured: 300 ms and 1.5 s to the throw, the tree left behind);
    // the second walk is the fix. The outcome is what the test holds to; the pass number is
    // the scheduler's.
    expect(pass).toBeGreaterThanOrEqual(1)
  }, 15000)

  it('leaves a tree it could not remove for the caller to report', async () => {
    const { dir } = profile()
    const rm = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    await expect(removeTree(dir, { rm, deadlineMs: 50, delayMs: 10 })).rejects.toThrow('EACCES')
    expect(readdirSync(dir)).toContain('Zenium')
  })
})

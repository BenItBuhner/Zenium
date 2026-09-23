// Removing a directory tree another process may still be writing into – a browser profile after
// the browser was killed. Chromium's helpers (the network service, the GPU process) flush into
// `Partitions/<name>` for a moment after the browser process is gone, and a plain `rmSync` there
// threw ENOTEMPTY on a boot smoke whose checks had all passed (#392's run: rmdir of
// `Partitions/zen-default`, `verdict: PASS` a step earlier).
//
// The standing rule for filesystem teardown is retry or poll. Node's `maxRetries` retries only
// the failing `rmdir`, with a linear backoff (`lib/internal/fs/rimraf.js`, `_rmdirSync`): an
// entry created after the walk read the directory is never seen again, so those retries fail the
// same way. `removeTree` does both – the options on every pass, and the pass repeated (each one
// walks the tree afresh) until one gets through or the deadline is up.

import { rmSync } from 'node:fs'

/** The options every teardown `rmSync` in .github/smoke and .github/scripts runs with. */
export const RM_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100
})

/**
 * Removes `target` and everything under it, repeating the removal while it fails until it gets
 * through or `deadlineMs` is up, when the last error is thrown. Resolves with the number of the
 * pass that succeeded (1 when the first did, as with a tree nothing else touches, or a path that
 * is not there). `rm` is the removal to run, `rmSync` unless a test injects one.
 */
export async function removeTree(target, { deadlineMs = 5000, delayMs = 100, rm = rmSync } = {}) {
  const deadline = Date.now() + deadlineMs
  for (let pass = 1; ; pass++) {
    try {
      rm(target, RM_OPTIONS)
      return pass
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

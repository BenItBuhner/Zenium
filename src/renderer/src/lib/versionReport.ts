/**
 * What Settings › About's version row copies on a long-press (SET-54; Chrome for Android's
 * About copies its version line the same way): the browser's own version, the engine's
 * Chromium version as the user agent states it – the one thing a bug report needs beside ours
 * – and the host the engine runs in. `Zenium 0.4.35 · Chromium 128.0.6613.127 · Android System
 * WebView`; without a Chromium token in the agent (a test's, another engine's) the middle goes.
 */
export function versionReport(version: string, engineHost: string, userAgent: string): string {
  const chromium = /\bChrome\/(\d+(?:\.\d+){0,3})/.exec(userAgent)?.[1]
  return [`Zenium ${version}`, chromium && `Chromium ${chromium}`, engineHost]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

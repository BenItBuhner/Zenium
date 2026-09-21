#!/usr/bin/env node
// Snapshots a public page into a self-contained, network-free HTML fixture for the Android
// performance drivers (BarHidePerfDemo serves it from its loopback server, so a scroll over a
// real-world DOM and stylesheet is the same bytes run after run):
//
//   node .github/scripts/android-perf-page-snapshot.mjs <url> <out.html.gz>
//
// What it does to the page: fetches it with a phone's user agent; drops every script (and the
// preload / prefetch / preconnect hints, the manifest and refresh metas) so nothing runs or is
// fetched; inlines each linked stylesheet as a <style> (CSS module bundles of client-rendered
// parts are dropped: nothing renders them without script); rewrites `url(http…)` inside the
// CSS to an empty data URL and every external image and source to a 1x1 transparent GIF, keeping
// the width / height attributes so the layout keeps its boxes; gzips the result. The fixtures
// under android/app/src/androidTest/assets/perf were made this way; the driver's header names
// the pages and the day they were taken.
import { gzipSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const [url, out] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: android-perf-page-snapshot.mjs <url> <out.html.gz>')
  process.exit(2)
}

async function fetchText(target) {
  const response = await fetch(target, { headers: { 'user-agent': UA, accept: '*/*' } })
  if (!response.ok) throw new Error(`${target}: HTTP ${response.status}`)
  return response.text()
}

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
const neutraliseCssUrls = (css) =>
  css.replace(/url\(\s*(['"]?)(https?:)?\/\/[^)'"]*\1\s*\)/gi, 'url(data:,)')

let html = await fetchText(url)
const origin = new URL(url)

html = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<script\b[^>]*\/>/gi, '')
  .replace(
    /<link\b[^>]*rel=["'](?:modulepreload|preload|prefetch|dns-prefetch|preconnect|manifest)["'][^>]*>/gi,
    ''
  )
  .replace(/<meta\b[^>]*http-equiv=["']refresh["'][^>]*>/gi, '')

let inlined = 0
let dropped = 0
const links = [...html.matchAll(/<link\b[^>]*>/gi)]
for (const match of links) {
  const tag = match[0]
  if (!/rel=["']stylesheet["']/i.test(tag)) continue
  const href = tag.match(/\shref=["']([^"']+)["']/i)?.[1]
  if (!href) {
    // Colour-scheme variants carry `data-href` and are wired up by script: never loaded here.
    html = html.replace(tag, '')
    dropped++
    continue
  }
  const target = new URL(decodeEntities(href), origin).toString()
  if (/\.module\.css(\?|$)/.test(target)) {
    html = html.replace(tag, '')
    dropped++
    continue
  }
  const media = tag.match(/\smedia=["']([^"']+)["']/i)?.[1]
  const css = neutraliseCssUrls(await fetchText(target))
  const style = `<style${media ? ` media="${media}"` : ''} data-inlined="${target}">\n${css}\n</style>`
  html = html.replace(tag, style)
  inlined++
}

// External images and sources: a placeholder pixel, the box kept by the element's attributes.
let images = 0
html = html
  .replace(
    /(<(?:img|source)\b[^>]*?)\s(?:src|srcset|data-src)=["'](?:https?:)?\/\/[^"']*["']/gi,
    (whole, head) => {
      images++
      return `${head} src="${GIF}"`
    }
  )
  .replace(/(<(?:img|source)\b[^>]*?)\ssrcset=["'][^"']*["']/gi, '$1')
  .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, '')
  .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
  .replace(/<iframe\b[^>]*\/>/gi, '')
  // Style attributes with external backgrounds.
  .replace(/url\(\s*(['"]?)(https?:)?\/\/[^)'"]*\1\s*\)/gi, 'url(data:,)')

const banner = `<!-- Zenium perf fixture: ${url} taken ${new Date().toISOString().slice(0, 10)}; scripts stripped, ${inlined} stylesheets inlined, ${dropped} dropped, ${images} images replaced -->\n`
const bytes = Buffer.from(banner + html, 'utf8')
const gz = gzipSync(bytes, { level: 9 })
writeFileSync(out, gz)
console.log(
  `${url}: ${bytes.length} bytes of HTML (${inlined} stylesheets inlined, ${dropped} dropped, ${images} images replaced) -> ${out} (${gz.length} bytes gzipped)`
)

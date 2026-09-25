// Refreshes resources/lookalikes: the two tables the lookalike-domain check
// (src/core/protection/lookalikes.ts, PS-18) ships inside the desktop package and the Android
// APK – the Tranco top list, cut to the most visited registrable domains, and the Latin-target
// subset of Unicode's confusables – each gzipped with its source, licence and size in a comment
// at the top and in manifest.json. Run from the repository root:
//
//   npm run lookalikes:snapshot            # the latest Tranco list and confusables.txt
//   npm run lookalikes:snapshot -- K9PXW   # a named Tranco list
//
// The output is committed; the lists change slowly and the check needs them recent, not current.
// Tranco (https://tranco-list.eu) asks that the list id and date be cited: they are, below and
// in the manifest. Unicode's confusables.txt carries the Unicode Licence v3
// (https://www.unicode.org/license.txt); the subset keeps its header lines.
import { gzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseConfusables } from '../src/core/protection/lookalikes.ts'

const OUT_DIR = resolve('resources/lookalikes')
/** Registrable domains kept from the top of the Tranco list. */
const TOP_COUNT = 2_000
const TRANCO_API = 'https://tranco-list.eu/api/lists'
const CONFUSABLES_URL = 'https://www.unicode.org/Public/security/latest/confusables.txt'

interface TrancoList {
  list_id: string
  created_on: string
  download: string
}

interface ManifestTable {
  id: string
  file: string
  entries: number
  bytes: number
  url: string
  name: string
  homepage: string
  licence: string
  /** The Tranco list id, and the date the list was generated. */
  listId?: string
  date: string
}

async function text(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.text()
}

async function trancoList(id: string | undefined): Promise<TrancoList> {
  const meta = (await (
    await fetch(id ? `${TRANCO_API}/id/${id}` : `${TRANCO_API}/date/latest`)
  ).json()) as TrancoList
  if (!meta.list_id) throw new Error('Tranco: no list id in the answer')
  return meta
}

function comment(lines: string[]): string {
  return lines.map((l) => `# ${l}`.trimEnd()).join('\n') + '\n'
}

async function main(): Promise<void> {
  const requested = process.argv[2]
  mkdirSync(OUT_DIR, { recursive: true })
  const today = new Date().toISOString().slice(0, 10)

  // --- Tranco ---------------------------------------------------------------------------------
  const list = await trancoList(requested)
  const csv = await text(`https://tranco-list.eu/download/${list.list_id}/${TOP_COUNT}`)
  const domains: string[] = []
  const seen = new Set<string>()
  for (const line of csv.split('\n')) {
    const domain = line.trim().split(',').pop()?.toLowerCase() ?? ''
    if (!domain || !domain.includes('.') || seen.has(domain)) continue
    seen.add(domain)
    domains.push(domain)
    if (domains.length >= TOP_COUNT) break
  }
  const listDate = list.created_on.slice(0, 10)
  const trancoText =
    comment([
      `Tranco top ${domains.length} registrable domains – list ${list.list_id} of ${listDate}`,
      `Source: https://tranco-list.eu/list/${list.list_id} (https://tranco-list.eu)`,
      'Licence: free to use; Tranco asks for attribution – "A Research-Oriented Top Sites Ranking',
      'Hardened Against Manipulation", Le Pochat et al., NDSS 2019 – and that the list id be cited.',
      `Built ${today} by scripts/lookalikes-snapshot.mts for the lookalike-domain check`,
      '(src/core/protection/lookalikes.ts). One registrable domain per line, rank order.'
    ]) + domains.join('\n') + '\n'
  const trancoGz = gzipSync(trancoText, { level: 9 })
  writeFileSync(join(OUT_DIR, 'tranco-top.txt.gz'), trancoGz)

  // --- Unicode confusables ---------------------------------------------------------------------
  const confusables = await text(CONFUSABLES_URL)
  const header = confusables
    .split('\n')
    .filter((l) => l.startsWith('#'))
    .slice(0, 10)
  const kept: string[] = []
  const subset = parseConfusables(confusables)
  for (const line of confusables.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const fields = line.split(';')
    if (fields.length < 2) continue
    const source = fields[0]
      .trim()
      .split(/\s+/)
      .map((h) => String.fromCodePoint(parseInt(h, 16)))
      .join('')
    if (subset.has(source)) kept.push(line.replace(/\s*#.*$/, '').trim())
  }
  const confusablesText =
    comment([
      'Unicode confusables.txt – the rows whose prototype is a Latin letter, a digit or a hyphen',
      '(the characters a hostname can be spelled with), the comments stripped. Subset built',
      `${today} by scripts/lookalikes-snapshot.mts for the lookalike-domain check`,
      '(src/core/protection/lookalikes.ts). Source: ' + CONFUSABLES_URL,
      'Licence: Unicode Licence v3 (https://www.unicode.org/license.txt). Original header:'
    ]) +
    header.join('\n') +
    '\n' +
    kept.join('\n') +
    '\n'
  const confusablesGz = gzipSync(confusablesText, { level: 9 })
  writeFileSync(join(OUT_DIR, 'confusables.txt.gz'), confusablesGz)

  const versionLine = header.find((l) => l.startsWith('# Version:')) ?? ''
  const dateLine = header.find((l) => l.startsWith('# Date:')) ?? ''
  const manifest = {
    builtAt: Date.now(),
    tables: [
      {
        id: 'tranco-top',
        file: 'tranco-top.txt.gz',
        entries: domains.length,
        bytes: trancoGz.length,
        url: `https://tranco-list.eu/download/${list.list_id}/${TOP_COUNT}`,
        name: `Tranco top ${domains.length}`,
        homepage: 'https://tranco-list.eu',
        licence: 'Free with attribution (Tranco, Le Pochat et al., NDSS 2019); cite the list id',
        listId: list.list_id,
        date: listDate
      },
      {
        id: 'confusables',
        file: 'confusables.txt.gz',
        entries: kept.length,
        bytes: confusablesGz.length,
        url: CONFUSABLES_URL,
        name: `Unicode confusables.txt, Latin-target subset (${versionLine.replace('# ', '')})`,
        homepage: 'https://www.unicode.org/reports/tr39/',
        licence: 'Unicode Licence v3 (https://www.unicode.org/license.txt)',
        date: dateLine.replace(/^# Date:\s*/, '').slice(0, 10)
      }
    ] satisfies ManifestTable[]
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const t of manifest.tables)
    console.log(`${t.file}: ${t.entries} entries, ${t.bytes} bytes gzipped (${t.date})`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

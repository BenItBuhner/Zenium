// Downloads Chrome Web Store extensions as CRX3 packages and unpacks them, for the extension
// prototype workflow to sideload onto the emulator. Run from the repository root:
//
//   node .github/scripts/fetch-crx.mjs <output dir> <extension id>...
//
// A CRX3 file is the magic `Cr24`, a little-endian u32 format version, a little-endian u32 header
// length, that many header bytes (signatures, not checked here) and then a plain zip. Each
// extension lands unpacked in <output dir>/<id>/; the run is summarised in <output dir>/fetch.json.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [outDir, ...ids] = process.argv.slice(2)
if (!outDir || ids.length === 0) {
  console.error('usage: node .github/scripts/fetch-crx.mjs <output dir> <extension id>...')
  process.exit(2)
}

const ID = /^[a-p]{32}$/
const results = {}
let failures = 0
mkdirSync(outDir, { recursive: true })

for (const id of ids) {
  if (!ID.test(id)) {
    results[id] = { error: 'not an extension id' }
    failures++
    continue
  }
  const crx = join(outDir, `${id}.crx`)
  const dir = join(outDir, id)
  try {
    const url =
      'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=152.0.0.0' +
      `&acceptformat=crx3&x=id%3D${id}%26uc`
    execFileSync('curl', ['-sSL', '--retry', '3', '-m', '300', '-o', crx, url], {
      stdio: 'inherit'
    })
    const buf = readFileSync(crx)
    const magic = buf.subarray(0, 4).toString('latin1')
    if (magic !== 'Cr24') throw new Error(`not a CRX (${buf.length} bytes)`)
    const version = buf.readUInt32LE(4)
    const headerLen = buf.readUInt32LE(8)
    const zip = join(outDir, `${id}.zip`)
    writeFileSync(zip, buf.subarray(12 + headerLen))
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir])
    rmSync(crx, { force: true })
    rmSync(zip, { force: true })
    if (!existsSync(join(dir, 'manifest.json'))) throw new Error('no manifest.json in the package')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    results[id] = {
      crxVersion: version,
      headerLen,
      bytes: buf.length,
      name: manifest.name,
      version: manifest.version,
      manifestVersion: manifest.manifest_version
    }
    console.log(
      `${id}: ${manifest.name} ${manifest.version} (mv${manifest.manifest_version}, ${buf.length} bytes)`
    )
  } catch (error) {
    failures++
    results[id] = { error: error instanceof Error ? error.message : String(error) }
    console.error(`::warning::${id}: ${results[id].error}`)
  }
}

writeFileSync(join(outDir, 'fetch.json'), JSON.stringify(results, null, 2))
process.exit(failures === ids.length ? 1 : 0)

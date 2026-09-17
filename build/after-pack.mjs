// electron-builder `afterPack` hook (runs after the app directory is assembled, before
// electron-builder's own signing step and before the DMG / zip / installers are built).
//
// macOS without a Developer ID: electron-builder skips code signing entirely, which leaves a
// bundle whose Mach-O files carry the linker's ad-hoc signatures but whose .app has no resource
// seal (_CodeSignature/CodeResources). Gatekeeper reports such a bundle as "damaged" – with no
// "Open Anyway" – on Apple Silicon. An ad-hoc signature over the whole bundle gives it a proper
// seal, so macOS downgrades to the normal unsigned-app path (System Settings → Privacy & Security
// → Open Anyway, right-click → Open, or `xattr -dr com.apple.quarantine`). It is not a Developer
// ID: nothing here costs money, and it changes nothing for Squirrel.Mac (the app keeps using the
// download-and-open-the-DMG update path). Hardened runtime is applied with the same entitlements
// electron-builder uses for signed builds, so behaviour matches a Developer-ID build as far as an
// ad-hoc signature allows.
import { execFileSync } from 'node:child_process'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return // a real certificate: electron-builder signs
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlements = join(here, 'entitlements.mac.adhoc.plist')
  const codesign = (args) => execFileSync('codesign', args, { stdio: 'inherit' })
  console.log(`  • ad-hoc signing  app=${basename(app)} reason=no Developer ID configured`)
  codesign([
    '--force',
    '--deep',
    '--sign',
    '-',
    '--options',
    'runtime',
    '--timestamp=none',
    '--entitlements',
    entitlements,
    app
  ])
  codesign(['--verify', '--deep', '--strict', '--verbose=2', app])
}

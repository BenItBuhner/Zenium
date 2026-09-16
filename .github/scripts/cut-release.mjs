// Cut a release from a local checkout: bump the version, commit, tag vX.Y.Z and push, which
// starts the Release workflow. The same thing the "Prepare release" workflow does from the
// Actions tab, for people who prefer the terminal.
//
//   npm run release -- patch            0.1.0 → 0.1.1
//   npm run release -- minor            0.1.0 → 0.2.0
//   npm run release -- major            0.1.0 → 1.0.0
//   npm run release -- preminor         0.1.0 → 0.2.0-beta.0   (--preid changes "beta")
//   npm run release -- prerelease       0.2.0-beta.0 → 0.2.0-beta.1
//   npm run release -- 1.2.0            exact version
//
//   --dry-run     show the version and the commands without changing anything
//   --preid <id>  pre-release identifier for pre* bumps (default: beta)
//   --branch <b>  branch releases are cut from (default: main)
//   --remote <r>  git remote to push to (default: origin)
//   --yes         skip the confirmation prompt
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

const args = process.argv.slice(2)
const flags = { dryRun: false, preid: 'beta', branch: 'main', remote: 'origin', yes: false }
let bump = null
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--dry-run') flags.dryRun = true
  else if (arg === '--yes' || arg === '-y') flags.yes = true
  else if (arg === '--preid') flags.preid = args[++i]
  else if (arg === '--branch') flags.branch = args[++i]
  else if (arg === '--remote') flags.remote = args[++i]
  else if (arg.startsWith('--')) fail(`Unknown option ${arg}`)
  else if (bump === null) bump = arg
  else fail(`Unexpected argument ${arg}`)
}
if (!bump)
  fail('Usage: npm run release -- <patch|minor|major|pre*|X.Y.Z> [--dry-run] [--preid beta]')

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function git(...command) {
  return execFileSync('git', command, { encoding: 'utf8' }).trim()
}

function run(command, commandArgs) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`)
  if (!flags.dryRun) execFileSync(command, commandArgs, { stdio: 'inherit' })
}

const version = () => JSON.parse(readFileSync('package.json', 'utf8')).version

// Preconditions: the right branch, a clean tree, in sync with the remote.
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== flags.branch)
  fail(`Releases are cut from ${flags.branch}; switch branches or pass --branch`)
if (git('status', '--porcelain')) fail('The working tree has uncommitted changes')
git('fetch', flags.remote, flags.branch, '--tags')
const behind = git('rev-list', '--count', `HEAD..${flags.remote}/${flags.branch}`)
if (behind !== '0')
  fail(`${flags.branch} is ${behind} commit(s) behind ${flags.remote}; pull first`)

// Compute the new version with npm itself so pre-release arithmetic matches `npm version`.
const previous = version()
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const versionArgs = /^pre/.test(bump) ? [bump, '--preid', flags.preid] : [bump]
execFileSync(npm, ['version', ...versionArgs, '--no-git-tag-version'], { stdio: 'ignore' })
const next = version()
const tag = `v${next}`
const restore = () => git('checkout', '--', 'package.json', 'package-lock.json')
if (git('tag', '--list', tag)) {
  restore()
  fail(`Tag ${tag} already exists`)
}

console.log(`\n${previous} → ${next}  (tag ${tag} on ${flags.branch}, pushed to ${flags.remote})\n`)
if (flags.dryRun) {
  restore()
  console.log('Dry run: nothing was committed, tagged or pushed. Without --dry-run this would run:')
  console.log(`$ git commit -am "chore(release): ${tag}"`)
  console.log(`$ git tag -a ${tag} -m "Zen on Chromium ${next}"`)
  console.log(`$ git push ${flags.remote} ${flags.branch} refs/tags/${tag}`)
  process.exit(0)
}
if (!flags.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('Commit, tag and push? [y/N] ')).trim().toLowerCase()
  rl.close()
  if (answer !== 'y' && answer !== 'yes') {
    restore()
    console.log('Aborted; package.json restored.')
    process.exit(0)
  }
}

run('git', ['add', 'package.json', 'package-lock.json'])
run('git', ['commit', '-m', `chore(release): ${tag}`])
run('git', ['tag', '-a', tag, '-m', `Zen on Chromium ${next}`])
run('git', ['push', flags.remote, flags.branch, `refs/tags/${tag}`])

const origin = git('remote', 'get-url', flags.remote)
const match = /github\.com[:/]([^/]+\/[^/.]+)/.exec(origin)
if (match)
  console.log(`\nRelease workflow: https://github.com/${match[1]}/actions/workflows/release.yml`)

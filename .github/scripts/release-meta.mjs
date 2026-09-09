// Decides what a Release workflow run is releasing and refuses to continue when the tag and the
// package version disagree. Run from the repository root; talks to the workflow through the
// GITHUB_OUTPUT / GITHUB_STEP_SUMMARY files.
//
//   GITHUB_REF_TYPE / GITHUB_REF_NAME   the ref the workflow runs on
//   GITHUB_SHA                           the commit it runs for
//   INPUT_TAG                            explicit tag from workflow_dispatch (optional)
//   INPUT_DRY_RUN                        "true" to build without publishing
//
// Outputs: version, tag, ref, prerelease, publish, title
import { readFileSync, appendFileSync } from 'node:fs'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function output(name, value) {
  const text = `${name}=${value}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
  process.stdout.write(text)
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const version = pkg.version
if (typeof version !== 'string' || !SEMVER.test(version)) {
  fail(`package.json version "${version}" is not a semver string (major.minor.patch[-prerelease])`)
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const lockVersions = [lock.version, lock.packages?.['']?.version]
if (lockVersions.some((v) => v !== version)) {
  fail(
    `package-lock.json (${lockVersions.join(', ')}) does not match package.json (${version}); ` +
      'run "npm version <version> --no-git-tag-version" so both files are updated'
  )
}

const dryRun = (process.env.INPUT_DRY_RUN ?? 'false').trim() === 'true'
const inputTag = (process.env.INPUT_TAG ?? '').trim()
const refTag =
  process.env.GITHUB_REF_TYPE === 'tag' ? (process.env.GITHUB_REF_NAME ?? '').trim() : ''
let tag = inputTag || refTag

if (tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    fail(`Tag "${tag}" is not of the form v<major>.<minor>.<patch>[-prerelease]`)
  }
  if (tag.slice(1) !== version) {
    fail(
      `Tag ${tag} does not match package.json version ${version}. ` +
        'Bump the version with the "Prepare release" workflow (or npm version) before tagging.'
    )
  }
} else if (dryRun) {
  tag = `v${version}`
} else {
  fail(
    'A release must run for a v* tag: push the tag, run "Prepare release", or dispatch this workflow with a tag. ' +
      'Enable "dry run" to exercise the build from a branch without publishing.'
  )
}

const prerelease = version.includes('-')
const publish = !dryRun
const ref = inputTag || process.env.GITHUB_SHA || tag

output('version', version)
output('tag', tag)
output('ref', ref)
output('prerelease', String(prerelease))
output('publish', String(publish))
output('title', `Zen on Chromium v${version}`)

summary(
  [
    `### Release ${tag}`,
    '',
    `| | |`,
    `| --- | --- |`,
    `| Version | \`${version}\` |`,
    `| Pre-release | ${prerelease ? 'yes' : 'no'} |`,
    `| Commit | \`${ref}\` |`,
    `| Mode | ${publish ? 'build and publish' : 'dry run (build only)'} |`
  ].join('\n')
)

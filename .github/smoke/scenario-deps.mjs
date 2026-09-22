// What a scenario needs from the ones before it, and what the harness reports instead of running
// one whose dependency failed. `restore` and `crash` (with crash-restore) relaunch the profile
// `boot` leaves behind: past onboarding, quit cleanly. When boot's launch or onboarding step
// failed, that profile is not past onboarding, so each of them would only find the onboarding
// again and time out on everything behind it (#327's merge ref on 2026-09-22: one failed click
// became five unexpected failures). They are reported as skipped instead, with the step to blame;
// the boot failure alone fails the run.

/** Scenarios that relaunch the profile `boot` wrote, with the sessions each one records. */
export const BOOT_PROFILE_SCENARIOS = {
  restore: ['restore'],
  crash: ['crash', 'crash-restore']
}

/** Boot's steps that leave the profile without onboarding done when they fail. */
const PROFILE_STEPS = ['launch', 'onboarding']

/**
 * Why `name` cannot run given the scenarios recorded so far (`result.scenarios`): the name of
 * boot's launch or onboarding step when it failed (or never ran because the one before it
 * failed). Null when the scenario can run – a run without `boot` in it relaunches whatever
 * profile is on disk, as before.
 */
export function skipReason(name, scenarios) {
  if (!Object.hasOwn(BOOT_PROFILE_SCENARIOS, name)) return null
  const boot = scenarios?.boot
  if (!boot) return null
  const steps = boot.session?.steps ?? []
  for (const step of PROFILE_STEPS) {
    const st = steps.find((s) => s.name === step)
    if (!st || !st.ok) return step
  }
  return null
}

/**
 * The result entries for a scenario not run because of `reason` (from `skipReason`): one per
 * session the scenario would have recorded, so the verdict table keeps its rows, each saying
 * `skipped: <step>` in place of a step count.
 */
export function skippedEntries(name, reason) {
  const note = `boot's ${reason} step failed, so the profile ${name} relaunches is not past onboarding`
  return (BOOT_PROFILE_SCENARIOS[name] ?? [name]).map((session) => [
    session,
    { skipped: reason, note }
  ])
}

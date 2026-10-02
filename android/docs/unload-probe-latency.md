# Unload probe latency on a device (A10 step 1)

What the unload probe (`TabWebView.probeThenLoad`, #789) costs a load the core asks for – a
typed address, a bookmark, a history row – over a page with no `beforeunload` handler, measured
on whatever phone or tablet is plugged in. Twenty pairs of loads, one WITH the probe and one
WITHOUT (a debug-only hold, `UnloadProbeRules.debugHoldProbe`), back to back on the same page;
the number judged is `loadUrl` → the target's `onPageStarted`, in ms. The result is one text
block to paste back whole. Nothing is asserted on the numbers: the Design Lead decides step 2
(skipping the probe where no handler is armed) on them. Driver: `UnloadProbeLatency`
(`android/app/src/androidTest/kotlin/app/zen/chromium/UnloadProbeLatency.kt`); arithmetic:
`UnloadProbeLatencyStats` (`src/sharedTest`). Opt-in: no nightly manifest lists it.

## Prerequisites

- A **debug** build (the hold is a debug-only switch; a release build cannot turn the probe off).
- The phone with **USB debugging** on, unlocked, screen on, plugged in, and the only device adb
  sees: `adb devices` lists it as `device` (not `unauthorized`, not `offline`).
- The repo's toolchain: Node (`npm ci` once at the repo root – the Gradle build runs the
  chrome's Vite build itself), JDK 17, the Android SDK (`ANDROID_HOME` set, or
  `android/local.properties` with `sdk.dir=…`).
- Leave the phone alone for the two to three minutes the run takes (no screen off, no other
  app in front).

## The one-liner

From the repo root:

```sh
cd android && ./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=app.zen.chromium.UnloadProbeLatency \
  -Pandroid.testInstrumentationRunnerArguments.holdBackgroundWork=true \
  -Pandroid.enableAdditionalTestOutput=true
```

It builds the chrome and both APKs, installs them, runs the measurement (≈ 2–3 min: 2 warm-up
loads plus 20 pairs, 600 ms settle after each load), uninstalls, and ends `BUILD SUCCESSFUL`.
`holdBackgroundWork=true` holds the core's startup sweeps (the filter lists' and Safe Browsing
feeds' refreshes, 20 s and 35 s after boot) out of the measured window, as the perf drivers do.
Optional arguments, the same way: `loads=<pairs>` (default 20; keep ≥ 20), `settleMs=<ms>`
(default 600), `theme=dark` (default light).

### Alternative: see the block in the terminal

The same measurement by `am instrument`, which prints the block as it comes and leaves the APKs
installed:

```sh
cd android && ./gradlew :app:installDebug :app:installDebugAndroidTest && \
adb shell am instrument -w -e class app.zen.chromium.UnloadProbeLatency -e holdBackgroundWork true \
  io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
```

## Getting the findings

The block is written to four places; any one is enough.

1. **Logcat** (always there, right after either command):

   ```sh
   adb logcat -d -s UnloadProbeLatency
   ```

2. **The phone's Downloads**, as `unload-probe-latency-<yyyyMMdd-HHmmss>.txt` – the copy that
   survives the uninstall the Gradle run ends with:

   ```sh
   adb shell ls /sdcard/Download/ | grep unload-probe-latency
   adb pull /sdcard/Download/unload-probe-latency-<stamp>.txt .
   ```

3. **On the host after the Gradle one-liner** (with `-Pandroid.enableAdditionalTestOutput=true`,
   where the Gradle plugin honours it):
   `android/app/build/outputs/connected_android_test_additional_output/debugAndroidTest/connected/<device>/unload-probe-latency.txt`.

4. **While the app is still installed** (the `am instrument` route):

   ```sh
   adb pull /sdcard/Android/data/io.github.benitbuhner.zenium.debug/files/unload-probe-latency.txt .
   # or
   adb shell run-as io.github.benitbuhner.zenium.debug cat files/unload-probe-latency/unload-probe-latency.txt
   ```

The file has one line per load first (`sample pair 01 with probe  started 123.4 …
pending=probe`), then the block.

## Reading the block

```
== unload probe latency (A10 step 1) ==
device: Google Pixel 6 (oriole), API 34 (Android 14), ro.hardware oriole, abi arm64-v8a
build: …
webview: com.google.android.webview 1xx.x.xxxx.xx (code …)
page: http://127.0.0.1:18138/page.html?load=<n> (no beforeunload handler; …)
loads: 20 pairs asked, …
span: the harness's loadUrl call on the main thread … -> the view's words about the target
conditions: theme light; background work held (the startup sweeps off); display …
samples: 20 with the probe, 20 without, 20 pairs asked
-- loadUrl -> onPageStarted (the reading judged), ms --
arm            N    median      p95      min      max     mean
with probe    20     ...
without       20     ...
delta (with - without): median +…, p95 +…
paired delta (with - without, per pair): median +…, mean +…, min …, max … ms; k of 20 pairs over one frame (16.7 ms)
-- loadUrl -> history commit (navigated), ms --        (same shape)
-- loadUrl -> first progress, ms --                    (same shape)
-- loadUrl -> onPageFinished, ms --                    (same shape)
arm proof: 20/20 with-arm loads had the probe's address pending after loadUrl; 20/20 without-arm loads had the target's
VERDICT (advisory; threshold > 16.7 ms = more than one frame at 60 Hz): the probe adds +… ms median per load (paired; …) -- OVER one frame (…) | within one frame (…)
== end ==
```

- `with probe` is the product as shipped; `without` is the same load with the probe held off.
- **The number that matters is the paired delta's median** on the first table (`loadUrl ->
  onPageStarted`): each pair is one load of each arm back to back, so the device's drift
  cancels inside it. The arm medians' and p95s' deltas stand beside it.
- `arm proof` must read 20/20 and 20/20; the run fails by itself if the hold never took.
- `-- EMULATOR` on the device line means the numbers are an emulator's, not a device's.

## The decision rule (the Design Lead's)

The probe's added latency per load, as the paired median reads it:

- **> 16.7 ms** (more than one frame at 60 Hz): the probe is a cost the user can see – step 2,
  skipping the probe where the page has no `beforeunload` handler armed, is indicated.
- **≤ 16.7 ms**: the probe may stay on every core-asked load as it is (the ruling of 10-02,
  option (i)).

The verdict line is advisory – the harness asserts nothing on it; the Lead decides.

## What to paste back

The whole block, from `== unload probe latency (A10 step 1) ==` to `== end ==`, unedited, with
the device named in it; the per-load lines above it too if anything looks odd (a load that
`never` started, a sample marked `ARM NOT PROVEN`). Say which command you ran and whether the
phone was left alone.

## If it does not run

- `No connected devices` / the Gradle run skips the test: `adb devices`; one device, authorised.
- The run fails `the measurement needs a debuggable build`: you built a release variant – it is
  `connectedDebugAndroidTest`, nothing else.
- `load N … never started within 20000 ms`: the page server in the app's process did not answer
  – a VPN or a firewall app on the phone intercepting 127.0.0.1, or the app was sent to the
  background; run again with the phone left alone.
- The block says `the hold never took`: the hold did not reach the view (a release build, or a
  stale APK on the phone) – `adb uninstall io.github.benitbuhner.zenium.debug` and run again.

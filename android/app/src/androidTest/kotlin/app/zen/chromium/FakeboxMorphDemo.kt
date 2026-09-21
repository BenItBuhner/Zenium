package app.zen.chromium

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The new tab page's field becoming the omnibox, on the space page in portrait: a real finger on
 * the field at rest at both docks and on the scrim to dismiss it, the keyboard rising under the
 * bottom dock, a second tap on the double mid-flight (nothing), the predictive back gesture
 * committing mid-flight, a tap on the double on its way back, the gesture on the landed
 * omnibox pulled / cancelled / committed, the morph's frame cost for the perf program's table
 * (`ntp-morph-open-<edge>` / `ntp-morph-close-<edge>`, `DemoHarness.measureFrames` with the
 * chrome WebView's trace, unsampled), and the overflow question (eight tiles, the system font
 * size at 1.3, landscape). Judged frame by frame; see [FakeboxMorphDemoBase] for the scenes and
 * the checks. `android-ntp-morph-demo.yml` runs it first on the API 34 image's own WebView, as
 * the other phone demos run.
 *
 * Handshake under `files/ntp-morph-demo/`; stills `morph-*.png`, findings `morph-findings.txt`,
 * the sampler's rows `morph-frames-<scene>.txt`, the frame statistics `frames.jsonl` / `frames.txt`
 * and the traces `trace-<scene>.json.gz`.
 */
@RunWith(AndroidJUnit4::class)
class FakeboxMorphDemo : FakeboxMorphDemoBase(scrub = false, reduced = false, shotPrefix = "morph", handshakeDir = "ntp-morph-demo") {
    override val tag = "FakeboxMorphDemo"

    @Test
    fun record() {
        runMorphDemo()
    }
}

/**
 * The same tap and dismissal at both docks in a fresh process under `animator_duration_scale 0`
 * (the wrapper script sets it between drivers): the spring's part is a 120 ms fade in place. The
 * driver refuses to record when the WebView does not report `prefers-reduced-motion`
 * ([FakeboxMorphDemoBase.REDUCED_MOTION_NOT_REPORTED]).
 *
 * Handshake under `files/ntp-morph-reduced-demo/`; stills and findings `morph-reduced-*`.
 */
@RunWith(AndroidJUnit4::class)
class FakeboxMorphReducedDemo : FakeboxMorphDemoBase(scrub = false, reduced = true, shotPrefix = "morph-reduced", handshakeDir = "ntp-morph-reduced-demo") {
    override val tag = "FakeboxMorphReducedDemo"

    @Test
    fun record() {
        runMorphDemo()
    }
}

/**
 * The scroll scrub on the private page turned to landscape (the explainer makes it overflow past
 * the travel, which the space page in portrait never does): a steady finger carries the field to
 * the pill's slot and back at both docks, a tap on the docked pill opens the bar plainly, a
 * tap part way through the scrub morphs from the scrubbed pose and returns to it, and the scrub's
 * frame cost at each dock goes into the perf program's table (`ntp-scrub-<edge>`, the same finger
 * unsampled and traced). Private tabs need `WebViewFeature.MULTI_PROFILE`, so the
 * workflow runs this driver on an AOSP image with the Chromium snapshot WebView swapped in (the
 * private demo's recipe).
 *
 * Handshake under `files/ntp-morph-scrub-demo/`; stills and findings `morph-scrub-*`.
 */
@RunWith(AndroidJUnit4::class)
class FakeboxMorphScrubDemo : FakeboxMorphDemoBase(scrub = true, reduced = false, shotPrefix = "morph-scrub", handshakeDir = "ntp-morph-scrub-demo") {
    override val tag = "FakeboxMorphScrubDemo"

    @Test
    fun record() {
        runMorphDemo()
    }
}

/**
 * The scrub under reduced motion, in a fresh process under `animator_duration_scale 0`: the
 * finger's scrub still follows the finger (§11.3 keeps what the finger drives), and a tap part
 * way fades the double in place instead of flying it.
 *
 * Handshake under `files/ntp-morph-scrub-reduced-demo/`; stills and findings `morph-scrub-reduced-*`.
 */
@RunWith(AndroidJUnit4::class)
class FakeboxMorphScrubReducedDemo : FakeboxMorphDemoBase(scrub = true, reduced = true, shotPrefix = "morph-scrub-reduced", handshakeDir = "ntp-morph-scrub-reduced-demo") {
    override val tag = "FakeboxMorphScrubReducedDemo"

    @Test
    fun record() {
        runMorphDemo()
    }
}

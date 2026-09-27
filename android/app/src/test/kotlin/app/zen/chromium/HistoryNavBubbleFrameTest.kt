package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `chrome.historyNavBubble`'s frame (from `HistoryNavBubble.tsx`, CSS px of the chrome's window)
 * read into device px for the native disc: the box scaled by the density, the flags through,
 * `{ visible: false }` as the bubble down.
 */
class HistoryNavBubbleFrameTest {
    private val density = 1.75f

    private fun frame(json: String): HistoryNavBubbleFrame? = HistoryNavBubbleFrame.parse(JSONObject(json), density)

    @Test
    fun theBoxIsScaledByTheDensity() {
        val f = frame("""{"edge":"left","left":52,"top":378,"size":44,"scale":1.15,"opacity":1,"armed":true,"reduced":false}""")!!
        assertEquals(HistoryNavClassifier.Edge.LEFT, f.edge)
        assertEquals(52f * density, f.leftPx, 1e-4f)
        assertEquals(378f * density, f.topPx, 1e-4f)
        assertEquals(77, f.sizePx)
        assertEquals(1.15f, f.scale, 1e-6f)
        assertEquals(1f, f.alpha, 1e-6f)
        assertTrue(f.armed)
        assertFalse(f.reduced)
    }

    @Test
    fun theRightEdgeAndTheReducedFlagComeThrough() {
        val f = frame("""{"edge":"right","left":264,"top":378,"size":44,"scale":1,"opacity":0.5,"armed":false,"reduced":true}""")!!
        assertEquals(HistoryNavClassifier.Edge.RIGHT, f.edge)
        assertEquals(0.5f, f.alpha, 1e-6f)
        assertFalse(f.armed)
        assertTrue(f.reduced)
    }

    @Test
    fun visibleFalseTakesTheBubbleDown() {
        assertNull(frame("""{"visible":false}"""))
    }

    @Test
    fun aFrameWithoutASizeIsNoFrame() {
        assertNull(frame("""{"edge":"left","left":0,"top":0}"""))
        assertNull(frame("""{"edge":"left","left":0,"top":0,"size":0}"""))
    }

    @Test
    fun theVisualsAreClampedToWhatAViewTakes() {
        val f = frame("""{"edge":"left","left":-44,"top":0,"size":44,"scale":-0.2,"opacity":1.6}""")!!
        assertEquals(0f, f.scale, 0f)
        assertEquals(1f, f.alpha, 0f)
        // The rest: a whole disc out beyond the side, negative in window px.
        assertEquals(-44f * density, f.leftPx, 1e-4f)
        // Unnamed flags read as off.
        assertFalse(f.armed)
        assertFalse(f.reduced)
    }

    @Test
    fun theClipIsThePageFramesBoxInDevicePx() {
        // The phone's frame: 6 CSS px in from the window's left, 360 wide; 10.5 px rounds to 11.
        val f = frame(
            """{"edge":"left","left":-38,"top":378,"size":44,"clip":{"left":6,"top":100.4,"right":366,"bottom":700}}"""
        )!!
        assertEquals(HistoryNavBubbleFrame.Clip(11, 176, 641, 1225), f.clip)
    }

    @Test
    fun noClipOrAnEmptyOneLeavesTheDiscUnclipped() {
        assertNull(frame("""{"edge":"left","left":-44,"top":378,"size":44}""")!!.clip)
        assertNull(frame("""{"edge":"left","left":-44,"top":378,"size":44,"clip":{"left":6,"top":100,"right":6,"bottom":700}}""")!!.clip)
    }

    // The caption (Chrome's close indicator at the history's first page): its text and how far out it is.

    @Test
    fun theCaptionComesThroughWithItsText() {
        val f = frame("""{"edge":"left","left":52,"top":378,"size":44,"armed":true,"caption":0.5,"captionText":"Close tab"}""")!!
        assertEquals("Close tab", f.captionText)
        assertEquals(0.5f, f.caption, 1e-6f)
        val whole = frame("""{"edge":"left","left":52,"top":378,"size":44,"armed":true,"caption":1,"captionText":"Close Zenium"}""")!!
        assertEquals("Close Zenium", whole.captionText)
        assertEquals(1f, whole.caption, 0f)
    }

    @Test
    fun aFrameWithoutACaptionIsADisc() {
        val f = frame("""{"edge":"left","left":52,"top":378,"size":44,"armed":true}""")!!
        assertNull(f.captionText)
        assertEquals(0f, f.caption, 0f)
        // An extent with no text, or a blank one, is a disc too: a caption is a text.
        assertEquals(0f, frame("""{"edge":"left","left":52,"top":378,"size":44,"caption":1}""")!!.caption, 0f)
        val blank = frame("""{"edge":"left","left":52,"top":378,"size":44,"caption":1,"captionText":"  "}""")!!
        assertNull(blank.captionText)
        assertEquals(0f, blank.caption, 0f)
    }

    @Test
    fun theCaptionsExtentIsClampedToTheUnit() {
        assertEquals(1f, frame("""{"edge":"left","left":52,"top":378,"size":44,"caption":1.4,"captionText":"Close tab"}""")!!.caption, 0f)
        assertEquals(0f, frame("""{"edge":"left","left":52,"top":378,"size":44,"caption":-0.2,"captionText":"Close tab"}""")!!.caption, 0f)
    }

    @Test
    fun theCaptionStartsPastTheArrowAndThePillRunsItsEndPaddingBeyondTheText() {
        // A 44 dp disc at density 2: the text starts at the disc's centre (44) plus the arrow's
        // half-box (20) plus the gap (12) = 76 px; a 100 px text with the 24 px end padding
        // takes the pill to 200 px, 112 beyond the disc's 88.
        val g = captionGeometry(sizePx = 88, textWidthPx = 100f, density = 2f)
        assertEquals(76f, g.textX, 1e-4f)
        assertEquals(112f, g.advance, 1e-4f)
        // The pill never runs short of the disc, whatever the text.
        assertTrue(captionGeometry(sizePx = 88, textWidthPx = 0f, density = 2f).advance >= 0f)
    }

    // The disc's opacity per frame (`HistoryNavBubbleView.setShown` through `bubbleAlphaStep`).

    @Test
    fun withMotionOnEveryFrameSetsTheAlphaOutright() {
        // The chrome's spring is the animation: the leave's frames arrive already faded.
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = false, target = 0.5f, alpha = 0f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = false, target = 0f, alpha = 1f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = false, target = 0f, alpha = 0.3f, fading = true))
    }

    @Test
    fun underReducedMotionTheDragsFramesSetTheAlphaOutright() {
        // The fade-in over the first 16 px, and the disc held at 1 while the finger moves: no
        // animator per touch sample.
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 0f, alpha = 0f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 0.5f, alpha = 0f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 1f, alpha = 0.5f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 1f, alpha = 1f, fading = false))
    }

    @Test
    fun underReducedMotionTheLeaveIsTheOneFade() {
        // The release: the machine's hide arrives whole, a showing disc taken to nothing.
        assertEquals(BubbleAlphaStep.FADE, bubbleAlphaStep(reduced = true, target = 0f, alpha = 1f, fading = false))
        assertEquals(BubbleAlphaStep.FADE, bubbleAlphaStep(reduced = true, target = 0f, alpha = 0.4f, fading = false))
        // The machine's rest frame 120 ms on, still at nothing: the fade that runs is left to finish.
        assertEquals(BubbleAlphaStep.KEEP, bubbleAlphaStep(reduced = true, target = 0f, alpha = 0.2f, fading = true))
        assertEquals(BubbleAlphaStep.KEEP, bubbleAlphaStep(reduced = true, target = 0f, alpha = 0f, fading = true))
    }

    @Test
    fun aFrameThatShowsTheDiscAgainCutsARunningFade() {
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 1f, alpha = 0.2f, fading = true))
    }

    // The threshold's tap (`HistoryNavBubbleLayer.apply` through `BubbleThresholdTap`): Chrome's
    // KEYBOARD_TAP as `willNavigate()` turns true, once per rising crossing.

    @Test
    fun theThresholdTapsOnceOnTheFrameThatArms() {
        val tap = BubbleThresholdTap()
        // The drag's frames up to the threshold: nothing.
        assertFalse(tap.take(false))
        assertFalse(tap.take(false))
        // The crossing frame taps; the frames past it, the finger held there, do not.
        assertTrue(tap.take(true))
        assertFalse(tap.take(true))
        assertFalse(tap.take(true))
    }

    @Test
    fun theReleasePastTheThresholdAndTheLeaveTapNothing() {
        val tap = BubbleThresholdTap()
        assertFalse(tap.take(false))
        assertTrue(tap.take(true))
        // The commit: the machine keeps `armed` on through the exit fade's frames, then takes the bubble down.
        assertFalse(tap.take(true))
        assertFalse(tap.take(true))
        assertFalse(tap.take(null))
    }

    @Test
    fun easingBackUnderTheThresholdAndCrossingAgainTapsAgain() {
        // Chrome re-arms on each change of `willNavigate()` to true: a second crossing is a second tap.
        val tap = BubbleThresholdTap()
        assertFalse(tap.take(false))
        assertTrue(tap.take(true))
        assertFalse(tap.take(false))
        assertFalse(tap.take(false))
        assertTrue(tap.take(true))
    }

    @Test
    fun theBubbleGoingDownArmedLeavesTheNextDragToStartUnarmed() {
        val tap = BubbleThresholdTap()
        assertTrue(tap.take(true))
        // Down (the commit's end, or an abort) while armed; the next drag's first frames are unarmed, its crossing taps.
        assertFalse(tap.take(null))
        assertFalse(tap.take(false))
        assertTrue(tap.take(true))
        // Down and straight into a drag that arms on its first frame (reduced motion's jump): a crossing all the same.
        assertFalse(tap.take(null))
        assertTrue(tap.take(true))
    }

    @Test
    fun aShortDragThatNeverArmsTapsNothing() {
        val tap = BubbleThresholdTap()
        assertFalse(tap.take(false))
        assertFalse(tap.take(false))
        assertFalse(tap.take(null))
    }

    // The arrow's tint (`ArmedTint`, stepped by `HistoryNavBubbleView` on the chrome's frames and
    // its own ticks): Chrome's 250 ms to the accent as the drag arms, back as it disarms, from
    // wherever it stands (the lead's 04:34 ruling, v2 §11.9 amended for the arrow alone).

    @Test
    fun theRisingArmedStartsTheTintTowardTheAccentOverChromes250ms() {
        val tint = ArmedTint()
        // The drag's frames up to the threshold: the ink, nothing running.
        assertEquals(0f, tint.take(false, reduced = false, nowMs = 0L), 1e-6f)
        assertEquals(0f, tint.take(false, reduced = false, nowMs = 50L), 1e-6f)
        assertFalse(tint.running)
        // The crossing frame: still the ink on that frame, the tween started.
        assertEquals(0f, tint.take(true, reduced = false, nowMs = 100L), 1e-6f)
        assertTrue(tint.running)
        assertEquals(0.2f, tint.step(150L), 1e-6f)
        assertEquals(0.6f, tint.step(250L), 1e-6f)
        assertEquals(1f, tint.step(350L), 1e-6f)
        // Done at 250 ms, held there; the frames past it with the finger held move nothing.
        assertFalse(tint.running)
        assertEquals(1f, tint.step(1_000L), 1e-6f)
        assertEquals(1f, tint.take(true, reduced = false, nowMs = 1_400L), 1e-6f)
        assertFalse(tint.running)
    }

    @Test
    fun theFallingArmedRunsTheTintBackFromWhereItStands() {
        val tint = ArmedTint()
        tint.take(true, reduced = false, nowMs = 0L)
        assertEquals(1f, tint.step(250L), 1e-6f)
        // The finger eases back under the threshold: the value on that frame is kept, the target the ink.
        assertEquals(1f, tint.take(false, reduced = false, nowMs = 400L), 1e-6f)
        assertTrue(tint.running)
        assertEquals(0.6f, tint.step(500L), 1e-6f)
        assertEquals(0.2f, tint.step(600L), 1e-6f)
        assertEquals(0f, tint.step(650L), 1e-6f)
        assertFalse(tint.running)
        assertEquals(0f, tint.step(900L), 1e-6f)
    }

    @Test
    fun aReCrossMidTweenReversesWithoutAJump() {
        val tint = ArmedTint()
        tint.take(true, reduced = false, nowMs = 0L)
        // 100 ms into the rise the finger eases back: the frame reads .4 and the fall starts from .4.
        assertEquals(0.4f, tint.take(false, reduced = false, nowMs = 100L), 1e-6f)
        assertEquals(0.2f, tint.step(150L), 1e-6f)
        // And crosses again 50 ms later: the frame reads .2 and the rise resumes from .2 – no jump either way.
        assertEquals(0.2f, tint.take(true, reduced = false, nowMs = 150L), 1e-6f)
        assertEquals(0.6f, tint.step(250L), 1e-6f)
        assertEquals(1f, tint.step(350L), 1e-6f)
        assertFalse(tint.running)
    }

    @Test
    fun theTintNeverOvershootsEitherEnd() {
        val tint = ArmedTint()
        tint.take(true, reduced = false, nowMs = 0L)
        // A long gap between frames (the chrome idle with the finger held) lands on 1, not past it.
        assertEquals(1f, tint.step(5_000L), 1e-6f)
        tint.take(false, reduced = false, nowMs = 5_000L)
        assertEquals(0f, tint.step(20_000L), 1e-6f)
        // A clock that reads earlier than the last frame moves nothing.
        tint.take(true, reduced = false, nowMs = 20_000L)
        assertEquals(0f, tint.step(19_000L), 1e-6f)
    }

    @Test
    fun theBubbleGoingDownResetsTheTintForTheNextDrag() {
        val tint = ArmedTint()
        tint.take(true, reduced = false, nowMs = 0L)
        tint.step(250L)
        // Down at the commit's end (or an abort) while armed and at the accent: the ink at once, nothing running.
        assertEquals(0f, tint.take(null, reduced = false, nowMs = 900L), 1e-6f)
        assertFalse(tint.running)
        // The next drag's first frames are the ink whatever the clock says since; its crossing starts the tween afresh.
        assertEquals(0f, tint.take(false, reduced = false, nowMs = 30_000L), 1e-6f)
        assertEquals(0f, tint.take(true, reduced = false, nowMs = 30_100L), 1e-6f)
        assertEquals(0.4f, tint.step(30_200L), 1e-6f)
        // Down mid-tween: the same reset.
        assertEquals(0f, tint.take(null, reduced = false, nowMs = 30_200L), 1e-6f)
        assertFalse(tint.running)
    }

    @Test
    fun reducedMotionRidesTheTintOver120msNotAJump() {
        val tint = ArmedTint()
        tint.take(false, reduced = true, nowMs = 0L)
        assertEquals(0f, tint.take(true, reduced = true, nowMs = 0L), 1e-6f)
        assertTrue(tint.running)
        // v2 §11.3's 120 ms: a tween still – half way at 60 ms, done at 120.
        assertEquals(0.5f, tint.step(60L), 1e-6f)
        assertEquals(1f, tint.step(120L), 1e-6f)
        assertFalse(tint.running)
        // And back over the same 120 ms.
        tint.take(false, reduced = true, nowMs = 500L)
        assertEquals(0.5f, tint.step(560L), 1e-6f)
        assertEquals(0f, tint.step(620L), 1e-6f)
    }

    @Test
    fun theCaptionWearsTheArrowsInkAtEverySampleAndTheFillAndHairlineNeverTint() {
        val text = 0xFF1F2328.toInt()
        val accent = 0xFF3B82F6.toInt()
        val panel = 0xFFFFFFFF.toInt()
        val border = 0x1F000000
        for (sample in listOf(0f, 0.1f, 0.25f, 0.5f, 0.75f, 0.9f, 1f)) {
            val inks = bubbleInks(text, accent, panel, border, sample)
            // One ink per pill (the lead's ruling (a)): the caption's text is the arrow's colour, whatever the tint.
            assertEquals("caption ink at $sample", inks.arrow, inks.caption)
            // The pill's fill and hairline are the panel and the border at every sample (ruling (d)).
            assertEquals("fill at $sample", panel, inks.fill)
            assertEquals("hairline at $sample", border, inks.border)
        }
        // The ends exact: the text ink at 0, the accent at 1.
        assertEquals(text, bubbleInks(text, accent, panel, border, 0f).arrow)
        assertEquals(accent, bubbleInks(text, accent, panel, border, 1f).arrow)
    }

    @Test
    fun theInkMixesPerChannelBetweenTheTextAndTheAccent() {
        // Black to white, half way: mid grey per channel, the alpha kept opaque.
        assertEquals(0xFF808080.toInt(), lerpArgb(0xFF000000.toInt(), 0xFFFFFFFF.toInt(), 0.5f))
        // The alpha channel mixes too; a tint past the ends is clamped.
        assertEquals(0x80000000.toInt(), lerpArgb(0x00000000, 0xFF000000.toInt(), 0.5f))
        assertEquals(0xFF3B82F6.toInt(), lerpArgb(0xFF1F2328.toInt(), 0xFF3B82F6.toInt(), 1.5f))
        assertEquals(0xFF1F2328.toInt(), lerpArgb(0xFF1F2328.toInt(), 0xFF3B82F6.toInt(), -0.5f))
        // A quarter of the way from the text ink to the accent, channel by channel.
        val quarter = lerpArgb(0xFF1F2328.toInt(), 0xFF3B82F6.toInt(), 0.25f)
        assertEquals(0xFF, quarter ushr 24)
        assertEquals(0x1F + ((0x3B - 0x1F) * 0.25f).toInt(), (quarter shr 16) and 0xFF)
        assertEquals(0x23 + Math.round((0x82 - 0x23) * 0.25f), (quarter shr 8) and 0xFF)
        assertEquals(0x28 + Math.round((0xF6 - 0x28) * 0.25f), quarter and 0xFF)
    }
}

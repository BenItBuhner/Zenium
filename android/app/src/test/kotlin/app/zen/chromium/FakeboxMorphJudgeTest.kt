package app.zen.chromium

import app.zen.chromium.FakeboxMorph.Box
import app.zen.chromium.FakeboxMorph.Frame
import app.zen.chromium.FakeboxMorph.Geometry
import app.zen.chromium.FakeboxMorph.OmniField
import app.zen.chromium.FakeboxMorph.PageField
import app.zen.chromium.FakeboxMorph.Pill
import app.zen.chromium.FakeboxMorph.clamp01
import app.zen.chromium.FakeboxMorph.lerp
import app.zen.chromium.FakeboxMorph.lerpBox
import app.zen.chromium.FakeboxMorph.pillLook
import app.zen.chromium.FakeboxMorph.restBox
import app.zen.chromium.FakeboxMorph.restRadius
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The judge behind `FakeboxMorphDemo` ([FakeboxMorph]), run over frames built the way the chrome
 * draws the morph (main.css's rules for the double's looks and words, `restPose` for the scrub)
 * and over the same frames spoiled the way each check is meant to catch: two fields in one frame,
 * a pop, a box off the line, a value turning round, a field moving against the finger, a cut
 * where reduced motion wants a fade.
 */
class FakeboxMorphJudgeTest {
    /** A 411 px wide phone, the bar docked above: the field 48 tall on the page, the pill's slot and the omnibox's field in the band. */
    private val top = Geometry(rest = Box(24f, 300f, 363f, 48f), slot = Box(56f, 36f, 243f, 44f), frameTop = 92f)
    private val omniTop = Box(56f, 36f, 299f, 44f)

    /** The same page with the bar docked below (the frame starts under the status bar). */
    private val bottom = Geometry(rest = Box(24f, 240f, 363f, 48f), slot = Box(56f, 780f, 243f, 44f), frameTop = 32f)
    private val omniBottom = Box(56f, 780f, 299f, 44f)

    private fun double(box: Box, m: Float, pill: Float = 0f, radius: Float = lerp(12f, 22f, m), layer: Float = 1f) =
        FakeboxMorph.Double(
            box = box, radius = radius, layer = layer,
            lookField = clamp01(2 - 2 * m) * (1 - pill), lookOmni = clamp01(2 * m),
            fieldWords = clamp01(1 - 2 * m) * (1 - pill), omniWords = clamp01(2 * m - 1),
            moving = true
        )

    private fun frame(
        t: Int, phase: String, look: String, m: Float, g: Geometry, omni: Box, scroll: Float = 0f,
        urlbarOpen: Boolean = phase != "rest", double: FakeboxMorph.Double? = null, pageField: PageField? = null,
        omniField: OmniField? = null, pill: Pill? = null, pillValue: Float = 0f, insetBottom: Float = 0f
    ) = Frame(
        t = t, phase = phase, look = look, morph = m, pill = pillValue, scroll = scroll, urlbarOpen = urlbarOpen,
        insetBottom = insetBottom, double = double, pageField = pageField, omniField = omniField, pillSlot = pill,
        bar = 1f, sheet = if (phase == "rest") -1f else 1f, page = 1f
    )

    private val well = Pill(top.slot, away = true, words = 0f)

    /** The value the spring writes over a tap from rest, sampled at 16 ms: the closed-form curve's shape, monotone, largest step .12. */
    private val springValues = listOf(0f, 0.04f, 0.14f, 0.27f, 0.41f, 0.54f, 0.66f, 0.76f, 0.84f, 0.9f, 0.94f, 0.97f, 0.99f, 1f)

    /** A tap on the resting field: the double flies from the page's field to the omnibox's, then the omnibox's own field takes over. */
    private fun opening(g: Geometry, omni: Box, values: List<Float> = springValues, moving: (Int) -> Box = { omni }): List<Frame> {
        val frames = ArrayList<Frame>()
        frames += frame(0, "rest", "", 0f, g, omni, pageField = PageField(g.rest, 1f), pill = well, urlbarOpen = false)
        values.forEachIndexed { i, m ->
            val target = moving(i)
            frames += frame(
                16 + i * 16, "opening", "opening", m, g, target,
                double = double(lerpBox(g.rest, target, m), m),
                pageField = PageField(g.rest, 0f), omniField = OmniField(target, 0f, 0f), pill = well
            )
        }
        val target = moving(values.size)
        frames += frame(16 + values.size * 16, "open", "open", 1f, g, target, omniField = OmniField(target, 1f, 1f), pageField = PageField(g.rest, 0f), pill = null)
        return frames
    }

    /** The omnibox dismissed: the double flies back from the omnibox's field to the page's, then the page's own field is back. */
    private fun closing(g: Geometry, omni: Box, from: Float = 1f): List<Frame> {
        val frames = ArrayList<Frame>()
        frames += frame(0, "open", "open", 1f, g, omni, omniField = OmniField(omni, 1f, 1f), pageField = PageField(g.rest, 0f))
        val values = springValues.map { from * (1 - it) }
        values.forEachIndexed { i, m ->
            frames += frame(
                16 + i * 16, "closing", "closing", m, g, omni,
                double = double(lerpBox(g.rest, omni, m), m),
                pageField = PageField(g.rest, 0f), omniField = OmniField(omni, 0f, 0f), pill = well
            )
        }
        frames += frame(16 + values.size * 16, "rest", "", 0f, g, omni, pageField = PageField(g.rest, 1f), pill = well, urlbarOpen = false)
        return frames
    }

    /**
     * A back committed on the landed omnibox after a pull: the bar's spring runs the field home
     * under the pull (the machine open, the look pulled, `BackDismissal.commit`), then rest.
     */
    private fun pulledHome(g: Geometry, omni: Box): List<Frame> {
        val frames = ArrayList<Frame>()
        frames += frame(0, "open", "open", 1f, g, omni, omniField = OmniField(omni, 1f, 1f), pageField = PageField(g.rest, 0f))
        val values = springValues.map { 1 - it }
        values.forEachIndexed { i, m ->
            frames += frame(
                16 + i * 16, "open", "pulled", m, g, omni,
                double = double(lerpBox(g.rest, omni, m), m),
                pageField = PageField(g.rest, 0f), omniField = OmniField(omni, 0f, 0f), pill = well
            )
        }
        frames += frame(16 + values.size * 16, "rest", "", 0f, g, omni, pageField = PageField(g.rest, 1f), pill = well, urlbarOpen = false)
        return frames
    }

    /** The page scrolled under a steady finger to `to` px, one frame per `step` px. */
    private fun scrub(g: Geometry, to: Float, step: Float = 12f): List<Frame> {
        val frames = ArrayList<Frame>()
        var scroll = 0f
        var t = 0
        while (scroll <= to + 0.01f) {
            val s = g.scrubOf(scroll)
            val handover = pillLook(s)
            val box = restBox(g, s)
            val docked = s >= 1f
            frames += if (g.dockBelow) {
                frame(
                    t, "rest", if (docked) "docked" else if (scroll > 0f) "scrub" else "", 0f, g, omniBottom, scroll = scroll, urlbarOpen = false,
                    pageField = PageField(box, if (docked) 0f else 1 - handover),
                    pill = Pill(g.slot, away = !docked, words = if (docked) 1f else handover), pillValue = handover
                )
            } else {
                frame(
                    t, "rest", if (docked) "docked" else if (scroll > 0f) "scrub" else "", 0f, g, omniTop, scroll = scroll, urlbarOpen = false,
                    double = if (scroll > 0f && !docked) double(box, 0f, pill = handover, radius = restRadius(g, s)) else null,
                    pageField = PageField(g.rest, if (scroll > 0f) 0f else 1f),
                    pill = Pill(g.slot, away = !docked, words = if (docked) 1f else handover), pillValue = handover
                )
            }
            scroll += step
            t += 16
        }
        return frames
    }

    private fun Frame.with(double: FakeboxMorph.Double? = this.double, pageField: PageField? = this.pageField, omniField: OmniField? = this.omniField, morph: Float = this.morph) =
        copy(double = double, pageField = pageField, omniField = omniField, morph = morph)

    private fun spoil(frames: List<Frame>, at: Int, edit: (Frame) -> Frame): List<Frame> = frames.mapIndexed { i, f -> if (i == at) edit(f) else f }

    // --- one surface -------------------------------------------------------------------------------

    @Test
    fun `a tap from rest draws the field once on every frame, top and bottom dock`() {
        assertTrue(FakeboxMorph.oneSurface(opening(top, omniTop)).toString(), FakeboxMorph.oneSurface(opening(top, omniTop)).ok)
        assertTrue(FakeboxMorph.oneSurface(opening(bottom, omniBottom)).ok)
        assertTrue(FakeboxMorph.oneSurface(closing(top, omniTop)).ok)
    }

    @Test
    fun `the omnibox's own content fading in under the flying double is two fields in one frame`() {
        val frames = spoil(opening(top, omniTop), 8) { it.with(omniField = OmniField(omniTop, 0f, 0.3f)) }
        val v = FakeboxMorph.oneSurface(frames)
        assertFalse(v.ok)
        assertTrue(v.detail, v.detail.contains("omnibox's field draws 0.30 before the landing"))
    }

    @Test
    fun `the page's field showing under the double, or a see-through double, is caught`() {
        val under = spoil(opening(top, omniTop), 5) { it.with(pageField = PageField(top.rest, 0.4f)) }
        assertFalse(FakeboxMorph.oneSurface(under).ok)
        val thin = spoil(opening(top, omniTop), 5) { it.with(double = it.double!!.copy(lookField = 0.3f, lookOmni = 0.3f)) }
        val v = FakeboxMorph.oneSurface(thin)
        assertFalse(v.ok)
        assertTrue(v.detail, v.detail.contains("covers only"))
    }

    @Test
    fun `a tap from a scrubbed pose past seven tenths sets out with the well part filled and is still one surface`() {
        val s = 0.85f
        val handover = pillLook(s)
        val from = restBox(top, s)
        val frames = ArrayList<Frame>()
        springValues.forEachIndexed { i, m ->
            val p = handover * (1 - m)
            frames += frame(
                i * 16, "opening", "opening", m, top, omniTop, scroll = s * top.travel,
                double = double(lerpBox(from, omniTop, m), m, pill = p, radius = lerp(restRadius(top, s), 22f, m)),
                pageField = PageField(top.rest, 0f), omniField = OmniField(omniTop, 0f, 0f), pill = Pill(top.slot, true, p), pillValue = p
            )
        }
        assertTrue(FakeboxMorph.oneSurface(frames).detail, FakeboxMorph.oneSurface(frames).ok)
        assertTrue(FakeboxMorph.onTheLine(frames, top).detail, FakeboxMorph.onTheLine(frames, top).ok)
        assertTrue(FakeboxMorph.wordsHandover(frames).detail, FakeboxMorph.wordsHandover(frames).ok)
    }

    // --- no pop --------------------------------------------------------------------------------------

    @Test
    fun `the spring's steps are under the bound and the landing is where the omnibox's field is`() {
        val v = FakeboxMorph.noJump(opening(top, omniTop))
        assertTrue(v.detail, v.ok)
        assertTrue(FakeboxMorph.noJump(closing(bottom, omniBottom)).ok)
    }

    @Test
    fun `a value that leaps or a field that pops across the frame fails`() {
        val leap = spoil(opening(top, omniTop), 6) { it.with(morph = 0.97f) }
        assertFalse(FakeboxMorph.noJump(leap).ok)
        // The double drawn at the page's field one frame and in the band the next.
        val pop = spoil(opening(top, omniTop), 3) { it.with(double = it.double!!.copy(box = omniTop)) }
        val v = FakeboxMorph.noJump(pop)
        assertFalse(v.ok)
        assertTrue(v.detail, v.detail.contains("the field jumped"))
    }

    @Test
    fun `a landing anywhere but the omnibox's field is a pop`() {
        val frames = opening(top, omniTop)
        val elsewhere = spoil(frames, frames.lastIndex) { it.with(omniField = OmniField(omniTop.copy(y = omniTop.y + 200f), 1f, 1f)) }
        assertFalse(FakeboxMorph.noJump(elsewhere).ok)
    }

    @Test
    fun `the riding field handing over to the pill by a fade at a bottom dock is not a pop`() {
        val v = FakeboxMorph.noJump(scrub(bottom, bottom.travel + 24f))
        assertTrue(v.detail, v.ok)
    }

    @Test
    fun `the keyboard carrying the omnibox up whole on the landing frame is the target's move, not a pop`() {
        // The emulator's frame clock: the inset arrives between the double's last frame and the landing
        // (run 1's bottom-retap, frames 21-22: 24 -> 332 px), and the omnibox's field (the landed field
        // with it) is drawn 300 px higher than the double was.
        val n = springValues.size
        val lifted = omniBottom.copy(y = omniBottom.y - 300f)
        val carried = spoil(opening(bottom, omniBottom, moving = { i -> if (i >= n) lifted else omniBottom }), n + 1) { it.copy(insetBottom = 300f) }
        val v = FakeboxMorph.noJump(carried)
        assertTrue(v.detail, v.ok)
        // The double that trails the target by the frame the controller takes to re-measure: the inset
        // and the omnibox's box move on one pair, the double follows on the next.
        val trailing = spoil(opening(bottom, omniBottom, moving = { i -> if (i >= n - 1) lifted else omniBottom }), n) { f ->
            f.copy(insetBottom = 300f, double = f.double!!.copy(box = omniBottom))
        }.let { spoil(it, n + 1) { f -> f.copy(insetBottom = 300f) } }
        val t = FakeboxMorph.noJump(trailing)
        assertTrue(t.detail, t.ok)
        // The same move with no change of the inset is the landing popping away from where the double was.
        val frames = opening(bottom, omniBottom)
        val popped = spoil(frames, frames.lastIndex) { it.with(omniField = OmniField(lifted, 1f, 1f)) }
        assertFalse(FakeboxMorph.noJump(popped).ok)
        // And the keyboard's inset alone, with the omnibox's field standing (a top dock), excuses nothing.
        val topFrames = opening(top, omniTop)
        val cut = spoil(spoil(topFrames, 3) { it.with(double = it.double!!.copy(box = omniTop)) }, 3) { it.copy(insetBottom = 300f) }
        assertFalse(FakeboxMorph.noJump(cut).ok)
    }

    @Test
    fun `two pulled frames are the finger's pace and are not bounded`() {
        // A flick on a slow frame clock: the value drops from .86 to .34 between two pulled frames, the box with it.
        val flicked = pulledHome(bottom, omniBottom).filterIndexed { i, _ -> i !in 3..6 }
        val v = FakeboxMorph.noJump(flicked)
        assertTrue(v.detail, v.ok)
        assertTrue(v.detail, v.detail.contains("left to the gesture"))
        // The same drop on the closing segment is the spring's, and a pop.
        assertFalse(FakeboxMorph.noJump(closing(bottom, omniBottom).filterIndexed { i, _ -> i !in 3..6 }).ok)
    }

    // --- the line ------------------------------------------------------------------------------------

    @Test
    fun `every frame of a tap and of a dismissal is on the line from the page's field to the omnibox's`() {
        assertTrue(FakeboxMorph.onTheLine(opening(top, omniTop), top).ok)
        assertTrue(FakeboxMorph.onTheLine(opening(bottom, omniBottom), bottom).ok)
        assertTrue(FakeboxMorph.onTheLine(closing(top, omniTop), top).ok)
        // A dismissal caught mid-flight runs the rest of the same line back.
        assertTrue(FakeboxMorph.onTheLine(closing(top, omniTop, from = 0.6f), top).ok)
    }

    @Test
    fun `a box off the line, or a radius of its own, fails`() {
        val off = spoil(opening(top, omniTop), 5) { it.with(double = it.double!!.copy(box = it.double!!.box.copy(x = it.double!!.box.x + 8f))) }
        val v = FakeboxMorph.onTheLine(off, top)
        assertFalse(v.ok)
        assertTrue(v.detail, v.detail.contains("off the line"))
        val round = spoil(opening(top, omniTop), 5) { it.with(double = it.double!!.copy(radius = 22f)) }
        assertFalse(FakeboxMorph.onTheLine(round, top).ok)
    }

    @Test
    fun `the keyboard moving the target at a bottom dock is followed within a frame`() {
        // The band rises 20 px a frame over frames 3..8 as the keyboard arrives; the double's box is drawn to the
        // previous frame's target (the controller re-measures a frame behind the inset).
        val targets = (0..springValues.size).map { i -> omniBottom.copy(y = omniBottom.y - 20f * (i.coerceIn(3, 8) - 3)) }
        val trailing = opening(bottom, omniBottom, moving = { targets[it] }).mapIndexed { i, f ->
            if (f.phase == "opening" && i >= 2) f.with(double = f.double!!.copy(box = lerpBox(bottom.rest, targets[i - 2], f.morph))) else f
        }
        val v = FakeboxMorph.onTheLine(trailing, bottom)
        assertTrue(v.detail, v.ok)
        assertTrue(v.detail, v.detail.contains("a frame behind"))
        // Two frames behind is a line of its own.
        val lagging = opening(bottom, omniBottom, moving = { targets[it] }).mapIndexed { i, f ->
            if (f.phase == "opening" && i >= 3) f.with(double = f.double!!.copy(box = lerpBox(bottom.rest, targets[i - 3], f.morph))) else f
        }
        assertFalse(FakeboxMorph.onTheLine(lagging, bottom).ok)
    }

    // --- monotone ------------------------------------------------------------------------------------

    @Test
    fun `the value only grows while opening and only shrinks while closing`() {
        assertTrue(FakeboxMorph.monotoneSpring(opening(top, omniTop)).ok)
        assertTrue(FakeboxMorph.monotoneSpring(closing(top, omniTop)).ok)
        val dip = spoil(opening(top, omniTop), 7) { it.with(morph = 0.5f) }
        assertFalse(FakeboxMorph.monotoneSpring(dip).ok)
    }

    @Test
    fun `under a steady finger the scrubbed double's edges move one way at a top dock`() {
        val v = FakeboxMorph.steadyFinger(scrub(top, top.travel), top)
        assertTrue(v.detail, v.ok)
        // The finger stops and the field slips back: caught.
        val frames = scrub(top, top.travel * 0.6f)
        val slipped = spoil(frames, frames.lastIndex) { f -> f.with(double = f.double!!.copy(box = restBox(top, top.scrubOf(f.scroll) - 0.1f))) }
        assertFalse(FakeboxMorph.steadyFinger(slipped, top).ok)
    }

    @Test
    fun `at a bottom dock the field rides one to one with the finger and never against it`() {
        assertTrue(FakeboxMorph.steadyFinger(scrub(bottom, bottom.travel), bottom).ok)
        // The pre-L1 shape: the field travelling down toward the dock, four times the finger.
        val against = scrub(bottom, bottom.travel * 0.5f).map { f ->
            val s = bottom.scrubOf(f.scroll)
            f.with(pageField = PageField(lerpBox(bottom.rest, bottom.slot, s), f.pageField!!.opacity))
        }
        val v = FakeboxMorph.steadyFinger(against, bottom)
        assertFalse(v.ok)
        assertTrue(v.detail, v.detail.contains("against a finger"))
        val ridesTooFar = scrub(bottom, bottom.travel * 0.5f).map { f ->
            f.with(pageField = PageField(bottom.rest.copy(y = bottom.rest.y - 2 * f.scroll), f.pageField!!.opacity))
        }
        assertFalse(FakeboxMorph.steadyFinger(ridesTooFar, bottom).ok)
    }

    // --- the landing and the return -----------------------------------------------------------------

    @Test
    fun `the omnibox's field takes over on the frame after the double's last`() {
        val v = FakeboxMorph.landing(opening(top, omniTop))
        assertTrue(v.detail, v.ok)
        assertTrue(FakeboxMorph.returned(closing(top, omniTop)).ok)
    }

    @Test
    fun `a landed frame with the double still up, or the omnibox's content ramping in, fails the landing`() {
        val frames = opening(top, omniTop)
        val both = spoil(frames, frames.lastIndex) { it.with(double = double(omniTop, 1f)) }
        assertFalse(FakeboxMorph.landing(both).ok)
        val ramp = spoil(frames, frames.lastIndex) { it.with(omniField = OmniField(omniTop, 1f, 0.4f)) }
        val v = FakeboxMorph.landing(ramp)
        assertFalse(v.ok)
        assertTrue(v.detail, v.detail.contains("content is 0.40"))
    }

    @Test
    fun `a return with the bar still open on the first rest frame fails`() {
        val frames = closing(top, omniTop)
        val stuck = spoil(frames, frames.lastIndex) { it.copy(urlbarOpen = true) }
        assertFalse(FakeboxMorph.returned(stuck).ok)
    }

    @Test
    fun `a back committed after a pull comes home pulled on the bar's spring, and that is a return too`() {
        val frames = pulledHome(bottom, omniBottom)
        val back = FakeboxMorph.returned(frames)
        assertTrue(back.detail, back.ok)
        assertTrue(back.detail, back.detail.contains("pulled home"))
        val spring = FakeboxMorph.monotoneSpring(frames)
        assertTrue(spring.detail, spring.ok)
        assertTrue(spring.detail, spring.detail.contains("pulled-home"))
        assertTrue(FakeboxMorph.oneSurface(frames).detail, FakeboxMorph.oneSurface(frames).ok)
        // The value growing on the way home is the spring turning round.
        val turned = spoil(frames, 8) { it.with(morph = 0.6f) }
        assertFalse(FakeboxMorph.monotoneSpring(turned).ok)
        // The bar whole again for a frame between the field's coming home and the rest is not a return.
        val held = frames.toMutableList().apply {
            add(lastIndex, frame(get(lastIndex - 1).t + 16, "open", "open", 1f, bottom, omniBottom, omniField = OmniField(omniBottom, 1f, 1f), pageField = PageField(bottom.rest, 0f)))
        }
        assertFalse(FakeboxMorph.returned(held).ok)
        // A pull the finger holds without a rest after it is not a return.
        assertFalse(FakeboxMorph.returned(frames.dropLast(1)).ok)
    }

    @Test
    fun `a tap on the field on its way back turns it round without a seam`() {
        val back = closing(top, omniTop).dropLast(1).take(7)
        val m0 = back.last().morph
        val forward = springValues.map { m0 + (1 - m0) * it }.mapIndexed { i, m ->
            frame(200 + i * 16, "opening", "opening", m, top, omniTop, double = double(lerpBox(top.rest, omniTop, m), m), pageField = PageField(top.rest, 0f), omniField = OmniField(omniTop, 0f, 0f), pill = well)
        }
        val landed = frame(600, "open", "open", 1f, top, omniTop, omniField = OmniField(omniTop, 1f, 1f), pageField = PageField(top.rest, 0f))
        val frames = back + forward + landed
        assertTrue(FakeboxMorph.turnedRound(frames).detail, FakeboxMorph.turnedRound(frames).ok)
        assertTrue(FakeboxMorph.noJump(frames).ok)
        assertTrue(FakeboxMorph.monotoneSpring(frames).ok)
        assertFalse(FakeboxMorph.turnedRound(closing(top, omniTop)).ok)
    }

    // --- the half ------------------------------------------------------------------------------------

    @Test
    fun `the page field's words leave over the first half and the omnibox's arrive over the second`() {
        assertTrue(FakeboxMorph.wordsHandover(opening(top, omniTop)).ok)
        val both = spoil(opening(top, omniTop), 4) { it.with(double = it.double!!.copy(omniWords = 1f)) }
        val v = FakeboxMorph.wordsHandover(both)
        assertFalse(v.ok)
        val early = spoil(opening(top, omniTop), 3) { it.with(double = it.double!!.copy(fieldWords = 0f)) }
        assertFalse(FakeboxMorph.wordsHandover(early).ok)
    }

    // --- the scrub -----------------------------------------------------------------------------------

    @Test
    fun `a top dock scrub carries the double along the line to the slot and hands over to the pill`() {
        val frames = scrub(top, top.travel + 24f)
        assertTrue(FakeboxMorph.scrubOnTheLine(frames, top).detail, FakeboxMorph.scrubOnTheLine(frames, top).ok)
        assertTrue(FakeboxMorph.docked(frames, top).detail, FakeboxMorph.docked(frames, top).ok)
        assertTrue(FakeboxMorph.oneSurface(frames).detail, FakeboxMorph.oneSurface(frames).ok)
        val v = FakeboxMorph.noJump(frames, top)
        assertTrue(v.detail, v.ok)
        assertTrue(v.detail, v.detail.contains("under the finger"))
        // Without the geometry the finger's frames are left to the scrub's line.
        assertTrue(FakeboxMorph.noJump(frames).ok)
        // The double leaping ahead of the finger is a pop.
        val leap = spoil(frames, 6) { f -> f.with(double = f.double!!.copy(box = restBox(top, top.scrubOf(f.scroll) + 0.3f))) }
        val pop = FakeboxMorph.noJump(leap, top)
        assertFalse(pop.ok)
        assertTrue(pop.detail, pop.detail.contains("px of scroll"))
    }

    @Test
    fun `a top dock scrub whose pill fills in early, or whose double keeps its surface whole at the end, fails`() {
        val frames = scrub(top, top.travel * 0.9f)
        val early = spoil(frames, 4) { it.copy(pillSlot = Pill(top.slot, true, 0.5f)) }
        assertFalse(FakeboxMorph.scrubOnTheLine(early, top).ok)
        val whole = spoil(frames, frames.lastIndex) { it.with(double = it.double!!.copy(lookField = 1f)) }
        assertFalse(FakeboxMorph.scrubOnTheLine(whole, top).ok)
    }

    @Test
    fun `a bottom dock scrub rides the page's field out of the frame, fading as the pill fills in`() {
        val frames = scrub(bottom, bottom.travel + 24f)
        assertTrue(FakeboxMorph.ridesWithPage(frames, bottom).detail, FakeboxMorph.ridesWithPage(frames, bottom).ok)
        assertTrue(FakeboxMorph.docked(frames, bottom).ok)
        assertTrue(FakeboxMorph.oneSurface(frames).detail, FakeboxMorph.oneSurface(frames).ok)
        val doubled = spoil(frames, 5) { it.with(double = double(it.pageField!!.box, 0f)) }
        assertFalse(FakeboxMorph.ridesWithPage(doubled, bottom).ok)
        assertFalse(FakeboxMorph.scrubOnTheLine(frames, bottom).ok)
    }

    @Test
    fun `docked means the pill whole and nothing else drawn`() {
        val frames = scrub(top, top.travel + 12f)
        val still = spoil(frames, frames.lastIndex) { it.with(double = double(top.slot, 0f, pill = 1f, radius = 22f)) }
        assertTrue(FakeboxMorph.docked(frames, top).ok)
        assertTrue(FakeboxMorph.docked(still, top).ok) // a double covering nothing
        val drawn = spoil(frames, frames.lastIndex) { it.with(double = double(top.slot, 0f, pill = 0.5f, radius = 22f)) }
        assertFalse(FakeboxMorph.docked(drawn, top).ok)
        assertFalse(FakeboxMorph.docked(scrub(top, top.travel * 0.5f), top).ok)
    }

    // --- reduced motion ------------------------------------------------------------------------------

    private fun reducedOpening(content: List<Float>, m: Float = 1f): List<Frame> {
        val frames = ArrayList<Frame>()
        frames += frame(0, "rest", "", 0f, top, omniTop, pageField = PageField(top.rest, 1f), pill = well, urlbarOpen = false)
        content.forEachIndexed { i, c ->
            frames += frame(40 + i * 40, "opening", "opening", m, top, omniTop, pageField = PageField(top.rest, 1 - c), omniField = OmniField(omniTop, c, c), pill = well)
        }
        frames += frame(40 + content.size * 40, "open", "open", 1f, top, omniTop, omniField = OmniField(omniTop, 1f, 1f), pageField = PageField(top.rest, 0f))
        return frames
    }

    @Test
    fun `under reduced motion the value jumps and the omnibox fades in over more than one frame`() {
        val v = FakeboxMorph.reducedFade(reducedOpening(listOf(0.3f, 0.7f, 1f)))
        assertTrue(v.detail, v.ok)
        assertTrue(FakeboxMorph.oneSurface(reducedOpening(listOf(0.3f, 0.7f, 1f)), reduced = true).ok)
        val cut = FakeboxMorph.reducedFade(reducedOpening(listOf(0f, 0f, 1f)))
        assertFalse(cut.ok)
        assertTrue(cut.detail, cut.detail.contains("cut"))
        val travelled = FakeboxMorph.reducedFade(reducedOpening(listOf(0.3f, 0.7f, 1f), m = 0.5f))
        assertFalse(travelled.ok)
    }

    @Test
    fun `under reduced motion a scrubbed double holds its box while it fades`() {
        val box = restBox(top, 0.4f)
        val held = reducedOpening(listOf(0.3f, 0.7f, 1f)).map { f ->
            if (f.phase == "opening") f.with(double = double(box, 0f, layer = 1 - f.omniField!!.content), pageField = PageField(top.rest, 0f)) else f
        }
        assertTrue(FakeboxMorph.reducedFade(held).detail, FakeboxMorph.reducedFade(held).ok)
        val moved = held.mapIndexed { i, f -> if (f.phase == "opening" && i == 2) f.with(double = f.double!!.copy(box = box.copy(y = box.y - 30f))) else f }
        assertFalse(FakeboxMorph.reducedFade(moved).ok)
    }

    // --- reduced motion: no transition ----------------------------------------------------------------

    /** A reduced closing as the page draws it: hidden under the open omnibox, visible from the commit's first frame. */
    private fun reducedClosing(visibleFrom: Int = 1): List<Frame> {
        val frames = ArrayList<Frame>()
        frames += frame(0, "open", "open", 1f, top, omniTop, omniField = OmniField(omniTop, 1f, 1f), pageField = PageField(top.rest, 0f))
        listOf(1f, 0.6f, 0.2f).forEachIndexed { i, c ->
            frames += frame(40 + i * 40, "closing", "closing", 0f, top, omniTop, pageField = PageField(top.rest, 1 - c), omniField = OmniField(omniTop, c, c), pill = well)
        }
        frames += frame(160, "rest", "", 0f, top, omniTop, pageField = PageField(top.rest, 1f), pill = well, urlbarOpen = false)
        frames += frame(200, "rest", "", 0f, top, omniTop, pageField = PageField(top.rest, 1f), pill = well, urlbarOpen = false)
        return frames.mapIndexed { i, f -> f.copy(pageVisible = if (i == 0) false else i >= visibleFrom) }
    }

    @Test
    fun `the page is visible on the first frame after the commit and every frame after`() {
        val v = FakeboxMorph.pageShows(reducedClosing())
        assertTrue(v.detail, v.ok)
        assertTrue(v.detail, v.detail.contains("the commit at 40 ms (open -> closing): the page visible on its first frame"))
        // #243's run: the page still hidden for two frames past the commit (the shortened transition on visibility).
        val late = FakeboxMorph.pageShows(reducedClosing(visibleFrom = 3))
        assertFalse(late.detail, late.ok)
        assertTrue(late.detail, late.detail.contains("2 frame(s) with the page hidden off the omnibox; first: frame 1 (closing, 40 ms), visible again at 120 ms (80 ms hidden)"))
        assertTrue(late.detail, late.detail.contains("HIDDEN on its first frame"))
        // The page hidden under the open omnibox is the design.
        assertTrue(FakeboxMorph.pageShows(reducedClosing().map { if (it.phase == "open") it.copy(pageVisible = false) else it }).ok)
        // An older sampler carried no flag: not judged.
        val bare = FakeboxMorph.pageShows(reducedClosing().map { it.copy(pageVisible = null) })
        assertTrue(bare.ok)
        assertFalse(bare.judged)
    }

    @Test
    fun `steady geometry holds every drawn box frame to frame, the keyboard's inset excused, the frame unscaled`() {
        val frames = reducedOpening(listOf(0.3f, 0.7f, 1f))
        val v = FakeboxMorph.steadyGeometry(frames)
        assertTrue(v.detail, v.ok)
        assertTrue(v.detail, v.detail.contains("the content frame at scale 1 on every frame"))
        // The omnibox's field drawn 30 px higher for one frame with nothing else changed: a stale frame.
        val stale = spoil(frames, 2) { it.with(omniField = OmniField(omniTop.copy(y = omniTop.y + 30f), it.omniField!!.backdrop, it.omniField.content)) }
        val caught = FakeboxMorph.steadyGeometry(stale)
        assertFalse(caught.detail, caught.ok)
        assertTrue(caught.detail, caught.detail.contains("the omnibox's field drawn at"))
        assertTrue(caught.detail, caught.detail.contains("with the keyboard's inset unchanged"))
        // The same move on the frame the keyboard's inset changed is the target's ride, not a fault.
        val keyboard = stale.mapIndexed { i, f -> if (i >= 2) f.copy(insetBottom = 300f) else f }
        val excused = FakeboxMorph.steadyGeometry(keyboard)
        assertTrue(excused.detail, excused.ok)
        assertTrue(excused.detail, excused.detail.contains("moved with the keyboard's inset"))
        // The page receding under reduced motion (the gain not 0) is a fault.
        val receded = FakeboxMorph.steadyGeometry(spoil(frames, 3) { it.copy(frameScale = 0.97f) })
        assertFalse(receded.detail, receded.ok)
        assertTrue(receded.detail, receded.detail.contains("the page recedes under reduced motion"))
    }

    private fun declared(tp: String, td: String, an: String = "none", ad: String = "0s") = FakeboxMorph.Declared(
        transitionProperties = tp.split(",").map { it.trim() },
        transitionMs = FakeboxMorph.parseTimes(td),
        animationNames = an.split(",").map { it.trim() },
        animationMs = FakeboxMorph.parseTimes(ad)
    )

    @Test
    fun `the declarations leave nothing shortened and keep only the opacity fades at 120 ms`() {
        val kept = mapOf(
            "fades" to declared("opacity", "0.12s"),
            "omnibox" to declared("none", "0s", an = "zen-fade", ad = "0.12s"),
            "page" to declared("none", "0.2s"),
            "frame" to declared("none", "0s")
        )
        val frames = reducedOpening(listOf(0.3f, 0.7f, 1f)).map { it.copy(declared = kept) }
        val v = FakeboxMorph.declaredFades(frames)
        assertTrue(v.detail, v.ok)
        assertTrue(v.detail, v.detail.contains("4 element(s)"))
        assertTrue(v.detail, v.detail.contains("fades: transition opacity 120.0 ms"))
        assertTrue(v.detail, v.detail.contains("omnibox: animation zen-fade 120.0 ms"))
        // The old rule: every duration 0.01 ms (`1e-05s` as the computed style serialises it).
        val old = FakeboxMorph.declaredFades(frames.map { it.copy(declared = mapOf("page" to declared("all", "1e-05s", an = "none", ad = "1e-05s"))) })
        assertFalse(old.detail, old.ok)
        assertTrue(old.detail, old.detail.contains("shortened, not removed"))
        // A transition that still names transform, an animation that is not a fade, a fade at the wrong length.
        assertTrue(FakeboxMorph.declaredFades(frames.map { it.copy(declared = mapOf("column" to declared("transform, opacity", "0.12s, 0.12s"))) }).detail.contains("transitions transform, opacity"))
        assertTrue(FakeboxMorph.declaredFades(frames.map { it.copy(declared = mapOf("bar" to declared("none", "0s", an = "zen-pop", ad = "0.12s"))) }).detail.contains("animates zen-pop"))
        assertFalse(FakeboxMorph.declaredFades(frames.map { it.copy(declared = mapOf("fades" to declared("opacity", "0.2s"))) }).ok)
        // The sheet's declaration rides with its layer.
        val sheet = FakeboxMorph.SheetLayer(Box(0f, 500f, 411f, 300f), 1f, 0f, 1f, 0.4f, declared("opacity", "0.12s"), 0)
        val withSheet = FakeboxMorph.declaredFades(frames.map { it.copy(declared = emptyMap(), sheet = sheet) })
        assertTrue(withSheet.detail, withSheet.ok)
        assertTrue(withSheet.detail, withSheet.detail.contains("sheet: transition opacity 120.0 ms"))
        // Nothing carried: not judged.
        val bare = FakeboxMorph.declaredFades(frames.map { it.copy(declared = emptyMap()) })
        assertTrue(bare.ok)
        assertFalse(bare.judged)
    }

    private val sheetBox = Box(0f, 520f, 411f, 300f)

    private fun sheetFrame(t: Int, opacity: Float?, box: Box = sheetBox, translateY: Float = 0f, scale: Float = 1f, pending: Int = 0): Frame =
        frame(t, "rest", "", 0f, bottom, omniBottom, pageField = PageField(bottom.rest, 1f), pill = well, urlbarOpen = false).copy(
            pageVisible = true,
            sheet = opacity?.let { FakeboxMorph.SheetLayer(box, it, translateY, scale, it * 0.4f, declared("opacity", "0.12s"), pending) }
        )

    /** The menu sheet under reduced motion: mounted held at 0, the spring's jump, the 120 ms fade in. */
    private fun sheetOpening(opacities: List<Float> = listOf(0.3f, 0.7f, 1f, 1f), pending: Int = 0): List<Frame> {
        val frames = ArrayList<Frame>()
        frames += sheetFrame(0, null)
        frames += sheetFrame(40, 0f)
        opacities.forEachIndexed { i, o -> frames += sheetFrame(80 + i * 40, o, pending = pending) }
        return frames
    }

    /** Its departure: the fade out, then the jump off and the unmount. */
    private fun sheetClosing(opacities: List<Float> = listOf(1f, 0.6f, 0.2f)): List<Frame> {
        val frames = ArrayList<Frame>()
        opacities.forEachIndexed { i, o -> frames += sheetFrame(i * 40, o) }
        frames += sheetFrame(opacities.size * 40, null)
        frames += sheetFrame(opacities.size * 40 + 40, null)
        return frames
    }

    @Test
    fun `the sheet stands where the spring jumped it on every drawn frame`() {
        val v = FakeboxMorph.sheetInPlace(sheetOpening())
        assertTrue(v.detail, v.ok)
        assertTrue(v.detail, v.detail.contains("4 drawn frame(s)"))
        // A frame drawn at the pose before the jump (the sheet still low) is the stale frame.
        val stale = FakeboxMorph.sheetInPlace(spoil(sheetOpening(), 2) { it.copy(sheet = it.sheet!!.copy(box = sheetBox.copy(y = sheetBox.y + 120f), translateY = 120f)) })
        assertFalse(stale.detail, stale.ok)
        assertTrue(stale.detail, stale.detail.contains("its first drawn frame had"))
        // A sheet receded (scaled) under reduced motion is a fault; one never drawn is a fault.
        assertFalse(FakeboxMorph.sheetInPlace(spoil(sheetOpening(), 3) { it.copy(sheet = it.sheet!!.copy(scale = 0.97f)) }).ok)
        assertFalse(FakeboxMorph.sheetInPlace(sheetOpening(listOf(0f, 0f))).ok)
        assertTrue(FakeboxMorph.steadyGeometry(sheetOpening()).ok)
        assertFalse(FakeboxMorph.steadyGeometry(spoil(sheetOpening(), 3) { it.copy(sheet = it.sheet!!.copy(box = sheetBox.copy(h = 340f))) }).ok)
    }

    @Test
    fun `the sheet fades in and out over more than one frame within the window`() {
        val fadeIn = FakeboxMorph.sheetFade(sheetOpening(), opening = true)
        assertTrue(fadeIn.detail, fadeIn.ok)
        assertTrue(fadeIn.judged)
        assertTrue(fadeIn.detail, fadeIn.detail.contains("faded in to 1.00 over 2 part-way frame(s)"))
        val fadeOut = FakeboxMorph.sheetFade(sheetClosing(), opening = false)
        assertTrue(fadeOut.detail, fadeOut.ok)
        assertTrue(fadeOut.detail, fadeOut.detail.contains("faded out and left the DOM"))
        // A cut 0 -> 1 between two frames 40 ms apart: no fade.
        val cut = FakeboxMorph.sheetFade(sheetOpening(listOf(1f, 1f)), opening = true)
        assertFalse(cut.detail, cut.ok)
        assertTrue(cut.detail, cut.detail.contains("cut 0 -> 1"))
        // The same step across a gap wider than the fade, or with the fade pending on the compositor: not judged.
        val wide = FakeboxMorph.sheetFade(sheetOpening(listOf(1f, 1f)).map { if (it.t >= 80) it.copy(t = it.t + 200) else it }, opening = true)
        assertTrue(wide.detail, wide.ok)
        assertFalse(wide.judged)
        val pending = FakeboxMorph.sheetFade(sheetOpening(listOf(1f, 1f), pending = 2), opening = true)
        assertTrue(pending.detail, pending.ok)
        assertFalse(pending.judged)
        assertTrue(pending.detail, pending.detail.contains("pending on the compositor"))
        // A fade that runs the wrong way, one that never arrives, one that overstays the window.
        assertFalse(FakeboxMorph.sheetFade(sheetOpening(listOf(0.7f, 0.3f, 1f, 1f)), opening = true).ok)
        assertFalse(FakeboxMorph.sheetFade(sheetOpening(listOf(0.3f, 0.7f, 0.8f)), opening = true).ok)
        val slow = FakeboxMorph.sheetFade(sheetOpening(listOf(0.1f, 0.3f, 0.5f, 0.7f, 0.9f, 1f)).mapIndexed { i, f -> if (i >= 2) f.copy(t = f.t + i * 150) else f }, opening = true)
        assertFalse(slow.detail, slow.ok)
        assertTrue(slow.detail, slow.detail.contains("expected"))
        // A closing that leaves the sheet in the DOM at 1 never faded.
        assertFalse(FakeboxMorph.sheetFade(listOf(sheetFrame(0, 1f), sheetFrame(40, 1f), sheetFrame(400, 1f)), opening = false).ok)
    }

    // --- the bar's hide, the end state, the wire ----------------------------------------------------

    @Test
    fun `the bar's hide stays gated off on the new tab page`() {
        val frames = scrub(top, top.travel)
        assertTrue(FakeboxMorph.barStays(frames).ok)
        assertFalse(FakeboxMorph.barStays(spoil(frames, 3) { it.copy(barHideAllowed = true) }).ok)
        assertFalse(FakeboxMorph.barStays(spoil(frames, 3) { it.copy(barHide = 0.4f) }).ok)
    }

    @Test
    fun `a sequence resolves to one state`() {
        val landed = opening(top, omniTop).last()
        assertTrue(FakeboxMorph.resolved(landed, "open", urlbarOpen = true).ok)
        assertFalse(FakeboxMorph.resolved(landed, "", urlbarOpen = false).ok)
        val rest = closing(top, omniTop).last()
        assertTrue(FakeboxMorph.resolved(rest, "", urlbarOpen = false).ok)
        val twice = rest.with(double = double(top.rest, 0f))
        assertFalse(FakeboxMorph.resolved(twice, "", urlbarOpen = false).ok)
    }

    @Test
    fun `a field the scroll holds part way resolves to the double at a top dock and to the page's field at a bottom one`() {
        val heldTop = scrub(top, top.travel * 0.5f).last()
        assertTrue(heldTop.doubleDrawn)
        val v = FakeboxMorph.resolved(heldTop, "scrub", urlbarOpen = false)
        assertTrue(v.detail, v.ok)
        assertTrue(v.detail, v.detail.contains("scrubbed part way"))
        // The same double asked to be at rest is one too many.
        assertFalse(FakeboxMorph.resolved(heldTop, "", urlbarOpen = false).ok)
        // At a bottom dock the page's field rides: a double beside it is two.
        val heldBottom = scrub(bottom, bottom.travel * 0.5f).last()
        assertTrue(FakeboxMorph.resolved(heldBottom, "scrub", urlbarOpen = false).ok)
        assertFalse(FakeboxMorph.resolved(heldBottom.with(double = double(heldBottom.pageField!!.box, 0f)), "scrub", urlbarOpen = false).ok)
    }

    @Test
    fun `a fade the compositor had not started is not judged rather than failed`() {
        // The sampler saw the omnibox's content whole, then gone, with the fade pending on every segment frame.
        val cut = reducedOpening(listOf(0f, 0f, 1f))
        val pending = cut.map { if (it.phase == "opening") it.copy(pending = 1) else it }
        val v = FakeboxMorph.reducedFade(pending)
        assertTrue(v.detail, v.ok)
        assertFalse(v.judged)
        assertTrue(v.toString(), v.toString().endsWith("NOT JUDGED"))
        assertTrue(v.detail, v.detail.contains("pending on the compositor"))
        // The same rows without the pending are the cut they look like.
        assertFalse(FakeboxMorph.reducedFade(cut).ok)
        // A fade the compositor did draw is judged, pending or not, and one surface excuses the pending frames
        // and the frames within one fade of them (the rest frame 40 ms before the first, the open frame 40 ms after the last).
        val drawn = reducedOpening(listOf(0.3f, 0.7f, 1f)).map { if (it.phase == "opening") it.copy(pending = 1) else it }
        assertTrue(FakeboxMorph.reducedFade(drawn).judged)
        val one = FakeboxMorph.oneSurface(drawn, reduced = true)
        assertTrue(one.detail, one.ok)
        assertTrue(one.detail, one.detail.contains("5 frame(s) not judged"))
        // A double still travelling under a pending fade is the chrome's fault, judged and failed.
        val travelled = FakeboxMorph.reducedFade(reducedOpening(listOf(0f, 0f, 1f), m = 0.5f).map { if (it.phase == "opening") it.copy(pending = 1) else it })
        assertFalse(travelled.ok)
        assertTrue(travelled.judged)
    }

    @Test
    fun `a rest frame with nothing pending, within one fade of a frame with something pending, is the compositor's too`() {
        // Run 3's reduced-bottom closing on the emulator: the value jumped at 2716 ms with 17 fades pending; at rest 300 ms
        // later the page was still at 0 with three pending, 16 ms after that at 0 with none (the compositor had taken the
        // fade's start time and drawn nothing yet), 150 ms after that at 0 with two pending, and back at 1 by 3682 ms.
        val home = PageField(top.rest, 1f)
        val gone = PageField(top.rest, 0f)
        val restAt = { t: Int, page: PageField, pending: Int -> frame(t, "rest", "", 0f, top, omniTop, pageField = page, pill = well, urlbarOpen = false).copy(pending = pending) }
        val frames = listOf(
            frame(2716, "closing", "closing", 0f, top, omniTop, pageField = gone, omniField = OmniField(omniTop, 1f, 1f), pill = well).copy(pending = 17),
            restAt(3016, gone, 3),
            restAt(3032, gone, 0),
            restAt(3182, gone, 2),
            restAt(3682, home, 7),
            restAt(3966, home, 0),
            restAt(4449, home, 0)
        )
        val one = FakeboxMorph.oneSurface(frames, reduced = true)
        assertTrue(one.detail, one.ok)
        assertTrue(one.detail, one.detail.contains("5 frame(s) not judged"))
        assertTrue(FakeboxMorph.pendingNear(frames, 2))
        // The same page still gone a fade's length and more after the last pending frame is the chrome's, and failed.
        val stuck = frames.map { if (it.t >= 3682) it.copy(pageField = gone, pending = 0) else it }
        val failed = FakeboxMorph.oneSurface(stuck, reduced = true)
        assertFalse(failed.detail, failed.ok)
        assertTrue(failed.detail, failed.detail.contains("3 frame(s) draw it twice or not at all; first: frame 4 (rest, scroll 0.0)"))
        assertFalse(FakeboxMorph.pendingNear(stuck, 4))
        // Nothing pending anywhere: every frame is judged, and a frame drawing nothing fails.
        val bare = frames.map { it.copy(pending = 0) }
        assertFalse(FakeboxMorph.oneSurface(bare, reduced = true).ok)
    }

    @Test
    fun `a segment that fell whole between two frames wider apart than the fade is not judged`() {
        // Run 2's reduced-bottom closing: `open` on one frame, `rest` 416 ms later on the next, the 120 ms hold between them.
        val openFrame = frame(1674, "open", "open", 1f, top, omniTop, omniField = OmniField(omniTop, 1f, 1f), pageField = PageField(top.rest, 0f))
        val restFrame = frame(2090, "rest", "", 0f, top, omniTop, pageField = PageField(top.rest, 1f), pill = well, urlbarOpen = false)
        val between = FakeboxMorph.reducedFade(listOf(openFrame, restFrame))
        assertTrue(between.detail, between.ok)
        assertFalse(between.judged)
        assertTrue(between.detail, between.detail.contains("the closing fell between two frames 416 ms apart"))
        // The same jump inside a gap narrower than the hold is a hold cut short: failed.
        val narrow = FakeboxMorph.reducedFade(listOf(openFrame, restFrame.copy(t = 1674 + 80)))
        assertFalse(narrow.ok)
        assertTrue(narrow.judged)
        assertTrue(narrow.detail, narrow.detail.contains("less than the 120 ms hold"))
        // No change of rest at all is still 'no segment was sampled'.
        assertFalse(FakeboxMorph.reducedFade(listOf(openFrame, openFrame.copy(t = 2090))).ok)
    }

    @Test
    fun `a single segment frame in a gap wider than the fade is not judged, in a narrower one it is a failure`() {
        val sparse = reducedOpening(listOf(0f))
        // Rest at 0, the one opening frame at 40, open at 80: an 80 ms gap, the fade would have shown.
        val narrow = FakeboxMorph.reducedFade(sparse)
        assertFalse(narrow.ok)
        assertTrue(narrow.detail, narrow.detail.contains("sampled on 1 frame(s)"))
        // The landing sampled 200 ms on: the fade fits in the gap unseen.
        val wide = FakeboxMorph.reducedFade(sparse.mapIndexed { i, f -> if (i == sparse.lastIndex) f.copy(t = 200) else f })
        assertTrue(wide.detail, wide.ok)
        assertFalse(wide.judged)
        assertTrue(wide.detail, wide.detail.contains("wider than the fade"))
    }

    @Test
    fun `a frame parses from the sampler's row`() {
        val row = JSONObject(
            """{"t":48,"ph":"opening","lk":"opening","m":0.41,"p":0,"sc":0,"uo":true,"ib":0,"ba":false,"bh":0,"pa":2,
               "d":{"b":{"x":37.1,"y":191.8,"w":336.8,"h":46.4},"r":16.1,"l":1,"lf":1,"lo":0.82,"fw":0.18,"ow":0,"mv":true},
               "pf":{"b":{"x":24,"y":300,"w":363,"h":48},"o":0},
               "of":{"b":{"x":56,"y":36,"w":299,"h":44},"bd":0,"ct":0},
               "pl":{"b":{"x":56,"y":36,"w":243,"h":44},"aw":true,"w":0},
               "bar":0.18,"sh":0.02,"pg":0.32}"""
        )
        val f = FakeboxMorph.parse(row)
        assertEquals(48, f.t)
        assertEquals("opening", f.phase)
        assertEquals(0.41f, f.morph, 1e-4f)
        assertTrue(f.urlbarOpen)
        assertEquals(Box(37.1f, 191.8f, 336.8f, 46.4f), f.double!!.box)
        assertEquals(16.1f, f.double!!.radius, 1e-4f)
        assertTrue(f.double!!.moving)
        assertEquals(0f, f.pageField!!.opacity, 1e-4f)
        assertEquals(0f, f.omniField!!.drawn, 1e-4f)
        assertTrue(f.pillSlot!!.away)
        assertEquals(0.18f, f.bar, 1e-4f)
        assertFalse(f.barHideAllowed)
        assertTrue(f.inFlight)
        assertTrue(f.doubleDrawn)
        assertEquals(2, f.pending)
        assertFalse(f.pulled)
        val bare = FakeboxMorph.parse(JSONObject("""{"t":0,"ph":"rest","lk":"","m":0,"p":0,"sc":0,"uo":false,"ib":0}"""))
        assertEquals(-1f, bare.bar, 1e-4f)
        assertEquals(null, bare.double)
        assertEquals(null, bare.drawnBox)
        assertEquals(0, bare.pending)
        val pulled = FakeboxMorph.parse(JSONObject("""{"t":0,"ph":"open","lk":"pulled","m":0.6,"p":0,"sc":0,"uo":true,"ib":0}"""))
        assertTrue(pulled.pulled)
        assertTrue(pulled.inFlight)
        assertEquals(null, bare.pageVisible)
        assertEquals(1f, bare.frameScale, 1e-4f)
        assertTrue(bare.declared.isEmpty())
        assertEquals(null, bare.sheet)
    }

    @Test
    fun `the reduced-motion keys parse from the sampler's row`() {
        val row = JSONObject(
            """{"t":120,"ph":"rest","lk":"","m":0,"p":0,"sc":0,"uo":false,"ib":0,"pv":true,"cf":0.97,
               "dc":{"fades":{"tp":"opacity","td":"0.12s","an":"none","ad":"0s"},
                     "page":{"tp":"none","td":"1e-05s","an":"none","ad":"1e-05s"},
                     "omnibox":{"tp":"none","td":"0s","an":"zen-fade, zen-fade-out","ad":"0.12s, 0.12s"}},
               "sl":{"b":{"x":0,"y":520.5,"w":411,"h":300},"o":0.42,"y":0,"s":1,"so":0.17,
                     "dc":{"tp":"opacity","td":"0.12s","an":"none","ad":"0s"},"pa":1}}"""
        )
        val f = FakeboxMorph.parse(row)
        assertEquals(true, f.pageVisible)
        assertEquals(0.97f, f.frameScale, 1e-4f)
        val fades = f.declared.getValue("fades")
        assertTrue(fades.transitions)
        assertFalse(fades.animates)
        assertEquals(listOf("opacity"), fades.transitionProperties)
        assertEquals(120f, fades.transitionMs.single(), 1e-3f)
        val page = f.declared.getValue("page")
        assertFalse(page.transitions)
        assertEquals(0.01f, page.transitionMs.single(), 1e-5f)
        assertEquals(0.01f, page.animationMs.single(), 1e-5f)
        val omnibox = f.declared.getValue("omnibox")
        assertTrue(omnibox.animates)
        assertEquals(listOf("zen-fade", "zen-fade-out"), omnibox.animationNames)
        assertEquals(listOf(120f, 120f), omnibox.animationMs)
        val sheet = f.sheet!!
        assertEquals(Box(0f, 520.5f, 411f, 300f), sheet.box)
        assertEquals(0.42f, sheet.opacity, 1e-4f)
        assertTrue(sheet.drawn)
        assertEquals(0.17f, sheet.scrim, 1e-4f)
        assertEquals(1, sheet.pending)
        assertTrue(sheet.declared!!.transitions)
        assertEquals(listOf(0f, 120f), FakeboxMorph.parseTimes("0s, 0.12s"))
        assertEquals(listOf(40f), FakeboxMorph.parseTimes("40ms"))
        val hidden = FakeboxMorph.parse(JSONObject("""{"t":0,"ph":"open","lk":"open","m":1,"p":0,"sc":0,"uo":true,"ib":0,"pv":false}"""))
        assertEquals(false, hidden.pageVisible)
        val noPage = FakeboxMorph.parse(JSONObject("""{"t":0,"ph":"rest","lk":"","m":0,"p":0,"sc":0,"uo":false,"ib":0,"pv":null}"""))
        assertEquals(null, noPage.pageVisible)
    }
}

package app.zen.chromium

import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * The frame judge behind `FakeboxMorphDemo` (the new tab page's field becoming the omnibox,
 * NTP-02 / MOT-08, design language v2 §11.8), kept free of Android so it runs on the JVM
 * (`FakeboxMorphJudgeTest`) and on the device alike (`src/sharedTest`, like [UrlFieldClose]).
 * The driver samples the chrome once per animation frame – the machine's phase, the two values
 * on the root (`--zen-ntp-morph`, `--zen-ntp-pill`), the page's scroll, and where and how
 * opaque every incarnation of the field is drawn: the page's own field, the double the layer
 * paints, the omnibox's field and the pill's slot – and hands the frames here. Every check is a
 * [Verdict] with the numbers that decided it, one line of the findings file.
 *
 * What the checks hold the frames to (the coordinator's criteria for the run, and §11.8's text):
 *
 *  - ONE SURFACE: no frame draws the field twice – while a segment runs the double is the only
 *    field (the page's own hidden, the omnibox's content blank until the landing); under the
 *    scroll the field's incarnations cross-fade (the double or the riding field out, the pill's
 *    words in) so that their opacities always sum to one; landed, the omnibox's field alone.
 *  - NO POP: between two frames the value moves by at most the spring's largest step
 *    ([MAX_STEP], the closed-form spring over its 64 ms clamp with a reversal's carried velocity)
 *    and the field drawn – whichever incarnation – by at most that share of the segment's
 *    distance: a field that is at the page one frame and in the bar the next has popped.
 *  - THE LINE: on every frame of a segment the double's box is the straight interpolation of
 *    the page's pose and the omnibox field's box on that frame at the value (`lerpRect`, edge by
 *    edge, §11.8): every segment – a tap from rest or from a scrubbed pose, a dismissal from open
 *    or mid-flight, the back gesture's pull – runs on that one line, and the target may move
 *    under it (the keyboard's inset at a bottom dock): the box follows the line to the new
 *    target within a frame, never a line of its own.
 *  - MONOTONE: the value never turns round on its own – opening it only grows, closing it only
 *    shrinks (the spring's damping is 0.98: no visible overshoot) – and under a steady finger the
 *    scrub's every edge moves one way, one to one with the finger at a bottom dock.
 *  - THE LANDING: the omnibox's own field takes over on the frame the double goes – no frame
 *    with both, none with neither – at the box the double's line was heading for.
 *  - THE HALF: the double's page-field words leave over the first half of the value and its
 *    omnibox-field words arrive over the second (`1 - 2m` and `2m - 1`), never both whole.
 *  - THE HANDOVER: over the scrub's last three tenths the field fades out as the pill's words
 *    fade in (`pillLook`), and docked the pill is whole and nothing else draws.
 *  - REDUCED: under reduced motion (§11.3) nothing travels – the value jumps, the double (where
 *    one is drawn at all) holds its box – and the omnibox arrives and leaves on a fade of about
 *    120 ms, over more than one frame.
 *  - THE BAR STAYS: the bar's hide-on-scroll (#200, §11.5) is gated off on the new tab page, so
 *    the two scroll-driven motions never meet: its gate is closed and its value 0 on every frame.
 */
object FakeboxMorph {
    /** A box in CSS px, as `getBoundingClientRect` reports it. */
    data class Box(val x: Float, val y: Float, val w: Float, val h: Float) {
        val cx: Float get() = x + w / 2
        val cy: Float get() = y + h / 2
        val bottom: Float get() = y + h

        fun near(o: Box, tolerance: Float): Boolean =
            abs(x - o.x) <= tolerance && abs(y - o.y) <= tolerance && abs(w - o.w) <= tolerance && abs(h - o.h) <= tolerance

        /** How far a surface travels between two boxes: the centres' distance plus half the change of size (`segmentDistance`). */
        fun distance(o: Box): Float = hypot(o.cx - cx, o.cy - cy) + abs(o.w - w) / 2 + abs(o.h - h) / 2

        override fun toString(): String = "(${x.f()}, ${y.f()} ${w.f()}x${h.f()})"
    }

    /** The double the layer paints, as one frame draws it. */
    data class Double(
        val box: Box,
        /** Its corner radius (CSS px): 12 at rest, 22 at the pill's and the omnibox field's. */
        val radius: Float,
        /** The layer's own opacity times the box's: 1 but for reduced motion's fade in place. */
        val layer: Float,
        /** The field's look (`.zen-fakebox-look-field`) and the omnibox field's (`-omni`), stacked. */
        val lookField: Float,
        val lookOmni: Float,
        /** The page field's words (glyph and placeholder) and the omnibox field's (chip and placeholder), relative to the box. */
        val fieldWords: Float,
        val omniWords: Float,
        /** `data-moving`: `will-change` is on. */
        val moving: Boolean
    ) {
        /** How much of a field the double shows: its two looks stacked, under the layer's fade. */
        val coverage: Float get() = layer * (1f - (1f - lookField) * (1f - lookOmni))
    }

    /** The page's own field: its box and its opacity (0 while `data-away` hides it; the page's fade folded in). */
    data class PageField(val box: Box, val opacity: Float)

    /** The omnibox's field: its box, its backdrop's opacity (`::before`) and its content's. */
    data class OmniField(val box: Box, val backdrop: Float, val content: Float) {
        val drawn: Float get() = max(backdrop, content)
    }

    /** The bar's pill: its box, whether it is the well (`.zen-pill-away`) and how opaque its words are (1 when it is the pill). */
    data class Pill(val box: Box, val away: Boolean, val words: Float)

    /** One animation frame of the chrome, `t` ms after the sampling began. */
    data class Frame(
        val t: Int,
        /** The machine's phase: rest, opening, open, closing. */
        val phase: String,
        /** The root's `data-fakebox`: "" at rest unscrolled, else scrub, docked, opening, open, pulled, closing. */
        val look: String,
        /** `--zen-ntp-morph` on the root: 0 the page's field, 1 the omnibox's. */
        val morph: Float,
        /** `--zen-ntp-pill` on the root: the handover to the pill's slot. */
        val pill: Float,
        /** The page's scroll offset (CSS px). */
        val scroll: Float,
        /** `uiStore.urlbar.open`. */
        val urlbarOpen: Boolean,
        /** `--zen-inset-bottom` (CSS px): the keyboard's arrival moves a bottom dock's target. */
        val insetBottom: Float,
        val double: Double?,
        val pageField: PageField?,
        val omniField: OmniField?,
        val pillSlot: Pill?,
        /** The bar's, the omnibox sheet's and the page's (`.zen-ntp-fades`) opacities; -1 when not in the DOM. */
        val bar: Float,
        val sheet: Float,
        val page: Float,
        /** The bar's hide-on-scroll: its gate (`barMayHide`) and its value (`--zen-bar-hide`). */
        val barHideAllowed: Boolean = false,
        val barHide: Float = 0f,
        /**
         * How many of the fades' animations and transitions (the omnibox's field and sheet, the
         * double's layer, the page, the bar) had not started by this frame – `Animation.pending`:
         * their start time waits on the compositor's next frame, which the emulator's software GPU
         * takes hundreds of ms over (gfxinfo: a 600 ms median frame), so a 120 ms fade can be over
         * before it is ever drawn. A frame with one pending is the emulator's, not the chrome's.
         */
        val pending: Int = 0
    ) {
        val doubleDrawn: Boolean get() = (double?.coverage ?: 0f) > EPS
        val pageFieldDrawn: Boolean get() = (pageField?.opacity ?: 0f) > EPS
        val omniDrawn: Boolean get() = (omniField?.drawn ?: 0f) > EPS
        val inFlight: Boolean get() = phase == "opening" || phase == "closing" || look == "pulled"
        /** The finger's (or the back's spring's) pull on the landed omnibox, not a segment of the morph's own. */
        val pulled: Boolean get() = phase == "open" && look == "pulled"

        /** Where the field is drawn on this frame, whichever incarnation draws it; null when none does. */
        val drawnBox: Box?
            get() = when {
                doubleDrawn -> double!!.box
                omniDrawn && phase == "open" -> omniField!!.box
                pageFieldDrawn -> pageField!!.box
                look == "docked" -> pillSlot?.box
                else -> null
            }
    }

    /** The page's geometry with the page unscrolled: the field's natural box, the pill's slot and the frame's top edge, all CSS px. */
    data class Geometry(val rest: Box, val slot: Box, val frameTop: Float) {
        /** The scroll offset at which the field has left the frame and is docked (`scrubTravel`). */
        val travel: Float get() = max(1f, rest.bottom - frameTop)
        /** A bottom dock: the slot is under the frame's top edge (`dockBelow`). */
        val dockBelow: Boolean get() = slot.cy > frameTop
        fun scrubOf(scroll: Float): Float = clamp01(scroll / travel)
    }

    /**
     * One check's outcome, one line of the findings. `judged` false: the frames could not carry
     * the check (the emulator's compositor never drew the fade the check is about) – the line says
     * NOT JUDGED, and `ok` is true so the run does not fail on the emulator's account.
     */
    data class Verdict(val check: String, val ok: Boolean, val detail: String, val judged: Boolean = true) {
        override fun toString(): String = "$check: $detail ${if (!judged) "NOT JUDGED" else if (ok) "PASS" else "FAIL"}"
    }

    /** An opacity under this is not drawn (computed styles round; a fade's tail). */
    const val EPS = 0.02f

    /**
     * The spring's largest step in one frame, as a share of the segment: `SPRING_SNAPPY`
     * (420 / 40, damping 0.98) over the 64 ms its tick is clamped to covers 0.38 of the way from
     * rest and 0.43 with the velocity a reversal carries against the new direction
     * (`lib/motion/spring.ts`, `fakeboxMorph.ts`: `startSegment(-caught.v)`). A frame that moves
     * the value further did not come from the spring.
     */
    const val MAX_STEP = 0.5f

    /** The scrub's last stretch, over which the field hands over to the pill (`FAKEBOX_PILL_LOOK_FROM`). */
    const val PILL_LOOK_FROM = 0.7f

    /** The field's corner radius at rest and at the pill's / the omnibox field's (§9.29, the 44 px pill). */
    const val REST_RADIUS = 12f
    const val DOCK_RADIUS = 22f

    /** Reduced motion's fade (§11.3), and the widest window one may take on the emulator's frame clock. */
    const val REDUCED_FADE_MS = 120
    const val REDUCED_FADE_MAX_MS = 600

    /** How far off the line a box may be drawn (CSS px): rounding of the interpolation and of the rect. */
    const val LINE_TOLERANCE = 2.5f

    fun clamp01(v: Float): Float = max(0f, min(1f, v))
    fun lerp(a: Float, b: Float, t: Float): Float = a + (b - a) * t
    fun lerpBox(a: Box, b: Box, t: Float): Box = Box(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.w, b.w, t), lerp(a.h, b.h, t))

    /** How far the field has handed over to the pill at `scrub` (`pillLook`). */
    fun pillLook(scrub: Float): Float = clamp01((scrub - PILL_LOOK_FROM) / (1 - PILL_LOOK_FROM))

    /** The page's pose at `scrub`: toward the slot at a top dock; riding up, unchanged, at a bottom dock (`restPose`). */
    fun restBox(g: Geometry, scrub: Float): Box {
        val s = clamp01(scrub)
        return if (g.dockBelow) g.rest.copy(y = g.rest.y - s * g.travel) else lerpBox(g.rest, g.slot, s)
    }

    /** The field's corner radius at `scrub`: rounding to the pill's at a top dock, the field's own at a bottom one (`restPose`). */
    fun restRadius(g: Geometry, scrub: Float): Float =
        if (g.dockBelow) REST_RADIUS else lerp(REST_RADIUS, DOCK_RADIUS, clamp01(scrub))

    // --- the wire ------------------------------------------------------------------------------

    /**
     * One frame as the chrome-side sampler writes it (`FakeboxMorphDemoBase.SAMPLER`): compact
     * keys, boxes as `{x, y, w, h}`, the incarnations null when not in the DOM.
     */
    fun parse(row: JSONObject): Frame {
        fun box(o: JSONObject): Box = Box(o.optDouble("x").toFloat(), o.optDouble("y").toFloat(), o.optDouble("w").toFloat(), o.optDouble("h").toFloat())
        fun num(o: JSONObject, key: String): Float = o.optDouble(key, 0.0).toFloat()
        val d = row.optJSONObject("d")
        val pf = row.optJSONObject("pf")
        val of = row.optJSONObject("of")
        val pl = row.optJSONObject("pl")
        return Frame(
            t = row.optInt("t"),
            phase = row.optString("ph"),
            look = row.optString("lk"),
            morph = num(row, "m"),
            pill = num(row, "p"),
            scroll = num(row, "sc"),
            urlbarOpen = row.optBoolean("uo"),
            insetBottom = num(row, "ib"),
            double = d?.let {
                Double(
                    box(it.getJSONObject("b")), num(it, "r"), num(it, "l"), num(it, "lf"), num(it, "lo"),
                    num(it, "fw"), num(it, "ow"), it.optBoolean("mv")
                )
            },
            pageField = pf?.let { PageField(box(it.getJSONObject("b")), num(it, "o")) },
            omniField = of?.let { OmniField(box(it.getJSONObject("b")), num(it, "bd"), num(it, "ct")) },
            pillSlot = pl?.let { Pill(box(it.getJSONObject("b")), it.optBoolean("aw"), num(it, "w")) },
            bar = row.optDouble("bar", -1.0).toFloat(),
            sheet = row.optDouble("sh", -1.0).toFloat(),
            page = row.optDouble("pg", -1.0).toFloat(),
            barHideAllowed = row.optBoolean("ba"),
            barHide = num(row, "bh"),
            pending = row.optInt("pa")
        )
    }

    private fun Float.f(): String = "%.1f".format(this)
    private fun Float.p(): String = "%.2f".format(this)

    private fun frameRate(frames: List<Frame>): String {
        if (frames.size < 2) return "${frames.size} frame(s)"
        val span = frames.last().t - frames.first().t
        val fps = if (span > 0) (frames.size - 1) * 1000 / span else 0
        val gaps = frames.zipWithNext { a, b -> b.t - a.t }
        return "${frames.size} frames over $span ms ($fps fps, longest gap ${gaps.maxOrNull() ?: 0} ms)"
    }

    /** The frames of the morph's own motion: a segment running or the finger pulling the open field. */
    private fun flight(frames: List<Frame>): List<Frame> = frames.filter { it.inFlight }

    /** The runs of consecutive in-flight frames (one per segment or pull). */
    private fun segmentsOf(frames: List<Frame>): List<List<Frame>> {
        val runs = ArrayList<List<Frame>>()
        var run = ArrayList<Frame>()
        for (f in frames) {
            if (f.inFlight) run += f
            else if (run.isNotEmpty()) {
                runs += run
                run = ArrayList()
            }
        }
        if (run.isNotEmpty()) runs += run
        return runs
    }

    // --- one surface -----------------------------------------------------------------------------

    /**
     * No frame draws the field twice, none draws none of it. In flight (a segment or the pull)
     * the double alone, over a hidden page field and a blank omnibox field, covering all of the
     * field but the share the pill's words hold (a tap from a scrubbed pose past seven tenths sets
     * out with the well part filled); at rest the page's field, the double and the pill's words
     * cross-fade to a sum of one; open, the omnibox's field alone. Under `reduced` motion a
     * segment is the 120 ms cross-fade in place of whatever goes and whatever comes (the sum of
     * one holds, more loosely: the two eases run on separate clocks a frame apart). Frames at
     * rest with the omnibox up are another hand's (the pill tapped once docked) and are left
     * alone; so, under reduced motion, is a frame on which a fade is still [Frame.pending] on the
     * compositor – the emulator's frame, not the chrome's – and the verdict says how many were.
     */
    fun oneSurface(frames: List<Frame>, reduced: Boolean = false): Verdict {
        var worst: String? = null
        var faults = 0
        var excused = 0
        for ((i, f) in frames.withIndex()) {
            val pageField = f.pageField?.opacity ?: 0f
            val double = f.double?.coverage ?: 0f
            val omni = f.omniField?.drawn ?: 0f
            val pillWords = f.pillSlot?.let { if (it.away) it.words else if (f.look == "docked") 1f else 0f } ?: 0f
            val fault: String? = when {
                reduced && f.pending > 0 -> {
                    excused++
                    null
                }
                reduced && f.inFlight -> {
                    val sum = pageField + double + omni
                    if (abs(sum - 1f) > 0.3f) "frame $i (${f.look}, ${f.t} ms): the fades sum to ${sum.p()} (page field ${pageField.p()}, double ${double.p()}, omnibox ${omni.p()})" else null
                }
                f.inFlight -> when {
                    pageField > EPS -> "frame $i (${f.look}, m ${f.morph.p()}): the page's own field is drawn at ${pageField.p()} under the double"
                    omni > EPS -> "frame $i (${f.look}, m ${f.morph.p()}): the omnibox's field draws ${omni.p()} before the landing"
                    double < 1f - f.pill - 0.06f -> "frame $i (${f.look}, m ${f.morph.p()}): the double covers only ${double.p()} of the field (the pill holds ${f.pill.p()})"
                    pillWords > f.pill + 0.05f -> "frame $i (${f.look}): the pill's words at ${pillWords.p()} over a handover of ${f.pill.p()}"
                    else -> null
                }
                f.phase == "open" -> when {
                    double > EPS -> "frame $i (open, ${f.t} ms): the double is still drawn at ${double.p()} over the omnibox's field"
                    pageField > EPS -> "frame $i (open): the page's field is drawn at ${pageField.p()} under the omnibox"
                    omni < 0.97f && !reduced -> "frame $i (open, ${f.t} ms): the omnibox's field is only ${omni.p()} drawn"
                    else -> null
                }
                f.phase == "rest" && !f.urlbarOpen -> {
                    val sum = pageField + double + pillWords
                    when {
                        omni > EPS -> "frame $i (rest, ${f.t} ms): the omnibox's field draws ${omni.p()} with the bar closed"
                        abs(sum - 1f) > 0.12f -> "frame $i (${f.look.ifEmpty { "rest" }}, scroll ${f.scroll.f()}): the field's incarnations sum to ${sum.p()} (page field ${pageField.p()}, double ${double.p()}, pill's words ${pillWords.p()})"
                        else -> null
                    }
                }
                else -> null
            }
            if (fault != null) {
                faults++
                if (worst == null) worst = fault
            }
        }
        val pending = if (excused > 0) " ($excused frame(s) not judged: a fade pending on the compositor)" else ""
        return Verdict(
            "one surface",
            faults == 0,
            if (faults == 0) "every frame draws the field once (${frameRate(frames)})$pending" else "$faults frame(s) draw it twice or not at all; first: $worst$pending"
        )
    }

    // --- no pop ----------------------------------------------------------------------------------

    /**
     * Between two consecutive frames the value moves by at most [MAX_STEP] and the field drawn –
     * whichever incarnation – by at most that share of the segment's distance (plus a rounding
     * margin), wherever the field is the double's or a flight begins or ends (the frame before
     * the first flight frame and the landing's are compared across: a field that lands anywhere
     * but where the omnibox's field takes over has popped). The segment's distance is the
     * largest separation seen between the field and the omnibox's box. The field's move is taken
     * net of the keyboard's ([shift]): the omnibox's box moves with the inset under a segment (a
     * bottom dock; on the emulator's frame clock the keyboard can arrive whole between two
     * frames, and on the landing's own), and a field that stays on its line to a target the
     * inset moved has not popped, whether it followed the target within the frame or trails it by
     * the one the controller takes to re-measure; a target that moved without the inset (a
     * landing drawn anywhere else) is not excused. Two pulled frames are the finger's (or the back's spring's)
     * pace, not the morph's, and are not bounded: 'the line' holds their box to the value. Two
     * rest frames with the double drawn are the top dock's scrub, which the finger drives, not
     * the spring: given the geometry the field may move as far as the scroll's share of the
     * travel carries it along the line to the slot (plus the margin), and no further; without it
     * they are left to 'the scrub's line'. Two rest frames without a double are not compared: at
     * a bottom dock the riding field hands over to the pill by a fade across the frame (§11.8 as
     * amended), which 'rides with the page' judges. Reduced motion is not held to this: its jump
     * is the design (see [reducedFade]).
     */
    fun noJump(frames: List<Frame>, g: Geometry? = null): Verdict {
        val distance = frames.mapNotNull { f -> f.drawnBox?.let { b -> f.omniField?.box?.let { b.distance(it) } } }.maxOrNull() ?: 0f
        val bound = MAX_STEP * distance + 3f
        var faults = 0
        var worst: String? = null
        var compared = 0
        var scrubbed = 0
        var pulled = 0
        for (i in 1 until frames.size) {
            val a = frames[i - 1]
            val b = frames[i]
            if (a.pulled && b.pulled) {
                pulled++
                continue
            }
            val dm = abs(b.morph - a.morph)
            val flight = a.inFlight || b.inFlight
            val scrub = !flight && g != null && a.doubleDrawn && b.doubleDrawn
            val compare = flight || scrub
            val moved = if (compare) shift(frames.getOrNull(i - 2), a, b) else 0f
            val allowed = if (scrub) abs(g!!.scrubOf(b.scroll) - g.scrubOf(a.scroll)) * g.rest.distance(g.slot) + 3f else bound
            if (compare) compared++
            if (scrub) scrubbed++
            val fault = when {
                dm > MAX_STEP + 0.001f -> "frames ${i - 1}-$i: the value jumped ${a.morph.p()} -> ${b.morph.p()} (${(b.t - a.t)} ms apart)"
                scrub && moved > allowed -> "frames ${i - 1}-$i (scrub): the field jumped ${moved.f()} px for ${abs(b.scroll - a.scroll).f()} px of scroll (bound ${allowed.f()})"
                moved > allowed -> "frames ${i - 1}-$i (${a.look.ifEmpty { "rest" }} -> ${b.look.ifEmpty { "rest" }}): the field jumped ${moved.f()} px of a ${distance.f()} px segment (bound ${bound.f()})"
                else -> null
            }
            if (fault != null) {
                faults++
                if (worst == null) worst = fault
            }
        }
        return Verdict(
            "no pop",
            faults == 0,
            if (faults == 0) "no frame moves the value by more than ${MAX_STEP.p()} or the field by more than ${bound.f()} px of ${distance.f()} ($compared pair(s) compared" +
                (if (scrubbed > 0) ", $scrubbed under the finger" else "") + (if (pulled > 0) ", $pulled pulled pair(s) left to the gesture" else "") + ")"
            else "$faults jump(s); first: $worst"
        )
    }

    /**
     * How far the field moved between two frames, net of the keyboard's: the move as drawn, less
     * the part of the omnibox field's own move (the target's) that the inset's change accounts
     * for – over this pair and the one before it, since the controller may trail the target by
     * the frame it takes to re-measure and make the following move a pair late. A target that
     * moved with no change of the inset (a layout shift, a landing drawn somewhere else) is not
     * excused, nor is the inset's change where the target did not move (a top dock's keyboard).
     * 0 when a frame draws no field.
     */
    private fun shift(before: Frame?, a: Frame, b: Frame): Float {
        val x = a.drawnBox ?: return 0f
        val y = b.drawnBox ?: return 0f
        val drawn = x.distance(y)
        val inset = abs(b.insetBottom - a.insetBottom) + (before?.let { abs(a.insetBottom - it.insetBottom) } ?: 0f)
        val target = targetMove(a, b) + (before?.let { targetMove(it, a) } ?: 0f)
        return max(0f, drawn - min(inset, target))
    }

    /** How far the omnibox's field (the segment's target) moved between two frames; 0 where a frame has none. */
    private fun targetMove(a: Frame, b: Frame): Float {
        val ta = a.omniField?.box ?: return 0f
        val tb = b.omniField?.box ?: return 0f
        return ta.distance(tb)
    }

    // --- the line --------------------------------------------------------------------------------

    /**
     * Every in-flight frame draws the double on the straight line from the page's pose at the
     * frame's scroll (`restPose`: the field's natural box, or the scrubbed one) to the omnibox
     * field's box on that frame, at the value: `lerpRect(rest, omnibox, m)` edge by edge, the
     * radius on the same line. Every segment runs on this one line – a tap from rest or from a
     * scrub, a dismissal from open or caught mid-flight (its start is a point of the line, so
     * its run is a stretch of it), the back gesture's pull – which is what makes them
     * interruptible without a seam (§11.8). A target that moves under the segment (the keyboard's
     * inset at a bottom dock) moves the line's end; the box may trail it by the one frame the
     * controller takes to re-measure, so the previous frame's target is allowed too.
     */
    fun onTheLine(frames: List<Frame>, g: Geometry): Verdict {
        val segments = segmentsOf(frames)
        if (segments.isEmpty()) return Verdict("the line", false, "no segment was sampled")
        var worst: String? = null
        var faults = 0
        var checked = 0
        var trailed = 0
        for (segment in segments) {
            var previousTarget: Box? = null
            for (f in segment) {
                val d = f.double
                val target = f.omniField?.box
                if (d == null || target == null || !f.doubleDrawn) {
                    previousTarget = target ?: previousTarget
                    continue
                }
                checked++
                val s = g.scrubOf(f.scroll)
                val rest = restBox(g, s)
                val expected = lerpBox(rest, target, f.morph)
                val onLine = d.box.near(expected, LINE_TOLERANCE)
                val onLastLine = !onLine && previousTarget != null && d.box.near(lerpBox(rest, previousTarget, f.morph), LINE_TOLERANCE)
                if (onLastLine) trailed++
                if (!onLine && !onLastLine) {
                    faults++
                    if (worst == null) worst = "frame at ${f.t} ms (${f.look}, m ${f.morph.p()}, s ${s.p()}): drawn at ${d.box}, the line has $expected (omnibox at $target)"
                }
                val radius = lerp(restRadius(g, s), DOCK_RADIUS, f.morph)
                if (abs(d.radius - radius) > 1.5f) {
                    faults++
                    if (worst == null) worst = "frame at ${f.t} ms (m ${f.morph.p()}): radius ${d.radius.f()}, the line has ${radius.f()}"
                }
                previousTarget = target
            }
        }
        return Verdict(
            "the line",
            faults == 0 && checked > 0,
            when {
                checked == 0 -> "no frame of a segment could be checked"
                faults == 0 -> "$checked frame(s) over ${segments.size} segment(s) on the line within ${LINE_TOLERANCE.f()} px" +
                    if (trailed > 0) " ($trailed a frame behind a target that moved)" else ""
                else -> "$faults frame(s) off the line; first: $worst"
            }
        )
    }

    // --- monotone --------------------------------------------------------------------------------

    /**
     * Opening, the value only grows; closing, it only shrinks – the spring never turns round on
     * its own. A back committed on the landed omnibox runs the field home on the bar's own spring
     * instead (`BackDismissal.commit`, the value under the pull): those pulled frames, the run of
     * them that ends at rest ([committedPull]), are held to the same – only shrinking – while a
     * pull under the finger (a hold, a cancel) is the finger's and is not.
     */
    fun monotoneSpring(frames: List<Frame>): Verdict {
        var faults = 0
        var worst: String? = null
        var opening = 0
        var closing = 0
        var home = 0
        val commit = committedPull(frames)
        for (i in 1 until frames.size) {
            val a = frames[i - 1]
            val b = frames[i]
            if (commit != null && i - 1 >= commit.first && i <= commit.last) {
                home++
                if (b.morph > a.morph + 0.005f) {
                    faults++
                    if (worst == null) worst = "frames ${i - 1}-$i (pulled home): ${a.morph.p()} -> ${b.morph.p()}"
                }
                continue
            }
            if (a.phase != b.phase) continue
            when (b.phase) {
                "opening" -> {
                    opening++
                    if (b.morph < a.morph - 0.005f) {
                        faults++
                        if (worst == null) worst = "frames ${i - 1}-$i (opening): ${a.morph.p()} -> ${b.morph.p()}"
                    }
                }
                "closing" -> {
                    closing++
                    if (b.morph > a.morph + 0.005f) {
                        faults++
                        if (worst == null) worst = "frames ${i - 1}-$i (closing): ${a.morph.p()} -> ${b.morph.p()}"
                    }
                }
            }
        }
        val steps = opening + closing + home
        return Verdict(
            "monotone spring",
            faults == 0 && steps > 0,
            if (steps == 0) "no segment frames"
            else if (faults == 0) "the value never turned round ($opening opening, $closing closing${if (home > 0) ", $home pulled-home" else ""} steps)"
            else "$faults turn(s); first: $worst"
        )
    }

    /**
     * The frames of a back's commit running the landed field home on the bar's spring: the last
     * run of pulled frames (phase open, look pulled) that a rest frame follows directly. Null when
     * no pull ended at rest.
     */
    private fun committedPull(frames: List<Frame>): IntRange? {
        val rest = (1 until frames.size).lastOrNull { frames[it].phase == "rest" && frames[it - 1].pulled } ?: return null
        var first = rest - 1
        while (first > 0 && frames[first - 1].pulled) first--
        return first until rest
    }

    /**
     * Under a steady finger – the scroll never decreasing over `frames` – the scrub's every edge
     * moves one way: at a top dock the double's box toward the slot (each edge monotone, as the
     * lerp is), at a bottom dock the page's field up, one to one with the scroll and never
     * against it (§11.8 as amended: exactly as far as the finger).
     */
    fun steadyFinger(frames: List<Frame>, g: Geometry): Verdict {
        val rest = frames.filter { it.phase == "rest" }
        if (rest.size < 3) return Verdict("steady finger", false, "only ${rest.size} rest frame(s)")
        var faults = 0
        var worst: String? = null
        var steps = 0
        for (i in 1 until rest.size) {
            val a = rest[i - 1]
            val b = rest[i]
            if (b.scroll < a.scroll - 0.5f) {
                faults++
                if (worst == null) worst = "frames ${i - 1}-$i: the scroll went back ${a.scroll.f()} -> ${b.scroll.f()}"
                continue
            }
            if (g.dockBelow) {
                val pa = a.pageField ?: continue
                val pb = b.pageField ?: continue
                steps++
                val dy = pb.box.y - pa.box.y
                val ds = b.scroll - a.scroll
                if (dy > 0.5f) {
                    faults++
                    if (worst == null) worst = "frames ${i - 1}-$i: the field moved down ${dy.f()} px against a finger scrolling ${ds.f()} px"
                } else if (abs(dy + ds) > 1.5f && a.scroll < g.travel && b.scroll < g.travel) {
                    faults++
                    if (worst == null) worst = "frames ${i - 1}-$i: the field moved ${(-dy).f()} px for ${ds.f()} px of scroll (not one to one)"
                }
            } else {
                val da = a.double ?: continue
                val db = b.double ?: continue
                steps++
                val dir = { r: Float, s: Float -> if (s > r) 1 else if (s < r) -1 else 0 }
                val bad = listOf(
                    Triple("left", db.box.x - da.box.x, dir(g.rest.x, g.slot.x)),
                    Triple("top", db.box.y - da.box.y, dir(g.rest.y, g.slot.y)),
                    Triple("width", db.box.w - da.box.w, dir(g.rest.w, g.slot.w)),
                    Triple("height", db.box.h - da.box.h, dir(g.rest.h, g.slot.h))
                ).firstOrNull { (_, delta, d) -> d != 0 && delta * d < -0.5f }
                if (bad != null) {
                    faults++
                    if (worst == null) worst = "frames ${i - 1}-$i: the double's ${bad.first} moved ${bad.second.f()} px against the scrub"
                }
                if (b.pill < a.pill - 0.01f) {
                    faults++
                    if (worst == null) worst = "frames ${i - 1}-$i: the pill handover went back ${a.pill.p()} -> ${b.pill.p()}"
                }
            }
        }
        return Verdict(
            "steady finger",
            faults == 0 && steps > 0,
            if (steps == 0) "no two frames had the field to compare" else if (faults == 0) "$steps step(s), every edge one way${if (g.dockBelow) ", one to one with the finger" else ""}" else "$faults step(s) against the finger; first: $worst"
        )
    }

    // --- the landing -----------------------------------------------------------------------------

    /**
     * The omnibox's own field takes over on the frame the double goes: the last opening frame
     * draws the double and no omnibox field, the first open frame the omnibox's field (its
     * content whole at once: nothing replays) and no double, and the two are consecutive. The
     * bar is open under the field from its first moving frame.
     */
    fun landing(frames: List<Frame>): Verdict {
        val lastFlight = frames.indexOfLast { it.phase == "opening" }
        if (lastFlight < 0) return Verdict("the landing", false, "no opening frame was sampled")
        val firstOpen = (lastFlight + 1 until frames.size).firstOrNull { frames[it].phase == "open" }
            ?: return Verdict("the landing", false, "the segment never landed within the sample")
        val a = frames[lastFlight]
        val b = frames[firstOpen]
        val problems = ArrayList<String>()
        if (firstOpen != lastFlight + 1) problems += "${firstOpen - lastFlight - 1} frame(s) neither opening nor open between the flight and the landing"
        if (!a.doubleDrawn) problems += "the last flight frame (m ${a.morph.p()}) draws no double"
        if (a.omniDrawn) problems += "the omnibox's field draws ${a.omniField!!.drawn.p()} on the last flight frame"
        if (b.doubleDrawn) problems += "the double is still drawn at ${b.double!!.coverage.p()} on the landed frame"
        if ((b.omniField?.content ?: 0f) < 0.97f) problems += "the omnibox's content is ${(b.omniField?.content ?: 0f).p()} on the landed frame"
        val firstMoving = frames.indexOfFirst { it.phase == "opening" && it.morph > 0f }
        if (firstMoving >= 0 && !frames[firstMoving].urlbarOpen) problems += "the field set out (frame $firstMoving) before the bar was open"
        val gap = b.t - a.t
        return Verdict(
            "the landing",
            problems.isEmpty(),
            if (problems.isEmpty()) "the omnibox's field took over on the frame after the double's last (m ${a.morph.p()} at ${a.t} ms, landed at ${b.t} ms, $gap ms apart)"
            else problems.joinToString("; ")
        )
    }

    /**
     * The end of a closing: the last closing frame draws the double, the first rest frame after
     * it the page's field (or the scrubbed double, at a top dock part way) and no omnibox, with
     * the bar closed on that frame. A back committed on the landed field comes home pulled
     * instead of closing (the bar's spring, see [monotoneSpring]): the same is asked of its last
     * pulled frame and the rest frame after it.
     */
    fun returned(frames: List<Frame>): Verdict {
        val lastFlight = frames.indexOfLast { it.phase == "closing" || it.pulled }
        if (lastFlight < 0) return Verdict("the return", false, "no closing (or pulled) frame was sampled")
        val firstRest = (lastFlight + 1 until frames.size).firstOrNull { frames[it].phase == "rest" }
            ?: return Verdict("the return", false, "the segment never came to rest within the sample")
        val a = frames[lastFlight]
        val how = if (a.phase == "closing") "closing" else "pulled home"
        val b = frames[firstRest]
        val problems = ArrayList<String>()
        if (firstRest != lastFlight + 1) problems += "${firstRest - lastFlight - 1} frame(s) between the flight and the rest"
        if (!a.doubleDrawn) problems += "the last $how frame draws no double"
        if (b.urlbarOpen) problems += "the bar is still open on the first rest frame"
        if (b.omniDrawn) problems += "the omnibox's field draws ${b.omniField!!.drawn.p()} at rest"
        if (!b.pageFieldDrawn && !b.doubleDrawn && b.look != "docked") problems += "nothing draws the field on the first rest frame"
        return Verdict(
            "the return",
            problems.isEmpty(),
            if (problems.isEmpty()) "the page had its field back on the frame after the double's last ($how, m ${a.morph.p()} at ${a.t} ms, at rest ${b.t} ms, look '${b.look.ifEmpty { "rest" }}')"
            else problems.joinToString("; ")
        )
    }

    /**
     * A tap on the field on its way back turns it round: a closing run followed at once by an
     * opening one – no rest frame between – with the value carried across the turn (the new
     * segment sets out from where the field was, with the velocity it had: `tapFakebox` on a
     * closing) and the sequence landing open.
     */
    fun turnedRound(frames: List<Frame>): Verdict {
        val turn = (1 until frames.size).firstOrNull { frames[it - 1].phase == "closing" && frames[it].phase == "opening" }
            ?: return Verdict(
                "the turn",
                false,
                if (frames.none { it.phase == "closing" }) "no closing frame was sampled" else "the closing never turned into an opening"
            )
        val a = frames[turn - 1]
        val b = frames[turn]
        val problems = ArrayList<String>()
        if (abs(b.morph - a.morph) > MAX_STEP) problems += "the value jumped ${a.morph.p()} -> ${b.morph.p()} at the turn"
        if (!a.doubleDrawn || !b.doubleDrawn) problems += "the double was not drawn on both sides of the turn"
        if (frames.last().phase != "open") problems += "the sequence ended '${frames.last().phase}', not open"
        return Verdict(
            "the turn",
            problems.isEmpty(),
            if (problems.isEmpty()) "the closing turned into an opening at m ${a.morph.p()} (${b.t} ms) and landed open" else problems.joinToString("; ")
        )
    }

    // --- the half --------------------------------------------------------------------------------

    /**
     * The double's page-field words leave over the first half of the value and its omnibox-field
     * words arrive over the second: `(1 - 2m)(1 - p)` and `2m - 1`, clamped, on every in-flight
     * frame; both halves observed.
     */
    fun wordsHandover(frames: List<Frame>): Verdict {
        val flight = flight(frames).filter { it.doubleDrawn }
        if (flight.isEmpty()) return Verdict("the words at the half", false, "no in-flight frame drew the double")
        var faults = 0
        var worst: String? = null
        var below = 0
        var above = 0
        for (f in flight) {
            val d = f.double!!
            val m = f.morph
            if (m < 0.5f) below++ else above++
            val field = clamp01(1 - 2 * m) * (1 - f.pill)
            val omni = clamp01(2 * m - 1)
            if (abs(d.fieldWords - field) > 0.06f || abs(d.omniWords - omni) > 0.06f) {
                faults++
                if (worst == null) worst = "frame at ${f.t} ms (m ${m.p()}): field words ${d.fieldWords.p()} (expected ${field.p()}), omnibox words ${d.omniWords.p()} (expected ${omni.p()})"
            }
            if (d.fieldWords > 0.5f && d.omniWords > 0.5f) {
                faults++
                if (worst == null) worst = "frame at ${f.t} ms (m ${m.p()}): both sets of words over half (${d.fieldWords.p()}, ${d.omniWords.p()})"
            }
        }
        val observed = below > 0 && above > 0
        return Verdict(
            "the words at the half",
            faults == 0 && observed,
            if (!observed) "only ${if (below == 0) "the second" else "the first"} half was sampled ($below below, $above above)"
            else if (faults == 0) "the page field's words left over the first half and the omnibox's arrived over the second ($below frames below the half, $above above)"
            else "$faults frame(s) off; first: $worst"
        )
    }

    // --- the scrub -------------------------------------------------------------------------------

    /**
     * At a top dock, every rest frame with the scroll part way draws the double on the line from
     * the field's natural box to the slot at the scroll's share of the travel (`restPose`), its
     * radius rounding with it, the page's own field hidden, and hands over to the pill over the
     * last three tenths: the double's field look at `1 - pillLook` and the pill's words at
     * `pillLook`.
     */
    fun scrubOnTheLine(frames: List<Frame>, g: Geometry): Verdict {
        if (g.dockBelow) return Verdict("the scrub's line", false, "the bar is docked below: the field rides, see 'rides with the page'")
        val part = frames.filter { it.phase == "rest" && !it.urlbarOpen && it.scroll > 0.5f && it.scroll < g.travel - 0.5f }
        if (part.isEmpty()) return Verdict("the scrub's line", false, "no rest frame with the scroll part way (travel ${g.travel.f()} px)")
        var faults = 0
        var worst: String? = null
        for (f in part) {
            val s = g.scrubOf(f.scroll)
            val expected = restBox(g, s)
            val d = f.double
            val fault = when {
                d == null || !f.doubleDrawn && pillLook(s) < 0.97f -> "scroll ${f.scroll.f()} (s ${s.p()}): no double drawn"
                !d.box.near(expected, LINE_TOLERANCE) -> "scroll ${f.scroll.f()} (s ${s.p()}): drawn at ${d.box}, the line has $expected"
                abs(d.radius - restRadius(g, s)) > 1.5f -> "scroll ${f.scroll.f()} (s ${s.p()}): radius ${d.radius.f()}, the line has ${restRadius(g, s).f()}"
                f.pageFieldDrawn -> "scroll ${f.scroll.f()}: the page's own field is drawn at ${f.pageField!!.opacity.p()} under the double"
                abs(f.pill - pillLook(s)) > 0.05f -> "scroll ${f.scroll.f()} (s ${s.p()}): handover ${f.pill.p()}, expected ${pillLook(s).p()}"
                abs(d.coverage - (1 - pillLook(s))) > 0.06f -> "scroll ${f.scroll.f()} (s ${s.p()}): the double covers ${d.coverage.p()}, expected ${(1 - pillLook(s)).p()}"
                f.pillSlot != null && f.pillSlot.away && abs(f.pillSlot.words - pillLook(s)) > 0.06f -> "scroll ${f.scroll.f()} (s ${s.p()}): the pill's words at ${f.pillSlot.words.p()}, expected ${pillLook(s).p()}"
                else -> null
            }
            if (fault != null) {
                faults++
                if (worst == null) worst = fault
            }
        }
        return Verdict(
            "the scrub's line",
            faults == 0,
            if (faults == 0) "${part.size} frame(s) part way: the double on the line from the field to the slot, the handover over the last three tenths" else "$faults frame(s) off; first: $worst"
        )
    }

    /**
     * At a bottom dock, every rest frame with the scroll part way draws the page's own field
     * exactly as far up as the finger has scrolled, unchanged in size, no double, fading out
     * over the last three tenths as the pill's words fade in (§11.8 as amended: L1).
     */
    fun ridesWithPage(frames: List<Frame>, g: Geometry): Verdict {
        if (!g.dockBelow) return Verdict("rides with the page", false, "the bar is docked above: the double carries the field, see 'the scrub's line'")
        val part = frames.filter { it.phase == "rest" && !it.urlbarOpen && it.scroll > 0.5f && it.scroll < g.travel - 0.5f }
        if (part.isEmpty()) return Verdict("rides with the page", false, "no rest frame with the scroll part way (travel ${g.travel.f()} px)")
        var faults = 0
        var worst: String? = null
        for (f in part) {
            val s = g.scrubOf(f.scroll)
            val expected = restBox(g, s)
            val p = f.pageField
            val fault = when {
                f.doubleDrawn -> "scroll ${f.scroll.f()} (s ${s.p()}): a double is drawn at ${f.double!!.coverage.p()} where the page's field rides"
                p == null -> "scroll ${f.scroll.f()}: the page's field is gone from the DOM"
                !p.box.near(expected, LINE_TOLERANCE) -> "scroll ${f.scroll.f()} (s ${s.p()}): the field at ${p.box}, riding one to one it would be at $expected"
                abs(p.opacity - (1 - pillLook(s))) > 0.06f -> "scroll ${f.scroll.f()} (s ${s.p()}): the field at ${p.opacity.p()}, expected ${(1 - pillLook(s)).p()}"
                abs(f.pill - pillLook(s)) > 0.05f -> "scroll ${f.scroll.f()} (s ${s.p()}): handover ${f.pill.p()}, expected ${pillLook(s).p()}"
                f.pillSlot != null && f.pillSlot.away && abs(f.pillSlot.words - pillLook(s)) > 0.06f -> "scroll ${f.scroll.f()} (s ${s.p()}): the pill's words at ${f.pillSlot.words.p()}, expected ${pillLook(s).p()}"
                else -> null
            }
            if (fault != null) {
                faults++
                if (worst == null) worst = fault
            }
        }
        return Verdict(
            "rides with the page",
            faults == 0,
            if (faults == 0) "${part.size} frame(s) part way: the field rode one to one with the finger, unchanged, fading at the frame's edge as the pill filled in" else "$faults frame(s) off; first: $worst"
        )
    }

    /** Docked: the pill whole and the field's other incarnations gone, on every frame with the scroll past the travel. */
    fun docked(frames: List<Frame>, g: Geometry): Verdict {
        val past = frames.filter { it.phase == "rest" && !it.urlbarOpen && it.scroll >= g.travel - 0.5f }
        if (past.isEmpty()) return Verdict("docked", false, "the scroll never reached the travel (${g.travel.f()} px; furthest ${frames.maxOfOrNull { it.scroll }?.f() ?: "-"})")
        var faults = 0
        var worst: String? = null
        for (f in past) {
            val fault = when {
                f.look != "docked" -> "scroll ${f.scroll.f()}: look '${f.look.ifEmpty { "rest" }}', not docked"
                f.doubleDrawn -> "scroll ${f.scroll.f()}: a double is still drawn at ${f.double!!.coverage.p()}"
                f.pageFieldDrawn -> "scroll ${f.scroll.f()}: the page's field is still drawn at ${f.pageField!!.opacity.p()}"
                f.pillSlot == null -> "scroll ${f.scroll.f()}: no pill in the bar"
                f.pillSlot.away -> "scroll ${f.scroll.f()}: the pill is still the well"
                f.pillSlot.words < 0.97f -> "scroll ${f.scroll.f()}: the pill's words at ${f.pillSlot.words.p()}"
                else -> null
            }
            if (fault != null) {
                faults++
                if (worst == null) worst = fault
            }
        }
        return Verdict("docked", faults == 0, if (faults == 0) "${past.size} frame(s) past the travel: the pill whole, nothing else drawn" else "$faults frame(s) off; first: $worst")
    }

    // --- reduced motion --------------------------------------------------------------------------

    /**
     * Under reduced motion (§11.3) the spring's part is a fade in place: the double, where one
     * is drawn at all (a field the scroll holds part way at a top dock), holds one box through
     * the segment; the omnibox's field arrives (opening) or leaves (closing) on an opacity ramp
     * of about [REDUCED_FADE_MS] – at least two frames, never a cut – and the page's field the
     * other way; and the value itself jumps rather than travels (no frame part way). The fade
     * itself is the compositor's to draw: where a frame of the segment had it [Frame.pending] –
     * the emulator's software GPU had not started it by the time the controller's 120 ms hold
     * was over, so the sampler saw the content whole, then gone – or where the sampler had a
     * single frame in a gap wider than the fade, the fade is NOT JUDGED rather than failed; the
     * box and the value, which the chrome writes itself, are judged either way.
     */
    fun reducedFade(frames: List<Frame>): Verdict {
        val segments = segmentsOf(frames).filter { run -> run.any { it.phase == "opening" || it.phase == "closing" } }
        if (segments.isEmpty()) return Verdict("reduced motion", false, "no segment was sampled")
        val problems = ArrayList<String>()
        val unjudged = ArrayList<String>()
        for (segment in segments) {
            val phase = segment.first().phase
            val boxes = segment.mapNotNull { it.double?.box }
            if (boxes.isNotEmpty()) {
                val first = boxes.first()
                val moved = boxes.maxOf { it.distance(first) }
                if (moved > 1f) problems += "$phase: the double travelled ${moved.f()} px (it must fade in place)"
            }
            val partWay = segment.filter { it.morph > 0.02f && it.morph < 0.98f }
            if (partWay.isNotEmpty()) problems += "$phase: ${partWay.size} frame(s) with the value part way (${partWay.joinToString { it.morph.p() }}): the value must jump"
            val omni = segment.mapNotNull { f -> f.omniField?.let { f.t to it.content } }
            val ramp = omni.filter { it.second > EPS && it.second < 1 - EPS }
            val span = if (omni.size >= 2) omni.last().first - omni.first().first else 0
            val pending = segment.count { it.pending > 0 }
            // The sampler's gap around the segment: the frame before its first to the frame after its last.
            val before = frames.indexOf(segment.first()) - 1
            val after = frames.indexOf(segment.last()) + 1
            val gap = (if (after in frames.indices) frames[after].t else segment.last().t) - (if (before >= 0) frames[before].t else segment.first().t)
            when {
                pending > 0 && ramp.isEmpty() -> unjudged += "$phase: the fade was still pending on the compositor on $pending of ${segment.size} frame(s) (${gap} ms around the segment)"
                omni.size < 2 && gap >= REDUCED_FADE_MS -> unjudged += "$phase: the omnibox's field was sampled on ${omni.size} frame(s) in a gap of $gap ms, wider than the fade"
                omni.size < 2 -> problems += "$phase: the omnibox's field was sampled on ${omni.size} frame(s)"
                ramp.isEmpty() && span >= 40 -> problems += "$phase: the omnibox's content cut ${omni.first().second.p()} -> ${omni.last().second.p()} with no frame part way over $span ms"
                phase == "opening" && omni.last().second < omni.first().second -> problems += "$phase: the omnibox's content fell ${omni.first().second.p()} -> ${omni.last().second.p()}"
                phase == "closing" && omni.last().second > omni.first().second -> problems += "$phase: the omnibox's content rose ${omni.first().second.p()} -> ${omni.last().second.p()}"
            }
            val fadeSpan = if (ramp.size >= 2) ramp.last().first - ramp.first().first else 0
            if (fadeSpan > REDUCED_FADE_MAX_MS) problems += "$phase: the fade ran $fadeSpan ms (about $REDUCED_FADE_MS expected)"
        }
        val judged = unjudged.isEmpty()
        return Verdict(
            "reduced motion",
            problems.isEmpty(),
            when {
                problems.isNotEmpty() -> (problems + unjudged).joinToString("; ")
                judged -> "${segments.size} segment(s): nothing travelled, the value jumped, the omnibox faded over more than one frame"
                else -> "${segments.size} segment(s): nothing travelled and the value jumped; the fade the emulator never drew: " + unjudged.joinToString("; ")
            },
            judged = judged || problems.isNotEmpty()
        )
    }

    // --- the bar's hide --------------------------------------------------------------------------

    /** The bar's hide-on-scroll stays gated off on the new tab page: its gate closed and its value 0 on every frame (#200, §11.5). */
    fun barStays(frames: List<Frame>): Verdict {
        if (frames.isEmpty()) return Verdict("the bar stays", false, "no frames")
        val allowed = frames.count { it.barHideAllowed }
        val moved = frames.filter { it.barHide > EPS }
        val scrolled = frames.maxOf { it.scroll }
        return Verdict(
            "the bar stays",
            allowed == 0 && moved.isEmpty(),
            when {
                allowed > 0 -> "$allowed frame(s) had the bar's hide gate open on the new tab page"
                moved.isNotEmpty() -> "${moved.size} frame(s) moved the bar by its hide (up to ${moved.maxOf { it.barHide }.p()})"
                else -> "${frames.size} frame(s), the page scrolled to ${scrolled.f()} px: the hide's gate closed and its value 0 throughout"
            }
        )
    }

    // --- the end state ---------------------------------------------------------------------------

    /**
     * Where a sequence ends: the look asked for, the bar open or not as asked, and exactly one
     * incarnation of the field drawn (the omnibox's when open, the page's or the pill when not).
     * A scrubbed pose (`look` scrub) is the one rest the double may be that incarnation: at a top
     * dock the scroll holds the field part way along the line, and the double is what draws it
     * there (`drawsSurface`); at a bottom dock the page's own field rides, and a double would be
     * one too many.
     */
    fun resolved(frame: Frame, look: String, urlbarOpen: Boolean): Verdict {
        val problems = ArrayList<String>()
        if (frame.look != look) problems += "look '${frame.look.ifEmpty { "rest" }}', expected '${look.ifEmpty { "rest" }}'"
        if (frame.urlbarOpen != urlbarOpen) problems += "the bar is ${if (frame.urlbarOpen) "open" else "closed"}, expected ${if (urlbarOpen) "open" else "closed"}"
        val scrubbedDouble = look == "scrub" && frame.doubleDrawn
        if (frame.doubleDrawn && !scrubbedDouble) problems += "a double is drawn at ${frame.double!!.coverage.p()}"
        val incarnations = listOfNotNull(
            if (frame.pageFieldDrawn) "the page's field (${frame.pageField!!.opacity.p()})" else null,
            if (scrubbedDouble) "the double, scrubbed part way (${frame.double!!.coverage.p()})" else null,
            if (frame.omniDrawn) "the omnibox's field (${frame.omniField!!.drawn.p()})" else null,
            if (frame.pillSlot != null && !frame.pillSlot.away) "the pill" else null
        )
        if (incarnations.size != 1) problems += "${incarnations.size} incarnation(s) of the field drawn: ${incarnations.joinToString().ifEmpty { "none" }}"
        return Verdict(
            "resolved to one state",
            problems.isEmpty(),
            if (problems.isEmpty()) "look '${look.ifEmpty { "rest" }}', the bar ${if (urlbarOpen) "open" else "closed"}, ${incarnations.single()} alone" else problems.joinToString("; ")
        )
    }

    /** The sampling's frame rate and longest gap, for the findings. */
    fun describe(frames: List<Frame>): String = frameRate(frames)
}

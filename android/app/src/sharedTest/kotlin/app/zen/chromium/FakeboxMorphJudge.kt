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

    /**
     * What the stylesheet resolves to on an element this frame, off its computed style: the
     * transition's properties (`none`, or the list) and durations, the animation's names (`none`,
     * or the list) and durations, the durations in ms as the computed `<time>` serialises them
     * (`0.12s`; the old rule's `0.01ms` as `1e-05s`).
     */
    data class Declared(
        val transitionProperties: List<String>,
        val transitionMs: List<Float>,
        val animationNames: List<String>,
        val animationMs: List<Float>
    ) {
        /** The transition runs (a property other than `none` is named). */
        val transitions: Boolean get() = transitionProperties.any { it != "none" && it.isNotEmpty() }
        /** The animation runs (a name other than `none`). */
        val animates: Boolean get() = animationNames.any { it != "none" && it.isNotEmpty() }
        /** Every duration that applies: the transition's when it runs, the animation's when it does. */
        val activeMs: List<Float> get() = (if (transitions) transitionMs else emptyList()) + (if (animates) animationMs else emptyList())
        override fun toString(): String =
            "transition ${transitionProperties.joinToString(",")} ${transitionMs.joinToString(",") { it.f() }} ms; animation ${animationNames.joinToString(",")} ${animationMs.joinToString(",") { it.f() }} ms"
    }

    /**
     * The sheet chassis (`BottomSheet`, `[data-sheet-layer]`) while a sheet is in the DOM: the
     * sheet's box, its own opacity, its transform's translate-y and scale, the scrim's own
     * opacity, what the stylesheet declares on it and how many of the layer's animations and
     * transitions are pending on the compositor.
     */
    data class SheetLayer(
        val box: Box,
        val opacity: Float,
        val translateY: Float,
        val scale: Float,
        val scrim: Float,
        val declared: Declared?,
        val pending: Int
    ) {
        val drawn: Boolean get() = opacity > EPS
    }

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
        val pending: Int = 0,
        /** The page (`.zen-ntp`) is not `visibility: hidden` this frame; null when no page is in the DOM (or an older sampler). */
        val pageVisible: Boolean? = null,
        /** The content frame's transform's scale this frame: 1 at rest, .97 receded under a sheet (never under reduced motion). */
        val frameScale: Float = 1f,
        /**
         * What the stylesheet declares this frame on the elements whose motion reduced motion keeps
         * or removes, by a short name: `fades` (`.zen-ntp-fades`), `omnibox` (`.zen-omnibox-sheet`),
         * `page` (`.zen-ntp`), `column` (`.zen-content-column`), `bar` (`.zen-phone-bar`), `frame`
         * (`.zen-content-frame`). Empty from an older sampler; an element not in the DOM is absent.
         */
        val declared: Map<String, Declared> = emptyMap(),
        /** The sheet chassis while a sheet is in the DOM (the sheet scene); null else. */
        val sheetLayer: SheetLayer? = null
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

    /** The machine's two rests: a segment runs from one to the other. */
    private val RESTS = setOf("rest", "open")

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
            pending = row.optInt("pa"),
            pageVisible = if (row.has("pv") && !row.isNull("pv")) row.optBoolean("pv") else null,
            frameScale = row.optDouble("cf", 1.0).toFloat(),
            declared = row.optJSONObject("dc")?.let { dc ->
                dc.keys().asSequence().mapNotNull { key -> dc.optJSONObject(key)?.let { key to declared(it) } }.toMap()
            } ?: emptyMap(),
            sheetLayer = row.optJSONObject("sl")?.let {
                SheetLayer(
                    box(it.getJSONObject("b")), num(it, "o"), num(it, "y"), it.optDouble("s", 1.0).toFloat(), num(it, "so"),
                    it.optJSONObject("dc")?.let(::declared), it.optInt("pa")
                )
            }
        )
    }

    /** A declaration as the sampler writes it: `{tp, td, an, ad}`, the computed style's strings. */
    private fun declared(o: JSONObject): Declared = Declared(
        transitionProperties = names(o.optString("tp")),
        transitionMs = parseTimes(o.optString("td")),
        animationNames = names(o.optString("an")),
        animationMs = parseTimes(o.optString("ad"))
    )

    private fun names(list: String): List<String> = list.split(",").map { it.trim() }.filter { it.isNotEmpty() }

    /**
     * A computed `<time>` list in ms: `0.12s` → 120, `1e-05s` (the old rule's `0.01ms`) → 0.01,
     * `0s, 0.12s` → 0 and 120; unparsable items read as 0.
     */
    fun parseTimes(list: String): List<Float> = list.split(",").map { it.trim() }.filter { it.isNotEmpty() }.map { t ->
        when {
            t.endsWith("ms") -> t.dropLast(2).toFloatOrNull() ?: 0f
            t.endsWith("s") -> (t.dropLast(1).toFloatOrNull() ?: 0f) * 1000f
            else -> t.toFloatOrNull() ?: 0f
        }
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
     * The flag drops the frame the compositor takes the fade's start time, and the first frame
     * drawn with it comes a compositor frame later still (run 3's reduced-bottom closing: nothing
     * pending 16 ms after a frame with three, the page still at 0, the next frame pending again,
     * the page back at 3682 ms), so the excuse runs on for one fade's length past a frame with
     * something pending, on either side of it ([pendingNear]).
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
                reduced && pendingNear(frames, i) -> {
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

    /**
     * Whether frame [i] is the compositor's under reduced motion: a fade [Frame.pending] on it, or
     * on a frame within one fade's length ([REDUCED_FADE_MS]) before or after it – the flag drops
     * when the start time is taken, a compositor frame before anything is drawn with it.
     */
    fun pendingNear(frames: List<Frame>, i: Int): Boolean {
        val f = frames[i]
        if (f.pending > 0) return true
        var j = i - 1
        while (j >= 0 && f.t - frames[j].t <= REDUCED_FADE_MS) {
            if (frames[j].pending > 0) return true
            j--
        }
        j = i + 1
        while (j < frames.size && frames[j].t - f.t <= REDUCED_FADE_MS) {
            if (frames[j].pending > 0) return true
            j++
        }
        return false
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
     * box and the value, which the chrome writes itself, are judged either way. A segment the
     * sampler never saw at all – the phase at one rest on a frame and at the other on the next,
     * the controller's 120 ms hold whole inside a gap at least that wide – is the sampler's
     * frame rate too (run 2's reduced-bottom closing: `open` at 1674 ms, `rest` at 2090 ms, the
     * hold inside 416 ms), NOT JUDGED with the gap named; inside a narrower gap the hold was cut
     * short, and that is failed.
     */
    fun reducedFade(frames: List<Frame>): Verdict {
        val segments = segmentsOf(frames).filter { run -> run.any { it.phase == "opening" || it.phase == "closing" } }
        if (segments.isEmpty()) {
            val across = frames.zipWithNext().firstOrNull { (a, b) -> a.phase != b.phase && a.phase in RESTS && b.phase in RESTS }
                ?: return Verdict("reduced motion", false, "no segment was sampled")
            val (a, b) = across
            val gap = b.t - a.t
            val phase = if (b.phase == "rest") "closing" else "opening"
            return if (gap >= REDUCED_FADE_MS) Verdict(
                "reduced motion",
                true,
                "the $phase fell between two frames $gap ms apart (${a.phase} at ${a.t} ms, ${b.phase} at ${b.t} ms), wider than the fade: the value jumped ${a.morph.p()} -> ${b.morph.p()}; the fade the emulator never sampled",
                judged = false
            ) else Verdict("reduced motion", false, "no segment was sampled: the phase went ${a.phase} -> ${b.phase} across $gap ms, less than the ${REDUCED_FADE_MS} ms hold")
        }
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

    // --- reduced motion: no transition ------------------------------------------------------------

    /**
     * The page is visible on the first frame after the dismissal's commit and on every frame
     * after it. The page sits under the omnibox `visibility: hidden` (`.zen-ntp[data-hidden]`,
     * ContentArea) and comes back the frame the closing begins; a transition on the property –
     * the old reduced-motion rule's `0.01ms` on everything – kept it hidden until the compositor
     * took the transition's start time, 1.0 to 1.3 s on the emulator (#243's runs), and reduced
     * motion now removes the transition rather than shortening it. Frames at `open` are the
     * design's hidden page and are left alone; every other frame must have the page visible, the
     * frame after an `open` one (the commit) named. NOT JUDGED when no frame carried the flag (an
     * older sampler, or no page in the DOM).
     */
    fun pageShows(frames: List<Frame>): Verdict {
        val carried = frames.count { it.pageVisible != null }
        if (carried == 0) return Verdict("the page shows", true, "no frame carried the page's visibility (an older sampler, or no page in the DOM)", judged = false)
        val commit = (1 until frames.size).firstOrNull { frames[it - 1].phase == "open" && frames[it].phase != "open" }
        val commitLine = commit?.let {
            "the commit at ${frames[it].t} ms (${frames[it - 1].phase} -> ${frames[it].phase}): the page ${if (frames[it].pageVisible == true) "visible on its first frame" else "HIDDEN on its first frame"}"
        }
        val hidden = frames.withIndex().filter { (_, f) -> f.pageVisible == false && !(f.phase == "open" && !f.pulled) }
        if (hidden.isEmpty()) {
            return Verdict("the page shows", true, "the page visible on every frame off the omnibox ($carried frame(s) carried the flag)" + (commitLine?.let { "; $it" } ?: ""))
        }
        val first = hidden.first()
        val back = frames.drop(first.index).firstOrNull { it.pageVisible == true }?.t
        return Verdict(
            "the page shows",
            false,
            "${hidden.size} frame(s) with the page hidden off the omnibox; first: frame ${first.index} (${first.value.phase}, ${first.value.t} ms)" +
                (back?.let { ", visible again at $it ms (${it - first.value.t} ms hidden)" } ?: ", never visible again in the sample") +
                (commitLine?.let { "; $it" } ?: "")
        )
    }

    /**
     * No frame draws stale geometry: under reduced motion nothing travels, so every drawn
     * incarnation of the field – the page's own, the omnibox's, the double's – and the sheet hold
     * their boxes from one frame to the next, within [LINE_TOLERANCE]. A shortened transition on
     * a written transform or box (the old rule's `0.01ms`) drew the start value until the
     * compositor started it: a frame at the old pose, then the jump. The keyboard's inset is the
     * one thing that may move a box (the omnibox's field rides it at a bottom dock, the controller
     * a frame behind at most), so a move across a change of the inset, on this pair or the one
     * before, is not a fault. The content frame's scale is 1 on every frame: the recede's gain is
     * 0 under reduced motion (§11.3), the page never receding under a sheet or the omnibox.
     */
    fun steadyGeometry(frames: List<Frame>): Verdict {
        var faults = 0
        var worst: String? = null
        var compared = 0
        var withInset = 0
        for (i in 1 until frames.size) {
            val a = frames[i - 1]
            val b = frames[i]
            val insetMoved = abs(b.insetBottom - a.insetBottom) > 0.5f || (i >= 2 && abs(a.insetBottom - frames[i - 2].insetBottom) > 0.5f)
            val pairs = listOfNotNull(
                if (a.pageFieldDrawn && b.pageFieldDrawn) Triple("the page's field", a.pageField!!.box, b.pageField!!.box) else null,
                if (a.omniDrawn && b.omniDrawn) Triple("the omnibox's field", a.omniField!!.box, b.omniField!!.box) else null,
                if (a.doubleDrawn && b.doubleDrawn) Triple("the double", a.double!!.box, b.double!!.box) else null,
                if (a.sheetLayer?.drawn == true && b.sheetLayer?.drawn == true) Triple("the sheet", a.sheetLayer.box, b.sheetLayer.box) else null
            )
            for ((what, x, y) in pairs) {
                compared++
                if (x.near(y, LINE_TOLERANCE)) continue
                if (insetMoved) {
                    withInset++
                    continue
                }
                faults++
                if (worst == null) worst = "frames ${i - 1}-$i (${b.phase}, ${b.t} ms): $what drawn at $x then at $y with the keyboard's inset unchanged (${b.insetBottom.f()} px)"
            }
        }
        val scaled = frames.filter { abs(it.frameScale - 1f) > 0.005f }
        if (scaled.isNotEmpty()) {
            faults++
            if (worst == null) worst = "${scaled.size} frame(s) with the content frame scaled (${scaled.first().frameScale.p()} at ${scaled.first().t} ms): the page recedes under reduced motion"
        }
        return Verdict(
            "steady geometry",
            faults == 0,
            if (faults == 0) "$compared drawn pair(s) held their boxes within ${LINE_TOLERANCE.f()} px" +
                (if (withInset > 0) " ($withInset moved with the keyboard's inset)" else "") + "; the content frame at scale 1 on every frame"
            else "$faults fault(s); first: $worst"
        )
    }

    /**
     * What the stylesheet resolves to under reduced motion, off the computed styles the sampler
     * carried ([Frame.declared], the sheet's [SheetLayer.declared]): no transition or animation
     * of a duration under 2 ms remains anywhere (the old rule's `0.01ms` and its `1ms` siblings
     * shortened; the rule now removes), every transition that runs names `opacity` alone at
     * [REDUCED_FADE_MS], and every animation that runs is one of the fade keyframes at the same
     * length – §11.3's kept fades, re-declared where they live, and nothing else. Each element's
     * distinct declaration is judged once and the findings list them. NOT JUDGED when no frame
     * carried a declaration (an older sampler).
     */
    fun declaredFades(frames: List<Frame>, fades: Set<String> = FADE_KEYFRAMES): Verdict {
        val seen = LinkedHashMap<Pair<String, Declared>, Int>()
        for (f in frames) {
            for ((name, d) in f.declared) seen[name to d] = (seen[name to d] ?: 0) + 1
            f.sheetLayer?.declared?.let { seen["sheet" to it] = (seen["sheet" to it] ?: 0) + 1 }
        }
        if (seen.isEmpty()) return Verdict("the declarations", true, "no frame carried a declaration (an older sampler)", judged = false)
        val problems = ArrayList<String>()
        val kept = ArrayList<String>()
        for ((key, count) in seen) {
            val (name, d) = key
            val shortened = (d.transitionMs + d.animationMs).filter { it > 0f && it < 2f }
            if (shortened.isNotEmpty()) problems += "$name: a duration of ${shortened.joinToString { "%.2f".format(it) }} ms remains (shortened, not removed) on $count frame(s)"
            if (d.transitions) {
                val properties = d.transitionProperties.filter { it != "none" && it.isNotEmpty() }
                if (properties != listOf("opacity")) problems += "$name: transitions ${properties.joinToString()} (opacity alone is kept) on $count frame(s)"
                else if (d.transitionMs.any { abs(it - REDUCED_FADE_MS) > 2f }) problems += "$name: transitions opacity over ${d.transitionMs.joinToString { it.f() }} ms (${REDUCED_FADE_MS} kept) on $count frame(s)"
                else kept += "$name: transition opacity ${(d.transitionMs.firstOrNull() ?: 0f).f()} ms"
            }
            if (d.animates) {
                val names = d.animationNames.filter { it != "none" && it.isNotEmpty() }
                if (!names.all { it in fades }) problems += "$name: animates ${names.joinToString()} (the fades ${fades.joinToString()} are kept) on $count frame(s)"
                else if (d.animationMs.any { abs(it - REDUCED_FADE_MS) > 2f }) problems += "$name: animates ${names.joinToString()} over ${d.animationMs.joinToString { it.f() }} ms (${REDUCED_FADE_MS} kept) on $count frame(s)"
                else kept += "$name: animation ${names.joinToString()} ${(d.animationMs.firstOrNull() ?: 0f).f()} ms"
            }
        }
        val elements = seen.keys.map { it.first }.distinct()
        return Verdict(
            "the declarations",
            problems.isEmpty(),
            if (problems.isEmpty()) "${elements.size} element(s) (${elements.joinToString()}): nothing shortened, " +
                (if (kept.isEmpty()) "no fade running" else "the kept fades opacity-only at ${REDUCED_FADE_MS} ms: ${kept.distinct().joinToString("; ")}")
            else problems.joinToString("; ")
        )
    }

    /**
     * The sheet under reduced motion stands where the spring jumped it: on every frame it is
     * drawn its box, its translate-y and its scale are those of its first drawn frame (within
     * [LINE_TOLERANCE]; scale 1: nothing above it recedes it) – no frame at the pose before the
     * jump (the stale geometry a shortened transition on the written transform drew) and no
     * travel. A sheet drawn on no frame at all is a fault: the scene never showed it.
     */
    fun sheetInPlace(frames: List<Frame>): Verdict {
        val drawn = frames.filter { it.sheetLayer?.drawn == true }
        if (drawn.isEmpty()) return Verdict("the sheet in place", false, "no frame drew the sheet (${frames.count { it.sheetLayer != null }} frame(s) had one in the DOM)")
        val first = drawn.first().sheetLayer!!
        var faults = 0
        var worst: String? = null
        for (f in drawn) {
            val s = f.sheetLayer!!
            val fault = when {
                !s.box.near(first.box, LINE_TOLERANCE) -> "at ${f.t} ms the sheet is drawn at ${s.box}, its first drawn frame had ${first.box}"
                abs(s.translateY - first.translateY) > LINE_TOLERANCE -> "at ${f.t} ms the sheet's translate-y is ${s.translateY.f()}, its first drawn frame had ${first.translateY.f()}"
                abs(s.scale - 1f) > 0.005f -> "at ${f.t} ms the sheet is scaled ${s.scale.p()}"
                else -> null
            }
            if (fault != null) {
                faults++
                if (worst == null) worst = fault
            }
        }
        return Verdict(
            "the sheet in place",
            faults == 0,
            if (faults == 0) "${drawn.size} drawn frame(s): the sheet at ${first.box}, translate-y ${first.translateY.f()}, scale 1 throughout" else "$faults frame(s) off its place; first: $worst"
        )
    }

    /**
     * The sheet's appearance (`opening`) or departure is the 120 ms opacity fade §11.3 keeps, its
     * scrim's with it: the sheet's opacity ramps one way – up to whole, or down to nothing and
     * out of the DOM – over more than one frame and within [REDUCED_FADE_MAX_MS] on the emulator's
     * clock, and the scrim ends drawn (opening) or gone (closing). The fade is the compositor's
     * to draw: where a sheet frame had an animation [SheetLayer.pending] and no frame part way
     * was seen, or the step fell between two frames at least a fade apart, NOT JUDGED rather than
     * failed; a cut inside a narrower gap, a ramp the wrong way or one longer than the window is
     * failed.
     */
    fun sheetFade(frames: List<Frame>, opening: Boolean): Verdict {
        val check = if (opening) "the sheet's fade in" else "the sheet's fade out"
        val withSheet = frames.filter { it.sheetLayer != null }
        if (withSheet.isEmpty()) return Verdict(check, false, "no frame had a sheet in the DOM")
        val opacities = withSheet.map { it.t to it.sheetLayer!!.opacity }
        val ramp = opacities.filter { it.second > EPS && it.second < 1 - EPS }
        val pending = withSheet.count { it.sheetLayer!!.pending > 0 }
        val problems = ArrayList<String>()
        val unjudged = ArrayList<String>()
        val last = withSheet.last()
        val end = if (opening) last.sheetLayer!!.opacity else if (frames.last().sheetLayer == null) 0f else last.sheetLayer!!.opacity
        if (opening && end < 1 - EPS) problems += "the sheet ended at ${end.p()}, not whole"
        if (!opening && frames.last().sheetLayer != null && end > EPS) problems += "the sheet ended at ${end.p()}, still in the DOM"
        val scrimEnd = last.sheetLayer!!.scrim
        if (opening && scrimEnd < 0.1f) problems += "the scrim ended at ${scrimEnd.p()}, not drawn"
        if (!opening && frames.last().sheetLayer != null && scrimEnd > EPS) problems += "the scrim ended at ${scrimEnd.p()}, still drawn"
        // The step: the last frame with the sheet at its start opacity to the first at its end (closing: or the frame after the sheet left the DOM).
        val left = frames.getOrNull(frames.indexOfLast { it.sheetLayer != null } + 1)
        val stepFrom = if (opening) opacities.lastOrNull { it.second <= EPS } else opacities.lastOrNull { it.second >= 1 - EPS }
        val stepTo = if (opening) opacities.firstOrNull { it.second >= 1 - EPS } else (opacities.firstOrNull { it.second <= EPS } ?: left?.let { it.t to 0f })
        val gap = if (stepFrom != null && stepTo != null && stepTo.first > stepFrom.first) stepTo.first - stepFrom.first else 0
        when {
            ramp.isNotEmpty() -> {
                val span = ramp.last().first - ramp.first().first
                if (span > REDUCED_FADE_MAX_MS) problems += "the fade ran $span ms (about $REDUCED_FADE_MS expected)"
                val steps = opacities.zipWithNext { a, b -> b.second - a.second }
                val against = if (opening) steps.count { it < -0.02f } else steps.count { it > 0.02f }
                if (against > 0) problems += "the sheet's opacity went the wrong way on $against pair(s) of frames"
            }
            pending > 0 -> unjudged += "the fade was still pending on the compositor on $pending of ${withSheet.size} sheet frame(s) and no frame caught it part way"
            gap >= REDUCED_FADE_MS -> unjudged += "the sheet went ${if (opening) "0 -> 1" else "1 -> 0"} between two frames $gap ms apart, wider than the fade"
            gap > 0 -> problems += "the sheet cut ${if (opening) "0 -> 1" else "1 -> 0"} between two frames $gap ms apart with no frame part way"
            else -> problems += "the sheet's opacity never stepped (${opacities.size} frame(s): ${opacities.take(3).joinToString { it.second.p() }}…${opacities.last().second.p()})"
        }
        val judged = unjudged.isEmpty()
        // How the fade was seen: one frame caught part way (its opacity), or several over their span.
        val seen = if (ramp.size == 1) "one frame caught part way (at ${ramp.first().second.p()})"
            else "over ${ramp.size} part-way frames (${ramp.last().first - ramp.first().first} ms)"
        return Verdict(
            check,
            problems.isEmpty(),
            when {
                problems.isNotEmpty() -> (problems + unjudged).joinToString("; ")
                judged -> "the sheet faded ${if (opening) "in to ${end.p()}" else "out and left the DOM"}, $seen, the scrim ${if (opening) "at ${scrimEnd.p()}" else "gone"}"
                else -> "the fade the emulator never drew: " + unjudged.joinToString("; ")
            },
            judged = judged || problems.isNotEmpty()
        )
    }

    /** The keyframe animations §11.3 keeps under reduced motion: fades, and nothing that moves. */
    val FADE_KEYFRAMES: Set<String> = setOf("zen-fade", "zen-fade-in", "zen-fade-out")

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

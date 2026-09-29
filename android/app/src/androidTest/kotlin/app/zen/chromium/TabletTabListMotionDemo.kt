package app.zen.chromium

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Drives the TABLET sidebar's tab list motion (MOT-33; design language v2 §11.1, §11.3, §11.4,
 * §9.37) on the `pixel_tablet` AVD laid out at 1280 x 800 dp, one px per dp
 * (`DEMO_DISPLAY=1280x800@160`, the tablet layout demo's recipe): the seeded Work space (the
 * group Research [Alpha, Beta], the loose Home, Gamma, Delta – [GroupsDemoBase]), every act a
 * real touch on a box read off the chrome's DOM, every outcome read off the DOM or the core:
 *
 *  0. the boot path (P0): the restored rows mount settled – at the earliest read after the
 *     chrome laid the tablet out, no row wears an inline clip, opacity, transition or transform,
 *     no departure's picture stands in the panel and the scroller holds no extent; the first
 *     commit never animates (`SlideMotion.flip`'s `committed` gate, pinned by
 *     `slideLeave.test.ts`'s first-commit cases);
 *  1. GROW: a touch on the New Tab row; the new row mounts clipped shut at its end edge (opacity
 *     0) and opens on SPRING_SNAPPY as the New Tab row glides down from where it stood on the
 *     same spring – its own FLIP (`SlideMotion.follow`), no extent hold on a grow – while the rows
 *     above it stand: a row whose box the commit did not change never moves (§11.4; the list is
 *     read where it stands just before each commit, `SlideSnapshot`, so the chrome's insets
 *     landing after the first paint move nothing at the first grow) – caught one frame in (the
 *     chrome's animation frames held from before the touch and stepped once: the spring's step is
 *     clamped at 64 ms, so the one frame lands at 38 % of the way whatever the emulator's cadence)
 *     for the mid-motion still, then let run to rest, the clip lifted;
 *  2. SHRINK: a touch on a middle row's close; the row's picture stands where the row stood, in
 *     a layer of the scroller's content (`.zen-slide-layer`, `contain: layout`: under the
 *     scroller's fades, scrolling with the rows, no scrollable overflow of its own) as
 *     `.zen-slide-leaving` (no tab id, no test id, no role, `aria-hidden`, `inert`), clipped shut
 *     from its end edge on the same spring as the rows below glide up into the gap (FLIP) and the
 *     scroller's extent runs down with them (a `min-height` floor in whole px, the room the
 *     picture stood in), so the New Tab row rides the extent rather than jumping – caught one
 *     frame in for the still, then let run: the picture and the layer gone at rest, the rows and
 *     the scroller bare, the tab gone from the core;
 *  3. the two again at the emulator's own cadence, traced (`tablet-list-grow`,
 *     `tablet-list-shrink`: the renderer's frames in `frames.jsonl`);
 *  4. FADES: tabs opened off camera until the list overflows its box – the end fade (24 px) comes
 *     on the scroller, the start fade stays off at the top; a real swipe up the list brings the
 *     start fade on; the extra tabs closed off camera, both fades go;
 *  5. LIFT: a real hold on a row (380 ms) lifts it – its ghost stands off the list at scale 1.02
 *     under `--zen-shadow-2` at 90 % (the rise over 120 ms from the row's resting form on a
 *     WebView with `@starting-style`, Chromium 117+); released in place, the row goes back down
 *     and the tab's menu comes up, put away with the system back;
 *  6. REDUCED MOTION where the WebView reflects the system's "remove animations"
 *     (`animator_duration_scale 0` → `prefers-reduced-motion: reduce`): a close fades the row's
 *     picture in place over 120 ms – no clip, no travel, no extent hold – and the rows below take
 *     their places at once (§11.3); skipped with a note where the WebView does not reflect it;
 *  7. the dark scheme: the grow and the shrink once more, caught one frame in, for the dark stills.
 *
 * Findings in `tablet-list-motion-findings.txt`, stills `tablet-list-motion-NN-<state>.png` (the
 * gate's frames `grow-mid-light`, `shrink-mid-light`, `grow-mid-dark`, `shrink-mid-dark` beside the
 * settled `grown-*` / `shrunk-*`, `fade-end`, `fade-both`, `lifted`), the traced scenes in
 * `frames.jsonl`. Driven by `android-tablet-list-motion-demo.yml` and by the nightly sweep's
 * `tablet-webview` shard (`.github/nightly-drivers/tablet-list-motion.json`). See
 * [GroupsDemoBase] and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class TabletTabListMotionDemo : GroupsDemoBase("tablet-list-motion", "tablet-list-motion-demo") {
    override val tag = "TabletTabListMotionDemo"
    override val findingsFile = "tablet-list-motion-findings.txt"
    override val title = "Zenium Android tablet sidebar: the tab list's motion (MOT-33)"

    /** The tabs the driver opened, by scene, so the later scenes know which rows are theirs. */
    private val opened = ArrayList<String>()

    @Test
    fun record() = recordDemo()

    override fun warmUp() {
        ensureForeground()
        head()
        check("the chrome laid the window out as the tablet", awaitJs("document.documentElement.dataset.formFactor==='tablet'", true, 10_000), "form factor ${jsText("document.documentElement.dataset.formFactor")}")
        // The boot path's read comes first: nothing of the driver's has touched the chrome yet.
        bootPath()
        check("the sidebar is docked expanded at 1280 wide", awaitJs("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar==='expanded'", true, 8_000), "data-sidebar ${jsText("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar")}")
        awaitLoaded(HOME, "$ORIGIN/")
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        // Pay for the first layout of a popover menu off camera (the emulator compiles and lays
        // it out slowly the first time): the app menu, opened and closed by the system back.
        touch(domRect(MENU_BUTTON), "the toolbar's menu button")
        if (awaitJs(MENU_OPEN, true, 4_000)) {
            SystemClock.sleep(800)
            back()
            awaitJs(MENU_OPEN, false)
        }
        installFrameHold()
        SystemClock.sleep(1_200)
        finding("warm-up done: ${describeSpace()}; rows ${rowIds()}")
    }

    override fun demo() {
        try {
            grow("light", held = true)
            shrink("light", GAMMA, held = true)
            grow("light", held = false)
            shrink("light", DELTA, held = false)
            fades()
            lift()
            reducedMotion()
            // A named row for the dark shrink's still (the light scenes closed Gamma and Delta):
            // opened off camera, inactive, before the dark grow's row so that one stands below it.
            coreInvoke("tab.create", "{\"url\":${JSONObject.quote("$ORIGIN/gamma.html")},\"active\":false,\"id\":${JSONObject.quote(GAMMA_DARK)}}")
            awaitDom(row(GAMMA_DARK), 3_000)
            dark()
            grow("dark", held = true)
            val ids = rowIds()
            val named = ids.indexOf(GAMMA_DARK).let { it >= 0 && it < ids.size - 1 }
            shrink("dark", if (named) GAMMA_DARK else opened.firstOrNull { tabExists(it) } ?: ALPHA, held = true)
        } finally {
            releaseFrames()
            shellCommand("settings put global animator_duration_scale 1")
            shellCommand("cmd uimode night no")
        }
        SystemClock.sleep(1_000)
        still("end")
        tail()
    }

    // --- 0. the boot path ------------------------------------------------------------------------

    private fun bootPath() {
        section("0. The boot path (P0): the restored rows mount settled")
        // The first poll that finds the rows: a row that grew in would still wear its clip here.
        awaitUntil(8_000) { rowIds().size >= 5 }
        val rows = rowIds()
        val marked = jsArray(
            "Array.prototype.filter.call(document.querySelectorAll(${JSONObject.quote(ROWS)}),function(r){" +
                "return r.style.clipPath!==''||r.style.opacity!==''||r.style.transition!==''||r.style.transform!==''}).map(function(r){return r.dataset.tabId})"
        ).strings()
        check("the restored rows are there at the first read", rows.size >= 5, "rows $rows")
        check("no restored row wears an inline clip, opacity, transition or transform", marked.isEmpty(), "marked $marked")
        check("no departure's picture or layer stands in the scroller", !inDom(PICTURE) && !inDom(LAYER), "pictures ${jsText("document.querySelectorAll(${JSONObject.quote(PICTURE)}).length")}, layer ${inDom(LAYER)}")
        check("the scroller holds no extent", scrollerFloor().isEmpty(), "min-height '${scrollerFloor()}'")
        check("the New Tab row wears no transform", translationOf(NEW_TAB_ROW) == null, "transform '${rowStyle(NEW_TAB_ROW, "transform")}'")
    }

    // --- 1 and 3. the grow -------------------------------------------------------------------------

    /**
     * A touch on the New Tab row: the new row grows into its slot. `held`, the chrome's frames are
     * held from before the touch and stepped once for the mid-motion still; otherwise the scene
     * runs at the emulator's cadence inside a traced block.
     */
    private fun grow(scheme: String, held: Boolean) {
        section(if (held) "${if (scheme == "dark") "7" else "1"}. GROW ($scheme): the new row opens from its end edge, one frame in" else "3a. GROW at the emulator's cadence, traced")
        val before = rowIds()
        val foot = steadyRect { domRect(NEW_TAB_ROW) }
        check("the New Tab row stands under the list", foot != null, "foot $foot")
        val took = { rowIds().size == before.size + 1 }
        if (held) {
            holdFrames()
            val touched = touch(foot, "the New Tab row") != null && awaitUntil(5_000, took)
            check("the touch on the New Tab row opens a tab", touched, "rows ${rowIds().size}, before ${before.size}")
            val id = rowIds().firstOrNull { it !in before }
            if (!touched || id == null) {
                releaseFrames()
                return
            }
            opened += id
            val row = row(id)
            val size = jsNumber("(function(){var e=document.querySelector(${JSONObject.quote(row)});return e?e.getBoundingClientRect().height:0})()")
            check("the new row mounts clipped shut at its end edge, at opacity 0", hiddenOf(row) >= size - 0.5 && rowStyle(row, "opacity") == "0", "clip-path '${rowStyle(row, "clipPath")}', opacity '${rowStyle(row, "opacity")}', height $size")
            // The rows already in the list: their boxes did not change, so they wear nothing –
            // whatever moved the chrome under them since the last commit (the insets after the
            // first paint) was read before this one.
            val moved = before.mapNotNull { r -> translationOf(row(r))?.let { r to it } }
            check("the rows above the new one stand: no row whose box did not change wears a transform at the commit", moved.isEmpty(), "translateY ${moved.map { "${titleOf(it.first)} ${"%.1f".format(it.second)}" }}")
            // The New Tab row is laid out one pitch lower and drawn back up where it stood: its
            // own FLIP, on the spring; nothing is held (a grow has no extent hold).
            val footAt = translationOf(NEW_TAB_ROW)
            val footCommit = domRect(NEW_TAB_ROW)
            check("the New Tab row is drawn where it stood at the commit, by its own translation", footAt != null && abs(footAt + PITCH) <= 1 && foot != null && footCommit != null && abs(footCommit.top - foot.top) <= 1, "translateY $footAt, foot ${foot?.top} -> ${footCommit?.top}")
            check("no extent is held on a grow", scrollerFloor().isEmpty(), "min-height '${scrollerFloor()}'")
            SystemClock.sleep(150)
            val ran = stepFrame()
            val hidden = hiddenOf(row)
            val ratio = if (size > 0) hidden / size else Double.NaN
            val opacity = rowStyle(row, "opacity").toDoubleOrNull() ?: Double.NaN
            check("one frame in (the 64 ms step) the row shows 38 % of its height at the same part of its opacity", ran > 0 && ratio > 0.52 && ratio < 0.72 && abs(opacity - (1 - ratio)) < 0.05, "callbacks $ran, hidden ${"%.1f".format(hidden)} of $size (${"%.0f".format(ratio * 100)} % hidden), opacity $opacity")
            check("the row's own transition is held off while the spring runs", rowStyle(row, "transition") == "none" && rowStyle(row, "willChange").contains("clip-path"), "transition '${rowStyle(row, "transition")}', will-change '${rowStyle(row, "willChange")}'")
            val movedHeld = before.mapNotNull { r -> translationOf(row(r))?.let { r to it } }
            check("one frame in the rows above still stand", movedHeld.isEmpty(), "translateY ${movedHeld.map { "${titleOf(it.first)} ${"%.1f".format(it.second)}" }}")
            val footGlide = translationOf(NEW_TAB_ROW)
            val footHeld = domRect(NEW_TAB_ROW)
            check("one frame in the New Tab row has come down the same part of its pitch as the row has opened", footGlide != null && abs(footGlide + PITCH * ratio) <= 3, "translateY $footGlide, expected ${"%.1f".format(-PITCH * ratio)}; foot ${foot?.top} -> ${footHeld?.top}")
            finding("  ${awaitChromePaint()}")
            still("grow-mid-$scheme")
            releaseFrames()
            check("at rest the clip lifts and the row is drawn as it is", awaitJs("(function(){var e=document.querySelector(${JSONObject.quote(row)});return !!e&&e.style.clipPath===''&&e.style.opacity===''&&e.style.transition===''})()", true, 4_000), "clip-path '${rowStyle(row, "clipPath")}', opacity '${rowStyle(row, "opacity")}'")
            check("at rest the New Tab row is bare", awaitJs("(function(){var e=document.querySelector(${JSONObject.quote(NEW_TAB_ROW)});return !!e&&e.style.transform===''})()", true, 3_000), "transform '${rowStyle(NEW_TAB_ROW, "transform")}'")
            val footAfter = domRect(NEW_TAB_ROW)
            check("the New Tab row stands one pitch lower", foot != null && footAfter != null && abs((footAfter.top - foot.top) - PITCH) <= 2, "foot ${foot?.top} -> ${footHeld?.top} (held) -> ${footAfter?.top}")
            SystemClock.sleep(600)
            still("grown-$scheme")
            return
        }
        var touched = false
        traceFrames("tablet-list-grow", JankBudget.Kind.SPRING) {
            touched = touch(foot, "the New Tab row") != null && awaitUntil(5_000, took)
            SystemClock.sleep(SPRING_MS)
        }
        check("the touch on the New Tab row opens a tab (traced)", touched, "rows ${rowIds().size}, before ${before.size}")
        val id = rowIds().firstOrNull { it !in before } ?: return
        opened += id
        check("the traced row rests drawn whole", awaitJs("(function(){var e=document.querySelector(${JSONObject.quote(row(id))});return !!e&&e.style.clipPath===''&&e.style.opacity===''})()", true, 4_000), "clip-path '${rowStyle(row(id), "clipPath")}'")
        val footAfter = domRect(NEW_TAB_ROW)
        check("the traced New Tab row rests bare, one pitch lower", awaitJs("(function(){var e=document.querySelector(${JSONObject.quote(NEW_TAB_ROW)});return !!e&&e.style.transform===''})()", true, 3_000) && foot != null && footAfter != null && abs((footAfter.top - foot.top) - PITCH) <= 2, "transform '${rowStyle(NEW_TAB_ROW, "transform")}', foot ${foot?.top} -> ${footAfter?.top}")
    }

    // --- 2 and 3. the shrink ----------------------------------------------------------------------

    /**
     * A touch on the close of the row `tabId` (a middle row, with rows below it): the row's
     * picture shrinks out of its slot as the rows below glide up and the scroller's extent
     * follows. `held` as [grow].
     */
    private fun shrink(scheme: String, tabId: String, held: Boolean) {
        section(if (held) "${if (scheme == "dark") "7b" else "2"}. SHRINK ($scheme): the closed row shrinks out of its slot as the rows below glide, one frame in" else "3b. SHRINK at the emulator's cadence, traced")
        val ids = rowIds()
        val at = ids.indexOf(tabId)
        check("the row to close is in the list with rows below it", at >= 0 && at < ids.size - 1, "rows $ids, closing $tabId")
        if (at < 0) return
        val below = ids.drop(at + 1)
        val rowBox = steadyRect { domRect(row(tabId)) }
        val belowBefore = below.associateWith { domRect(row(it)) }
        val foot = domRect(NEW_TAB_ROW)
        val extentBefore = scrollerHeight()
        val close = domRect("${row(tabId)} .zen-tab-close")
        check("the row's close stands on the row's end column, 44 square", close != null && rowBox != null && abs(close.height() - 44) <= 1 && abs(close.width() - 44) <= 1 && close.right <= rowBox.right + 1, "close $close, row $rowBox")
        val took = { !inDom(row(tabId)) }
        if (held) {
            holdFrames()
            val touched = touch(close, "the close of ${titleOf(tabId)}'s row") != null && awaitUntil(5_000, took)
            check("the touch on the close takes the row out of the list", touched, "row present ${inDom(row(tabId))}")
            if (!touched) {
                releaseFrames()
                return
            }
            val picture = domRect(PICTURE)
            check("the row's picture stands in the scroller where the row stood", picture != null && rowBox != null && abs(picture.top - rowBox.top) <= 1 && abs(picture.left - rowBox.left) <= 1 && abs(picture.height() - rowBox.height()) <= 1 && abs(picture.width() - rowBox.width()) <= 1, "picture $picture, row $rowBox")
            // The seat: the scroller's own layer, laid out at nothing and containing its layout,
            // so the picture lies under the scroller's fades and scrolls with the rows while its
            // box is ink, not scrollable overflow of the scroller's.
            check("the picture is seated in the scroller's layer: a child of the scroller, contain: layout, hidden from readers", jsBoolean("(function(){var p=document.querySelector(${JSONObject.quote(PICTURE)});var l=p&&p.parentElement;var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!l&&!!s&&l.parentElement===s&&getComputedStyle(l).contain.indexOf('layout')>=0&&l.getAttribute('aria-hidden')==='true'})()"), "layer ${layerText()}")
            check("the picture is a picture: no tab id, no test id, no role, hidden from readers and inert", jsBoolean("(function(){var p=document.querySelector(${JSONObject.quote(PICTURE)});return !!p&&!p.hasAttribute('data-tab-id')&&!p.hasAttribute('data-testid')&&!p.hasAttribute('role')&&p.getAttribute('aria-hidden')==='true'&&p.hasAttribute('inert')})()"), "")
            val floor0 = scrollerFloor()
            check("the scroller's extent is held where it was at the commit", floor0.isNotEmpty() && abs(floor0.removeSuffix("px").toDouble() - extentBefore) <= 1, "min-height '$floor0', extent before $extentBefore")
            check("the picture's box is no overflow of the held scroller: nothing to scroll, the end fade off", !overflows() && fadeOf("end") == 0.0, "${scrollerText()}; end fade ${fadeOf("end")}")
            // The New Tab row is laid out one pitch up and held back where it stood by the
            // scroller's extent alone: the hold's glide is its glide, no translation of its own.
            val footCommit = domRect(NEW_TAB_ROW)
            check("the New Tab row rides the hold at the commit: no translation of its own, standing where it stood", translationOf(NEW_TAB_ROW) == null && foot != null && footCommit != null && abs(footCommit.top - foot.top) <= 1, "transform '${rowStyle(NEW_TAB_ROW, "transform")}', foot ${foot?.top} -> ${footCommit?.top}")
            SystemClock.sleep(150)
            val ran = stepFrame()
            val size = rowBox?.height()?.toDouble() ?: 44.0
            val hidden = hiddenOf(PICTURE)
            val ratio = hidden / size
            check("one frame in the picture is 38 % shut from its end edge", ran > 0 && ratio > 0.28 && ratio < 0.48, "callbacks $ran, hidden ${"%.1f".format(hidden)} of $size (${"%.0f".format(ratio * 100)} %)")
            // The rows below are laid out one pitch up already and drawn back down by the part of
            // the gap still to close: their translation and the picture's end edge move as one.
            val glides = below.mapNotNull { id -> translationOf(row(id))?.let { id to it } }
            val expected = (size + GAP) * (1 - ratio)
            check("the rows below glide up on the same frame by the same part of the gap", glides.size == below.size && glides.all { (_, y) -> abs(y - expected) <= 3 }, "translateY ${glides.map { "${titleOf(it.first)} ${"%.1f".format(it.second)}" }}, expected ${"%.1f".format(expected)}")
            val floor1 = scrollerFloor()
            val floorPx = floor1.removeSuffix("px").toDoubleOrNull()
            check("the scroller's extent runs down with them, in whole px", floorPx != null && floorPx == floorPx.roundToInt().toDouble() && floorPx < extentBefore && floorPx > extentBefore - size - GAP, "min-height '$floor1', extent before $extentBefore")
            check("one frame in the held scroller still has nothing to scroll, the end fade off", !overflows() && fadeOf("end") == 0.0, "${scrollerText()}; end fade ${fadeOf("end")}")
            val footHeld = domRect(NEW_TAB_ROW)
            check("the New Tab row glides with the extent rather than jumping, wearing no translation", translationOf(NEW_TAB_ROW) == null && foot != null && footHeld != null && footHeld.top < foot.top - 2 && footHeld.top > foot.top - size - GAP + 2, "transform '${rowStyle(NEW_TAB_ROW, "transform")}', foot ${foot?.top} -> ${footHeld?.top}")
            finding("  ${awaitChromePaint()}")
            still("shrink-mid-$scheme")
            releaseFrames()
            check("at rest the picture is gone", awaitDomGone(PICTURE, 4_000), "pictures ${jsText("document.querySelectorAll(${JSONObject.quote(PICTURE)}).length")}")
            check("the layer goes with the last picture: the scroller's children are its rows' again", awaitDomGone(LAYER, 2_000), "layer ${layerText()}")
            check("the rows below rest in their slots, one pitch up, bare", awaitJs(below.joinToString("&&") { "(function(){var e=document.querySelector(${JSONObject.quote(row(it))});return !!e&&e.style.transform===''})()" }, true, 3_000) && below.all { id -> val was = belowBefore[id]; val now = domRect(row(id)); was != null && now != null && abs((was.top - now.top) - (size + GAP)) <= 2 }, "tops ${below.map { "${titleOf(it)} ${belowBefore[it]?.top} -> ${domRect(row(it))?.top}" }}")
            check("the scroller's floor is gone at rest", awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.style.minHeight===''})()", true, 3_000), "min-height '${scrollerFloor()}'")
            check("the tab is gone from the core", awaitCore { !tabExists(tabId, it) }, "exists ${tabExists(tabId)}")
            SystemClock.sleep(600)
            still("shrunk-$scheme")
            return
        }
        var touched = false
        traceFrames("tablet-list-shrink", JankBudget.Kind.SPRING) {
            touched = touch(close, "the close of ${titleOf(tabId)}'s row") != null && awaitUntil(5_000, took)
            SystemClock.sleep(SPRING_MS)
        }
        check("the touch on the close takes the row out of the list (traced)", touched, "row present ${inDom(row(tabId))}")
        check("the traced departure rests with no picture or layer left and the rows bare", awaitDomGone(PICTURE, 4_000) && awaitDomGone(LAYER, 2_000) && awaitJs(below.joinToString("&&") { "(function(){var e=document.querySelector(${JSONObject.quote(row(it))});return !e||e.style.transform===''})()" }, true, 3_000), "pictures ${jsText("document.querySelectorAll(${JSONObject.quote(PICTURE)}).length")}, layer ${layerText()}")
        check("the tab is gone from the core (traced)", awaitCore { !tabExists(tabId, it) }, "exists ${tabExists(tabId)}")
    }

    // --- 4. the fades ------------------------------------------------------------------------------

    private fun fades() {
        section("4. FADES: the end fade as the rows overflow the box, the start fade once scrolled")
        check("a list that fits has no fade", fadeOf("start") == 0.0 && fadeOf("end") == 0.0, "start ${fadeOf("start")}, end ${fadeOf("end")}")
        val extra = ArrayList<String>()
        var n = 0
        while (n < MAX_EXTRA && !overflows()) {
            n++
            val id = "tab_fade_$n"
            coreInvoke("tab.create", "{\"url\":${JSONObject.quote("$ORIGIN/gamma.html")},\"active\":false,\"id\":${JSONObject.quote(id)}}")
            extra += id
            awaitDom(row(id), 3_000)
            SystemClock.sleep(120)
        }
        awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollHeight-s.clientHeight>1})()", true, 3_000)
        SystemClock.sleep(900)
        finding("  ${extra.size} tabs opened off camera; the scroller ${scrollerText()}")
        check("the list overflows its box", overflows(), scrollerText())
        check("the end fade comes on the scroller at 24, the start fade stays off at the top", awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.style.getPropertyValue('--zen-fade-end')==='24px'&&s.style.getPropertyValue('--zen-fade-start')==='0px'})()", true, 3_000), "start ${fadeOf("start")}, end ${fadeOf("end")}")
        check("the fade is the scroller's mask along y", attrOf(SCROLLER, "data-fade-axis") == "y" && jsText("getComputedStyle(document.querySelector(${JSONObject.quote(SCROLLER)})).maskImage||getComputedStyle(document.querySelector(${JSONObject.quote(SCROLLER)})).webkitMaskImage").contains("gradient"), "axis '${attrOf(SCROLLER, "data-fade-axis")}'")
        SystemClock.sleep(400)
        still("fade-end-light")
        val list = domRect(SCROLLER)
        val target = screen(list)?.let { touchPoint(it) }
        if (target == null) {
            check("the list is on screen to swipe", false, "list $list")
        } else {
            finding("  swipe up from ${target.x.roundToInt()},${target.y.roundToInt()} on the list")
            val f = Finger()
            f.down(target.x, target.y + 120)
            f.moveBy(0f, -260f, 320)
            f.up()
            check("the swipe scrolls the list", awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollTop>1})()", true, 3_000), scrollerText())
            check("the start fade comes on once scrolled", awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.style.getPropertyValue('--zen-fade-start')==='24px'})()", true, 3_000), "start ${fadeOf("start")}, end ${fadeOf("end")}")
            SystemClock.sleep(700)
            still("fade-both-light")
        }
        coreInvoke("tab.closeMany", "{\"tabIds\":[${extra.joinToString(",") { JSONObject.quote(it) }}]}")
        check("the extra tabs close off camera", awaitCore(12_000) { state -> extra.none { tabExists(it, state) } } && awaitUntil(6_000) { extra.none { inDom(row(it)) } }, "left ${extra.filter { inDom(row(it)) }}")
        check("the list settles with no picture or layer left", awaitDomGone(PICTURE, 4_000) && awaitDomGone(LAYER, 2_000), "pictures ${jsText("document.querySelectorAll(${JSONObject.quote(PICTURE)}).length")}, layer ${layerText()}")
        check("both fades go as the list fits again", awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.style.getPropertyValue('--zen-fade-end')==='0px'&&s.style.getPropertyValue('--zen-fade-start')==='0px'})()", true, 4_000), "start ${fadeOf("start")}, end ${fadeOf("end")}; ${scrollerText()}")
        SystemClock.sleep(600)
        still("fades-off")
    }

    // --- 5. the lift -------------------------------------------------------------------------------

    private fun lift() {
        section("5. LIFT: a hold on a row lifts it – the ghost at scale 1.02 under the level-2 shadow")
        val id = rowIds().firstOrNull { it != activeTabId() } ?: rowIds().firstOrNull()
        if (id == null) {
            check("a row is there to hold", false, "rows ${rowIds()}")
            return
        }
        val box = steadyRect { domRect(row(id)) }
        val target = screen(box)?.let { touchPoint(it) }
        if (target == null) {
            check("the row is on screen to hold", false, "row $box")
            return
        }
        finding("  hold at ${target.x.roundToInt()},${target.y.roundToInt()} on ${titleOf(id)}'s row")
        val f = Finger()
        f.press(target.x, target.y)
        val ghost = awaitRect(3_000) { domRect(GHOST) }
        check("the hold lifts the row: its ghost stands off the list", ghost != null && inDom("${row(id)}[data-lifted]"), "ghost $ghost, lifted ${inDom("${row(id)}[data-lifted]")}")
        SystemClock.sleep(400)
        val transform = jsText("(function(){var g=document.querySelector(${JSONObject.quote(GHOST)});return g?getComputedStyle(g).transform:''})()")
        val shadow = jsText("(function(){var g=document.querySelector(${JSONObject.quote(GHOST)});return g?getComputedStyle(g).boxShadow:''})()")
        val opacity = jsNumber("(function(){var g=document.querySelector(${JSONObject.quote(GHOST)});return g?getComputedStyle(g).opacity:NaN})()")
        check("the ghost is at scale 1.02", transform.startsWith("matrix(1.02, 0, 0, 1.02"), "transform '$transform'")
        check("the ghost casts the level-2 shadow at 90 %", shadow.isNotEmpty() && shadow != "none" && abs(opacity - 0.9) < 0.02, "box-shadow '$shadow', opacity $opacity")
        check("the lift's rise is a 120 ms transition of the ghost's transform, opacity and shadow", jsText("(function(){var g=document.querySelector(${JSONObject.quote(GHOST)});return g?getComputedStyle(g).transitionProperty+' '+getComputedStyle(g).transitionDuration:''})()").let { it.contains("box-shadow") && it.contains("0.12s") }, "'${jsText("(function(){var g=document.querySelector(${JSONObject.quote(GHOST)});return g?getComputedStyle(g).transitionProperty+' '+getComputedStyle(g).transitionDuration:''})()")}'")
        finding("  ${awaitChromePaint()}")
        still("lifted")
        f.up()
        check("released in place, the row goes back down and its menu comes up", awaitDomGone(GHOST, 3_000) && awaitJs(MENU_OPEN, true, 3_000), "ghost ${inDom(GHOST)}, menu ${jsText(MENU_OPEN)}")
        SystemClock.sleep(600)
        back()
        awaitJs(MENU_OPEN, false, 3_000)
        SystemClock.sleep(500)
    }

    // --- 6. reduced motion -------------------------------------------------------------------------

    private fun reducedMotion() {
        section("6. REDUCED MOTION: a close fades the picture in place, nothing travels")
        shellCommand("settings put global animator_duration_scale 0")
        val reflected = awaitJs("matchMedia('(prefers-reduced-motion: reduce)').matches", true, 4_000)
        if (!reflected) {
            finding("  (this WebView does not reflect animator_duration_scale 0 as prefers-reduced-motion: the reduced path is pinned by slideLeave.test.ts; scene skipped)")
            shellCommand("settings put global animator_duration_scale 1")
            return
        }
        val tabId = opened.lastOrNull { tabExists(it) && it != activeTabId() } ?: rowIds().lastOrNull { it != activeTabId() }
        if (tabId == null) {
            check("a row is there to close under reduced motion", false, "rows ${rowIds()}")
            shellCommand("settings put global animator_duration_scale 1")
            return
        }
        val ids = rowIds()
        val below = ids.drop(ids.indexOf(tabId) + 1)
        val close = domRect("${row(tabId)} .zen-tab-close")
        val foot = domRect(NEW_TAB_ROW)
        holdFrames()
        val touched = touch(close, "the close of ${titleOf(tabId)}'s row (reduced motion)") != null && awaitUntil(5_000) { !inDom(row(tabId)) }
        check("the touch on the close takes the row out of the list (reduced motion)", touched, "row present ${inDom(row(tabId))}")
        if (touched) {
            check("the picture stands in place in the scroller's layer with no clip, fading", inDom(PICTURE) && rowStyle(PICTURE, "clipPath") == "" && rowStyle(PICTURE, "opacity").toDoubleOrNull() == 1.0, "clip-path '${rowStyle(PICTURE, "clipPath")}', opacity '${rowStyle(PICTURE, "opacity")}', layer ${layerText()}")
            check("the rows below take their places at once, nothing travels", below.all { !inDom(row(it)) || translationOf(row(it)) == null }, "translateY ${below.map { translationOf(row(it)) }}")
            check("the scroller's extent is not held", scrollerFloor().isEmpty(), "min-height '${scrollerFloor()}'")
            val footNow = domRect(NEW_TAB_ROW)
            check("the New Tab row cuts to its place one pitch up, no translation", translationOf(NEW_TAB_ROW) == null && foot != null && footNow != null && abs((foot.top - footNow.top) - PITCH) <= 2, "transform '${rowStyle(NEW_TAB_ROW, "transform")}', foot ${foot?.top} -> ${footNow?.top}")
            SystemClock.sleep(200)
            stepFrame()
            check("one frame past 120 ms the fade is over and the picture gone with its layer", awaitDomGone(PICTURE, 2_000) && awaitDomGone(LAYER, 2_000), "opacity '${rowStyle(PICTURE, "opacity")}', layer ${layerText()}")
        }
        releaseFrames()
        shellCommand("settings put global animator_duration_scale 1")
        check("the preference goes with the setting", awaitJs("matchMedia('(prefers-reduced-motion: reduce)').matches", false, 4_000), "")
        SystemClock.sleep(500)
    }

    // --- the scheme -----------------------------------------------------------------------------------

    private fun dark() {
        ensureForeground()
        shellCommand("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(4_000)
        ensureForeground()
        finding("  the chrome's scheme now: ${jsText("document.documentElement.getAttribute('data-theme')||'light'")}")
    }

    // --- the frame hold -----------------------------------------------------------------------------

    /**
     * Put the chrome's `requestAnimationFrame` under the driver's hand: held, a callback asked for
     * is queued rather than run, and [stepFrame] runs the queue once with the clock's time – for
     * a spring (`SpringAnimation.tick`) one step clamped at 64 ms, the same frame whatever the
     * emulator's cadence – while the DOM between steps stands for a still; [releaseFrames] hands
     * the queue back to the browser's own frames. The bridge, React's commits and the core's state
     * run on no animation frame, so a touch under the hold lands as it would.
     */
    private fun installFrameHold(): Boolean = jsBoolean(
        "(function(){if(window.__demoFrames)return true;" +
            "var real=window.requestAnimationFrame.bind(window),realCancel=window.cancelAnimationFrame.bind(window);" +
            "var q=[],next=1e9,held=false,mapped={};" +
            "window.requestAnimationFrame=function(cb){if(!held)return real(cb);var id=next++;q.push({id:id,cb:cb});return id};" +
            "window.cancelAnimationFrame=function(id){if(id>=1e9){q=q.filter(function(e){return e.id!==id});if(mapped[id]!==undefined){realCancel(mapped[id]);delete mapped[id]}return}realCancel(id)};" +
            "window.__demoFrames={" +
            "hold:function(){held=true},held:function(){return held},pending:function(){return q.length}," +
            "step:function(){var run=q;q=[];var now=performance.now();for(var i=0;i<run.length;i++){try{run[i].cb(now)}catch(e){}}return run.length}," +
            "release:function(){held=false;var run=q;q=[];for(var i=0;i<run.length;i++){mapped[run[i].id]=real(run[i].cb)}return run.length}};" +
            "return true})()"
    )

    private fun holdFrames() {
        installFrameHold()
        chromeJs("window.__demoFrames.hold()")
    }

    /** Run the held frame callbacks once, now; how many ran. */
    private fun stepFrame(): Int = jsNumber("window.__demoFrames?window.__demoFrames.step():0").toInt()

    /** Hand the frames back to the browser; how many callbacks were waiting. */
    private fun releaseFrames(): Int = jsNumber("window.__demoFrames?window.__demoFrames.release():0").toInt()

    // --- reads of the list ----------------------------------------------------------------------------

    private fun rowIds(): List<String> =
        jsArray("Array.prototype.map.call(document.querySelectorAll(${JSONObject.quote(ROWS)}),function(r){return r.dataset.tabId})").strings()

    private fun rowStyle(selector: String, prop: String): String =
        jsText("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?e.style[${JSONObject.quote(prop)}]:''})()")

    /**
     * The px clipped off the element's end edge by its inline `clip-path: inset(0 0 <px> 0)`; 0
     * when none. Blink serialises the four-value inset it was given as the three-value
     * `inset(0px 0px <px>px)` (the left edge the same as the right, so the fourth value is
     * dropped), so both forms are read.
     */
    private fun hiddenOf(selector: String): Double {
        val clip = rowStyle(selector, "clipPath")
        val m = Regex("""inset\(0(?:px)? 0(?:px)? ([0-9.]+)px(?: 0(?:px)?)?\)""").find(clip) ?: return 0.0
        return m.groupValues[1].toDoubleOrNull() ?: 0.0
    }

    /** The element's inline `translateY`, in px; null when it wears none. */
    private fun translationOf(selector: String): Double? {
        val t = rowStyle(selector, "transform")
        val m = Regex("""translateY\((-?[0-9.]+)px\)""").find(t) ?: return null
        return m.groupValues[1].toDoubleOrNull()
    }

    private fun scrollerFloor(): String = rowStyle(SCROLLER, "minHeight")

    private fun scrollerHeight(): Double =
        jsNumber("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return s?s.getBoundingClientRect().height:0})()")

    private fun overflows(): Boolean =
        jsBoolean("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollHeight-s.clientHeight>1})()")

    private fun scrollerText(): String =
        jsText("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return s?('client '+s.clientHeight+', scroll '+s.scrollHeight+', top '+s.scrollTop):'no scroller'})()")

    /** The departures' layer as it stands: its parent, its containment and its pictures; or none. */
    private fun layerText(): String =
        jsText("(function(){var l=document.querySelector(${JSONObject.quote(LAYER)});if(!l)return 'none';var p=l.parentElement;return (p&&p.hasAttribute('data-tab-scroller')?'in the scroller':'in '+(p?p.className:'nothing'))+', contain '+getComputedStyle(l).contain+', '+l.children.length+' picture(s)'})()")

    private fun fadeOf(edge: String): Double =
        jsNumber("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return s?parseFloat(s.style.getPropertyValue('--zen-fade-$edge')||'0'):NaN})()")

    private fun titleOf(tabId: String): String =
        runCatching { coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("title") }.getOrNull()?.takeIf { it.isNotEmpty() } ?: tabId

    private companion object {
        /** The rows' pitch: the 44 row and the list's 2 px gap (`gap-0.5`). */
        private const val GAP = 2.0
        private const val PITCH = 46.0
        /** How long the snappy spring is given inside a traced block (it lands well within). */
        private const val SPRING_MS = 900L
        private const val MAX_EXTRA = 18
        /** The named row the dark shrink closes, opened off camera after the light scenes. */
        private const val GAMMA_DARK = "tab_gamma_dark"
        private const val CHROME_ROOT = "[data-testid=\"chrome-root\"]"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        private const val MENU_BUTTON = ".zen-tablet-toolbar [data-zen-nav-row] > button[aria-haspopup=\"menu\"]"
        private const val PANEL = "$SIDEBAR [data-tab-panel][data-active=\"true\"]"
        private const val SCROLLER = "$PANEL > [data-tab-scroller]"
        private const val ROWS = "$SCROLLER .zen-tab[data-tab-id]"
        private const val NEW_TAB_ROW = "$PANEL [data-new-tab]"
        /** The departures' layer: a child of the scroller's content, laid out at nothing. */
        private const val LAYER = "$SCROLLER > .zen-slide-layer"
        private const val PICTURE = "$LAYER > .zen-slide-leaving"
        private const val GHOST = ".zen-tab-ghost .zen-tab-ghost-row"

        private fun row(tabId: String) = "$SIDEBAR .zen-tab[data-tab-id=\"$tabId\"]"
    }
}

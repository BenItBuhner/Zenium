package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CapturePlanTest {
    /** A Pixel-6-like phone page: 411 CSS px wide viewport at density 2.625, a 3000 px tall document. */
    private val phone = PageMetrics(
        scrollX = 0.0, scrollY = 0.0,
        pageLeft = 0.0, pageTop = 0.0,
        viewportWidth = 411.0, viewportHeight = 700.0,
        documentWidth = 411.0, documentHeight = 3000.0
    )
    private val viewWidthPx = 1080

    @Test
    fun deviceScaleComesFromTheVisualViewport() {
        assertEquals(1080.0 / 411.0, CapturePlan.deviceScale(viewWidthPx, phone, 2.0), 1e-9)
        // A desktop-layout page shown in overview mode: 980 CSS px squeezed into the same 1080 px.
        val overview = phone.copy(viewportWidth = 980.0, documentWidth = 980.0)
        assertEquals(1080.0 / 980.0, CapturePlan.deviceScale(viewWidthPx, overview, 2.0), 1e-9)
        // Without a usable viewport the density is the best guess.
        assertEquals(2.0, CapturePlan.deviceScale(0, phone, 2.0), 0.0)
    }

    @Test
    fun viewportTargetIsWhatIsOnScreen() {
        val scrolled = phone.copy(scrollY = 1200.0, pageTop = 1200.0)
        assertEquals(Box(0.0, 1200.0, 411.0, 700.0), CapturePlan.target(CapturePlan.MODE_VIEWPORT, null, scrolled))
    }

    @Test
    fun fullPageTargetIsTheDocumentCutAtTheHeightLimit() {
        assertEquals(Box(0.0, 0.0, 411.0, 3000.0), CapturePlan.target(CapturePlan.MODE_FULL_PAGE, null, phone))
        val endless = phone.copy(documentHeight = 50_000.0)
        assertEquals(
            Box(0.0, 0.0, 411.0, CapturePlan.MAX_PAGE_HEIGHT),
            CapturePlan.target(CapturePlan.MODE_FULL_PAGE, null, endless)
        )
        // A document narrower than the viewport still fills the viewport width.
        val narrow = phone.copy(documentWidth = 300.0, documentHeight = 200.0)
        assertEquals(Box(0.0, 0.0, 411.0, 700.0), CapturePlan.target(CapturePlan.MODE_FULL_PAGE, null, narrow))
    }

    @Test
    fun regionTargetIsClampedToTheDocument() {
        val region = Box(-10.0, 2900.0, 300.0, 400.0)
        assertEquals(Box(0.0, 2900.0, 290.0, 100.0), CapturePlan.target(CapturePlan.MODE_REGION, region, phone))
        assertNull(CapturePlan.target(CapturePlan.MODE_REGION, Box(0.0, 5000.0, 10.0, 10.0), phone))
        assertNull(CapturePlan.target(CapturePlan.MODE_REGION, null, phone))
    }

    @Test
    fun outputScaleKeepsViewportAndRegionsNativeButCapsFullPages() {
        val s = CapturePlan.deviceScale(viewWidthPx, phone, 2.0)
        assertEquals(s, CapturePlan.outputScale(CapturePlan.MODE_VIEWPORT, Box(0.0, 0.0, 411.0, 700.0), s), 1e-9)
        assertEquals(s, CapturePlan.outputScale(CapturePlan.MODE_REGION, Box(0.0, 0.0, 100.0, 40.0), s), 1e-9)
        // A region longer than the side cap comes out downscaled to fit.
        val tall = Box(0.0, 0.0, 411.0, 2000.0)
        assertEquals(CapturePlan.MAX_SIDE / 2000.0, CapturePlan.outputScale(CapturePlan.MODE_REGION, tall, s), 1e-9)
        // Full pages: never sharper than 2× and never taller than the pixel cap.
        val full = Box(0.0, 0.0, 411.0, 3000.0)
        assertEquals(CapturePlan.FULL_PAGE_MAX_SCALE, CapturePlan.outputScale(CapturePlan.MODE_FULL_PAGE, full, s), 1e-9)
        val long = Box(0.0, 0.0, 411.0, 12_000.0)
        assertEquals(CapturePlan.MAX_FULL_PAGE_HEIGHT / 12_000.0, CapturePlan.outputScale(CapturePlan.MODE_FULL_PAGE, long, s), 1e-9)
        val (w, h) = CapturePlan.outputSize(long, CapturePlan.outputScale(CapturePlan.MODE_FULL_PAGE, long, s))
        assertEquals(8000, h)
        assertEquals(274, w)
    }

    @Test
    fun outputSizeIsNeverEmpty() {
        assertEquals(Pair(1, 1), CapturePlan.outputSize(Box(0.0, 0.0, 0.2, 0.2), 1.0))
        assertEquals(Pair(822, 6000), CapturePlan.outputSize(Box(0.0, 0.0, 411.0, 3000.0), 2.0))
    }

    @Test
    fun scrollTargetsCoverTheDocumentInViewportSteps() {
        val cells = CapturePlan.scrollTargets(Box(0.0, 0.0, 411.0, 3000.0), phone)
        // 3000 / 700 → strips at 0, 700, 1400, 2100 and the last one clamped to 2300 (= 3000 − 700).
        assertEquals(listOf(0.0, 700.0, 1400.0, 2100.0, 2300.0), cells.map { it.second })
        assertTrue(cells.all { it.first == 0.0 })
    }

    @Test
    fun scrollTargetsForARegionStartAtTheRegion() {
        val cells = CapturePlan.scrollTargets(Box(0.0, 1000.0, 411.0, 900.0), phone)
        assertEquals(listOf(Pair(0.0, 1000.0), Pair(0.0, 1700.0)), cells)
    }

    @Test
    fun scrollTargetsTileHorizontallyForWideDocuments() {
        val wide = phone.copy(documentWidth = 1000.0, documentHeight = 700.0)
        val cells = CapturePlan.scrollTargets(Box(0.0, 0.0, 1000.0, 700.0), wide)
        assertEquals(listOf(Pair(0.0, 0.0), Pair(411.0, 0.0), Pair(589.0, 0.0)), cells)
    }

    @Test
    fun scrollTargetsNeverRepeatAClampedPosition() {
        val short = phone.copy(documentHeight = 750.0)
        val cells = CapturePlan.scrollTargets(Box(0.0, 0.0, 411.0, 750.0), short)
        assertEquals(listOf(Pair(0.0, 0.0), Pair(0.0, 50.0)), cells)
        val fits = phone.copy(documentHeight = 700.0)
        assertEquals(listOf(Pair(0.0, 0.0)), CapturePlan.scrollTargets(Box(0.0, 0.0, 411.0, 700.0), fits))
    }

    @Test
    fun blitMapsTheOverlapOfStripAndTarget() {
        val target = Box(0.0, 0.0, 411.0, 3000.0)
        val s = 1080.0 / 411.0
        val o = 2.0
        // The clamped last strip shows 2300…3000: only its bottom 700 px are new, but it maps whole.
        val b = CapturePlan.blit(Box(0.0, 2300.0, 411.0, 700.0), target, s, o)
        assertNotNull(b)
        assertEquals(Box(0.0, 0.0, 411.0 * s, 700.0 * s), b!!.src)
        assertEquals(Box(0.0, 4600.0, 822.0, 1400.0), b.dst)
        // A strip entirely outside the target contributes nothing.
        assertNull(CapturePlan.blit(Box(0.0, 3000.0, 411.0, 700.0), target, s, o))
    }

    @Test
    fun blitCropsARegionOutOfAStrip() {
        val region = Box(50.0, 1250.0, 200.0, 100.0)
        val s = 2.0
        val b = CapturePlan.blit(Box(0.0, 1200.0, 411.0, 700.0), region, s, s)
        assertNotNull(b)
        assertEquals(Box(100.0, 100.0, 400.0, 200.0), b!!.src)
        assertEquals(Box(0.0, 0.0, 400.0, 200.0), b.dst)
    }

    @Test
    fun viewportJsonPutsTheVisualViewportInTheChromesTerms() {
        // Scrolled and pinch-panned: what is on screen starts where the visual viewport says.
        val scrolled = phone.copy(scrollY = 1200.0, pageLeft = 20.0, pageTop = 1230.0)
        val json = CapturePlan.viewportJson(scrolled, viewWidthPx, 2.625)
        assertEquals(20.0, json.getDouble("scrollX"), 0.0)
        assertEquals(1230.0, json.getDouble("scrollY"), 0.0)
        assertEquals(411.0, json.getDouble("width"), 0.0)
        assertEquals(700.0, json.getDouble("height"), 0.0)
        // The view's 1080 px cover the 411 CSS px visual viewport: that many device px per CSS px…
        assertEquals(1080.0 / 411.0, json.getDouble("devicePixelRatio"), 1e-9)
        // …and, over the density, how many dp of the chrome one page px takes (about 1 here).
        assertEquals(1080.0 / 411.0 / 2.625, json.getDouble("zoom"), 1e-9)
        assertEquals(411.0, json.getDouble("documentWidth"), 0.0)
        assertEquals(3000.0, json.getDouble("documentHeight"), 0.0)
    }

    @Test
    fun viewportJsonZoomFollowsTheVisualViewportsScale() {
        // A desktop-layout page squeezed into the screen: 980 CSS px in 1080 device px, well below 1.
        val overview = phone.copy(viewportWidth = 980.0, documentWidth = 980.0)
        assertEquals(1080.0 / 980.0 / 2.625, CapturePlan.viewportJson(overview, viewWidthPx, 2.625).getDouble("zoom"), 1e-9)
        // Pinched in to twice the size: half the CSS px on screen, a zoom of about 2.
        val pinched = phone.copy(viewportWidth = 205.5, viewportHeight = 350.0)
        assertEquals(1080.0 / 205.5 / 2.625, CapturePlan.viewportJson(pinched, viewWidthPx, 2.625).getDouble("zoom"), 1e-9)
        // The document is never reported smaller than the visible area.
        val shallow = phone.copy(documentWidth = 100.0, documentHeight = 100.0)
        val json = CapturePlan.viewportJson(shallow, viewWidthPx, 2.625)
        assertEquals(411.0, json.getDouble("documentWidth"), 0.0)
        assertEquals(700.0, json.getDouble("documentHeight"), 0.0)
    }

    @Test
    fun viewportJsonWithoutALaidOutViewFallsBackToTheDensity() {
        val json = CapturePlan.viewportJson(phone, 0, 2.625)
        assertEquals(2.625, json.getDouble("devicePixelRatio"), 0.0)
        assertEquals(1.0, json.getDouble("zoom"), 0.0)
        // No density either (a headless test): 1 all round rather than a division by zero.
        val bare = CapturePlan.viewportJson(phone, 0, 0.0)
        assertEquals(1.0, bare.getDouble("devicePixelRatio"), 0.0)
        assertEquals(1.0, bare.getDouble("zoom"), 0.0)
    }

    @Test
    fun boxesIntersectAndContain() {
        val a = Box(0.0, 0.0, 10.0, 10.0)
        assertEquals(Box(5.0, 5.0, 5.0, 5.0), a.intersect(Box(5.0, 5.0, 20.0, 20.0)))
        assertNull(a.intersect(Box(10.0, 0.0, 5.0, 5.0)))
        assertTrue(a.contains(Box(0.0, 0.0, 10.0, 10.0)))
        assertTrue(!a.contains(Box(0.0, 0.0, 10.0, 10.5)))
    }
}

package app.zen.chromium

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.image.BufferedImage
import java.nio.ByteBuffer
import javax.imageio.ImageIO

class QrScanLogicTest {
    // --- the permission-state machine -----------------------------------------------------------

    @Test
    fun aGrantIsGrantedWhateverTheRationaleSays() {
        assertEquals(RuntimeGrant.GRANTED, RuntimeGrant.of(granted = true, canAskAgain = true))
        assertEquals(RuntimeGrant.GRANTED, RuntimeGrant.of(granted = true, canAskAgain = false))
    }

    @Test
    fun aRefusalTheSystemWouldAskAboutAgainIsForThisOnce() {
        assertEquals(RuntimeGrant.DENIED, RuntimeGrant.of(granted = false, canAskAgain = true))
    }

    @Test
    fun aRefusalTheSystemWouldNotAskAboutAgainIsForGood() {
        assertEquals(RuntimeGrant.DENIED_PERMANENTLY, RuntimeGrant.of(granted = false, canAskAgain = false))
    }

    @Test
    fun theGrantAnswersQrStartByTheChromesNames() {
        assertEquals("scanning", QrScanLogic.outcome(RuntimeGrant.GRANTED))
        assertEquals("denied", QrScanLogic.outcome(RuntimeGrant.DENIED))
        assertEquals("denied-permanently", QrScanLogic.outcome(RuntimeGrant.DENIED_PERMANENTLY))
    }

    // --- the luminance-plane adapter, on the fixture code ---------------------------------------

    /** The fixture: `https://example.org/` as a QR code, 4 px a module with the quiet zone, 148 x 148 gray. */
    private val fixture: BufferedImage by lazy {
        ImageIO.read(javaClass.getResourceAsStream("/qr/example-org.png") ?: error("fixture missing"))
    }

    /** The fixture as a camera would hand it over: a Y plane with rows `rowStride` apart, the last row unpadded. */
    private fun plane(rowStride: Int, pixelStride: Int = 1, invert: Boolean = false): ByteBuffer {
        val w = fixture.width
        val h = fixture.height
        val bytes = ByteArray((h - 1) * rowStride + (w - 1) * pixelStride + 1)
        for (y in 0 until h) for (x in 0 until w) {
            val gray = fixture.raster.getSample(x, y, 0)
            bytes[y * rowStride + x * pixelStride] = (if (invert) 255 - gray else gray).toByte()
        }
        return ByteBuffer.wrap(bytes)
    }

    @Test
    fun theFixtureDecodesThroughAStridedPlane() {
        val stride = fixture.width + 37
        val source = QrScanLogic.luminanceSource(plane(stride), fixture.width, fixture.height, stride, 1)
        assertEquals(fixture.width, source.width)
        assertEquals(fixture.height, source.height)
        assertEquals("https://example.org/", QrScanLogic.decode(source))
    }

    @Test
    fun aTightPlaneDecodesToo() {
        val source = QrScanLogic.luminanceSource(plane(fixture.width), fixture.width, fixture.height, fixture.width, 1)
        assertEquals("https://example.org/", QrScanLogic.decode(source))
    }

    @Test
    fun theAdapterReadsThePlaneRowByRowPastTheStride() {
        val stride = fixture.width + 5
        val source = QrScanLogic.luminanceSource(plane(stride), fixture.width, fixture.height, stride, 1)
        val expected = ByteArray(fixture.width) { x -> fixture.raster.getSample(x, 70, 0).toByte() }
        assertArrayEquals(expected, source.getRow(70, null))
    }

    @Test
    fun anInterleavedPlaneIsRepackedTight() {
        val stride = fixture.width * 2 + 8
        val source = QrScanLogic.luminanceSource(plane(stride, pixelStride = 2), fixture.width, fixture.height, stride, 2)
        val expected = ByteArray(fixture.width) { x -> fixture.raster.getSample(x, 12, 0).toByte() }
        assertArrayEquals(expected, source.getRow(12, null))
        assertEquals("https://example.org/", QrScanLogic.decode(source))
    }

    @Test
    fun theBufferIsReadFromItsStartAndLeftAsItWas() {
        val stride = fixture.width + 3
        val buffer = plane(stride)
        buffer.position(500)
        val source = QrScanLogic.luminanceSource(buffer, fixture.width, fixture.height, stride, 1)
        assertEquals(500, buffer.position())
        assertEquals("https://example.org/", QrScanLogic.decode(source))
    }

    @Test
    fun aLightCodeOnADarkGroundDecodesThroughTheInvertedRead() {
        val stride = fixture.width + 16
        val source = QrScanLogic.luminanceSource(plane(stride, invert = true), fixture.width, fixture.height, stride, 1)
        assertEquals("https://example.org/", QrScanLogic.decode(source))
    }

    @Test
    fun aFrameWithNoCodeDecodesToNothing() {
        val w = 160
        val h = 120
        val bytes = ByteArray(w * h) { i -> ((i * 31) % 251).toByte() }
        val source = QrScanLogic.luminanceSource(ByteBuffer.wrap(bytes), w, h, w, 1)
        assertNull(QrScanLogic.decode(source))
    }

    @Test(expected = IllegalArgumentException::class)
    fun aStrideUnderTheWidthIsRefused() {
        QrScanLogic.luminanceSource(ByteBuffer.allocate(64), 16, 4, 8, 1)
    }

    // --- the sizes picked from what a camera offers -----------------------------------------------

    @Test
    fun theAnalysisSizeIsTheSmallestThatReaches480OnTheShortSideUnder1280() {
        val offered = listOf(4032 to 3024, 1920 to 1080, 1280 to 960, 1280 to 720, 800 to 600, 640 to 480, 320 to 240)
        assertEquals(640 to 480, QrScanLogic.pickAnalysisSize(offered))
    }

    @Test
    fun theAnalysisSizeFallsBackToTheLargestUnderTheCapThenTheSmallestOfAll() {
        assertEquals(640 to 360, QrScanLogic.pickAnalysisSize(listOf(320 to 240, 640 to 360, 1920 to 1080)))
        assertEquals(2048 to 1536, QrScanLogic.pickAnalysisSize(listOf(4032 to 3024, 2048 to 1536)))
        assertNull(QrScanLogic.pickAnalysisSize(emptyList()))
    }

    @Test
    fun thePreviewSizeCoversTheWindowOnItsShortSide() {
        val offered = listOf(1920 to 1080, 1600 to 1200, 1280 to 960, 1280 to 720, 640 to 480)
        assertEquals(1280 to 960, QrScanLogic.pickPreviewSize(offered, windowPx = 900))
        assertEquals(1600 to 1200, QrScanLogic.pickPreviewSize(offered, windowPx = 1100))
        assertEquals(640 to 480, QrScanLogic.pickPreviewSize(offered, windowPx = 400))
    }

    // --- the preview's fit on its window ---------------------------------------------------------

    @Test
    fun aPortraitPhoneShowsTheSensorsFrameUprightAndCropped() {
        // A 4:3 sensor mounted across a portrait phone stands upright as 480 x 640; the square
        // window is covered by scaling the shorter (horizontal) side up to it.
        val fit = QrScanLogic.previewFit(700, 700, 640, 480, sensorOrientation = 90, displayRotationDegrees = 0)
        assertEquals(480, fit.contentWidth)
        assertEquals(640, fit.contentHeight)
        assertEquals(0, fit.rotation)
        assertEquals(700f / 480f, fit.scale, 0.0001f)
    }

    @Test
    fun aTurnedDeviceTurnsThePictureBackUpright() {
        val left = QrScanLogic.previewFit(700, 700, 640, 480, sensorOrientation = 90, displayRotationDegrees = 90)
        assertEquals(270, left.rotation)
        assertEquals(700f / 480f, left.scale, 0.0001f)
        val right = QrScanLogic.previewFit(700, 700, 640, 480, sensorOrientation = 90, displayRotationDegrees = 270)
        assertEquals(90, right.rotation)
        val upsideDown = QrScanLogic.previewFit(700, 700, 640, 480, sensorOrientation = 90, displayRotationDegrees = 180)
        assertEquals(180, upsideDown.rotation)
    }

    @Test
    fun aSensorAlongTheNaturalOrientationKeepsItsSides() {
        val fit = QrScanLogic.previewFit(800, 400, 640, 480, sensorOrientation = 0, displayRotationDegrees = 0)
        assertEquals(640, fit.contentWidth)
        assertEquals(480, fit.contentHeight)
        assertEquals(800f / 640f, fit.scale, 0.0001f)
        assertTrue(fit.scale * 480 >= 400)
    }

    // --- camera errors -----------------------------------------------------------------------------

    @Test
    fun aCameraHeldByAnotherAppIsBusyAndTheRestAreTheCamera() {
        assertEquals("busy", QrScanLogic.errorName(QrScanLogic.ERROR_CAMERA_IN_USE))
        assertEquals("busy", QrScanLogic.errorName(QrScanLogic.ERROR_MAX_CAMERAS_IN_USE))
        assertEquals("camera", QrScanLogic.errorName(3))
        assertEquals("camera", QrScanLogic.errorName(4))
        assertEquals("camera", QrScanLogic.errorName(5))
    }
}

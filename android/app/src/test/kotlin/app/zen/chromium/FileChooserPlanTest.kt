package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** OS-22: what the file chooser offers for an input's accept types and `capture`, Chrome's way. */
class FileChooserPlanTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun plan(vararg accept: String, capture: Boolean = false, camera: Boolean = true) =
        FileChooserPlan.of(accept.toList(), capture, camera)

    @Test
    fun anInputTakingImagesGetsTheCameraBesideTheFiles() {
        val p = plan("image/*")
        assertEquals(FileChooserPlan.ALL_IMAGE_TYPES, p.pickerType)
        assertEquals(listOf("image/*"), p.mimeTypes)
        assertTrue(p.offerCamera)
        assertFalse(p.offerCamcorder)
        assertNull("no capture attribute: the chooser stands", p.captureOnly)
        assertTrue(p.needsCamera)
    }

    @Test
    fun anInputTakingVideosGetsTheCamcorder() {
        val p = plan("video/mp4", "video/webm")
        assertEquals(FileChooserPlan.ALL_VIDEO_TYPES, p.pickerType)
        assertEquals(listOf("video/mp4", "video/webm"), p.mimeTypes)
        assertFalse(p.offerCamera)
        assertTrue(p.offerCamcorder)
    }

    @Test
    fun anInputTakingAnythingGetsBoth() {
        for (p in listOf(plan(), plan("*/*"), plan(""), plan("image/*", "application/pdf", "*/*"))) {
            assertEquals(FileChooserPlan.ALL_TYPES, p.pickerType)
            assertEquals("no restriction for the picker", emptyList<String>(), p.mimeTypes)
            assertTrue(p.offerCamera)
            assertTrue(p.offerCamcorder)
            assertNull(p.captureOnly)
        }
    }

    @Test
    fun imagesAndVideosTogetherGetBothOverAPickerOfEveryType() {
        val p = plan("image/*,video/*")
        assertEquals(FileChooserPlan.ALL_TYPES, p.pickerType)
        assertEquals(listOf("image/*", "video/*"), p.mimeTypes)
        assertTrue(p.offerCamera)
        assertTrue(p.offerCamcorder)
        // `capture` cannot say which app: the chooser stands.
        assertNull(plan("image/*,video/*", capture = true).captureOnly)
    }

    @Test
    fun anInputTakingNeitherGetsTheFilesAlone() {
        val p = FileChooserPlan.of(listOf("application/pdf", ".csv"), capture = false) { ext -> if (ext == "csv") "text/csv" else null }
        assertEquals(FileChooserPlan.ALL_TYPES, p.pickerType)
        assertEquals(listOf("application/pdf", "text/csv"), p.mimeTypes)
        assertFalse(p.offerCamera)
        assertFalse(p.offerCamcorder)
        assertFalse(p.needsCamera)
        assertNull("no camera in the plan, no toast about one", p.cameraRefusedMessage())
    }

    @Test
    fun captureOnAnInputTakingImagesAloneGoesStraightToTheCamera() {
        assertEquals(FileChooserPlan.Capture.IMAGE, plan("image/*", capture = true).captureOnly)
        assertEquals(FileChooserPlan.Capture.IMAGE, plan("image/jpeg", "image/png", capture = true).captureOnly)
        assertEquals(FileChooserPlan.Capture.VIDEO, plan("video/*", capture = true).captureOnly)
        // Anything wider, or no camera to go to, keeps the chooser.
        assertNull(plan("*/*", capture = true).captureOnly)
        assertNull(plan(capture = true).captureOnly)
        assertNull(plan("image/*", "application/pdf", capture = true).captureOnly)
        assertNull(plan("image/*", capture = true, camera = false).captureOnly)
    }

    @Test
    fun extensionsResolveToTheirTypesAndAnUnknownOneOpensThePicker() {
        val p = plan(".jpg", ".PNG", " .webm ")
        assertEquals(listOf("image/jpeg", "image/png", "video/webm"), p.mimeTypes)
        assertTrue(p.offerCamera)
        assertTrue(p.offerCamcorder)
        val images = plan(".jpg", ".heic")
        assertEquals(FileChooserPlan.ALL_IMAGE_TYPES, images.pickerType)
        assertTrue(images.offerCamera)
        assertFalse(images.offerCamcorder)
        // An extension nobody knows: Chrome's picker takes everything, and so does ours.
        val unknown = plan(".zenium", "image/*")
        assertEquals(FileChooserPlan.ALL_TYPES, unknown.pickerType)
        assertEquals(emptyList<String>(), unknown.mimeTypes)
        assertTrue(unknown.offerCamcorder)
    }

    @Test
    fun theResolverHandedInDecidesAnExtension() {
        val p = FileChooserPlan.of(listOf(".raw"), capture = true) { ext -> if (ext == "raw") "image/x-raw" else null }
        assertEquals(listOf("image/x-raw"), p.mimeTypes)
        assertEquals(FileChooserPlan.Capture.IMAGE, p.captureOnly)
    }

    @Test
    fun withoutACameraNothingOffersOne() {
        for (p in listOf(plan(camera = false), plan("image/*", camera = false), plan("video/*", capture = true, camera = false))) {
            assertFalse(p.offerCamera)
            assertFalse(p.offerCamcorder)
            assertFalse(p.needsCamera)
            assertNull(p.captureOnly)
        }
    }

    @Test
    fun theRefusalKeepsThePickerAndTheAcceptTypes() {
        val p = plan("image/*", capture = true).withoutCamera()
        assertEquals(FileChooserPlan.ALL_IMAGE_TYPES, p.pickerType)
        assertEquals(listOf("image/*"), p.mimeTypes)
        assertFalse(p.offerCamera)
        assertFalse(p.offerCamcorder)
        assertNull("capture-only falls back to the picker", p.captureOnly)
    }

    @Test
    fun theToastNamesWhatTheCameraWasFor() {
        assertEquals("Camera access is needed to take a photo", plan("image/*").cameraRefusedMessage())
        assertEquals("Camera access is needed to take a photo", plan().cameraRefusedMessage())
        assertEquals("Camera access is needed to record a video", plan("video/*").cameraRefusedMessage())
        assertEquals("Camera access is turned off for Zenium", FileChooserPlan.CAMERA_OFF_MESSAGE)
    }

    @Test
    fun aResultsUrisComeFromItsDataOrItsClip() {
        assertEquals(listOf("content://a"), FileChooserPlan.resultUris("content://a", emptyList()))
        assertEquals(listOf("content://a", "content://b"), FileChooserPlan.resultUris(null, listOf("content://a", "content://b")))
        // A picker that sets both (the first item in the data as well): each once.
        assertEquals(listOf("content://a", "content://b"), FileChooserPlan.resultUris("content://a", listOf("content://a", "content://b")))
        assertEquals(emptyList<String>(), FileChooserPlan.resultUris(null, emptyList()))
        assertEquals(emptyList<String>(), FileChooserPlan.resultUris("", listOf("")))
    }

    @Test
    fun capturedPhotosAreNamedApartAndSweptOnceStale() {
        assertEquals("photo-1000.jpg", CapturedPhotos.fileName(1000))
        val now = 10_000_000_000L
        assertFalse(CapturedPhotos.stale(now - CapturedPhotos.KEEP_MS, now))
        assertTrue(CapturedPhotos.stale(now - CapturedPhotos.KEEP_MS - 1, now))
        val dir = folder.newFolder(CapturedPhotos.DIR)
        val fresh = File(dir, CapturedPhotos.fileName(now)).apply { writeText("fresh"); setLastModified(now - 1000) }
        val stale = File(dir, CapturedPhotos.fileName(1)).apply { writeText("old"); setLastModified(now - CapturedPhotos.KEEP_MS - 60_000) }
        assertEquals(1, CapturedPhotos.sweep(dir, now))
        assertTrue("the fresh photo may still be on its way up", fresh.exists())
        assertFalse(stale.exists())
        assertEquals("a directory not made yet is nothing to sweep", 0, CapturedPhotos.sweep(File(dir, "missing"), now))
    }
}

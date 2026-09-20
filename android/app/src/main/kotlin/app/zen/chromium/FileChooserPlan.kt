package app.zen.chromium

import java.io.File

/**
 * What the file chooser offers for a page's `<input type=file>` (OS-22), decided from the input's
 * accept types and its `capture` attribute after Chrome's `SelectFileDialog`: an input taking
 * images gets the camera beside the files, one taking videos the camcorder, one taking anything
 * (no accept, the every-type wildcard [ALL_TYPES], an extension nobody knows, or images and
 * videos together) both; an input
 * taking neither (a PDF, a spreadsheet) gets the files alone. `capture` on an input that takes
 * images only – or videos only – skips the picker and goes straight to the camera (or the
 * camcorder), as Chrome's `captureImage()` path does; with a wider accept list the attribute
 * cannot say which, and the chooser stands. Pure, so the decision is tested on the JVM;
 * [BrowserActivity.showFileChooser] builds the intents from it.
 */
data class FileChooserPlan(
    /** The picker's type: [ALL_IMAGE_TYPES], [ALL_VIDEO_TYPES], or [ALL_TYPES] for a picker over every type. */
    val pickerType: String,
    /** The accept types as MIME types (extensions resolved), for the picker's `EXTRA_MIME_TYPES`; empty for no restriction. */
    val mimeTypes: List<String>,
    /** The chooser offers the camera (`ACTION_IMAGE_CAPTURE`). */
    val offerCamera: Boolean,
    /** The chooser offers the camcorder (`ACTION_VIDEO_CAPTURE`). */
    val offerCamcorder: Boolean,
    /** `capture` on an input taking images or videos only: straight to that app, no picker. */
    val captureOnly: Capture?
) {
    enum class Capture { IMAGE, VIDEO }

    /** Whether the chooser would use the camera at all, so the CAMERA permission is asked for first. */
    val needsCamera: Boolean get() = offerCamera || offerCamcorder

    /** The same plan with the camera and camcorder left out (the permission refused): the picker alone. */
    fun withoutCamera(): FileChooserPlan = copy(offerCamera = false, offerCamcorder = false, captureOnly = null)

    /**
     * The toast for the camera refused this once (§9.33, #211's form): what the camera was for,
     * from the input's kinds; null when the camera was not in the plan.
     */
    fun cameraRefusedMessage(): String? = when {
        !needsCamera -> null
        offerCamcorder && !offerCamera -> "Camera access is needed to record a video"
        else -> "Camera access is needed to take a photo"
    }

    companion object {
        const val ALL_TYPES = "*/*"
        const val ALL_IMAGE_TYPES = "image/*"
        const val ALL_VIDEO_TYPES = "video/*"

        /** The refusal for good: the prompt will not show again, Settings is the way on (#211's copy). */
        const val CAMERA_OFF_MESSAGE = "Camera access is turned off for Zenium"

        /** An extension the resolver does not know: the picker takes everything, as Chrome's does. */
        private const val UNKNOWN = "?"

        /**
         * The media extensions an accept list may name instead of MIME types, for hosts without
         * Android's `MimeTypeMap` (the JVM tests); the activity hands the map's own resolver in.
         */
        val MEDIA_EXTENSION_TYPES: Map<String, String> = mapOf(
            "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png", "gif" to "image/gif",
            "webp" to "image/webp", "bmp" to "image/bmp", "heic" to "image/heic", "heif" to "image/heif",
            "avif" to "image/avif", "svg" to "image/svg+xml",
            "mp4" to "video/mp4", "m4v" to "video/mp4", "webm" to "video/webm", "mov" to "video/quicktime",
            "3gp" to "video/3gpp", "mkv" to "video/x-matroska", "avi" to "video/x-msvideo"
        )

        /**
         * The plan for an input with `acceptTypes` (as `FileChooserParams.acceptTypes` hands them:
         * MIME types, wildcards or `.ext` names, possibly empty) and the `capture` attribute;
         * `cameraAvailable` false (no camera, or nothing answers the capture intents) keeps the
         * camera out of the plan whatever the input asks. `extensionType` resolves a `.ext` name
         * to its MIME type (null for one it does not know).
         */
        fun of(
            acceptTypes: List<String>,
            capture: Boolean,
            cameraAvailable: Boolean = true,
            extensionType: (String) -> String? = MEDIA_EXTENSION_TYPES::get
        ): FileChooserPlan {
            val mimeTypes = acceptTypes.asSequence()
                .flatMap { it.split(',').asSequence() }
                .map { it.trim().lowercase() }
                .filter { it.isNotEmpty() }
                .map { if (it.startsWith(".")) extensionType(it.substring(1))?.lowercase() ?: UNKNOWN else it }
                .distinct()
                .toList()
            val any = mimeTypes.isEmpty() || mimeTypes.contains(ALL_TYPES) || mimeTypes.contains(UNKNOWN)
            val images = mimeTypes.any { it.startsWith("image/") }
            val videos = mimeTypes.any { it.startsWith("video/") }
            val others = mimeTypes.any { !it.startsWith("image/") && !it.startsWith("video/") && it != ALL_TYPES }
            val imagesOnly = !any && images && !videos && !others
            val videosOnly = !any && videos && !images && !others
            val pickerType = when {
                imagesOnly -> ALL_IMAGE_TYPES
                videosOnly -> ALL_VIDEO_TYPES
                else -> ALL_TYPES
            }
            val offerCamera = cameraAvailable && (any || images)
            val offerCamcorder = cameraAvailable && (any || videos)
            val captureOnly = when {
                !capture -> null
                offerCamera && imagesOnly -> Capture.IMAGE
                offerCamcorder && videosOnly -> Capture.VIDEO
                else -> null
            }
            return FileChooserPlan(
                pickerType = pickerType,
                mimeTypes = if (any) emptyList() else mimeTypes,
                offerCamera = offerCamera,
                offerCamcorder = offerCamcorder,
                captureOnly = captureOnly
            )
        }

        /**
         * The URIs a picker's result carries: the one in its data, or the several in its clip
         * (`EXTRA_ALLOW_MULTIPLE`), which `FileChooserParams.parseResult` does not read; empty
         * for neither.
         */
        fun resultUris(data: String?, clip: List<String>): List<String> =
            (listOfNotNull(data) + clip).filter { it.isNotEmpty() }.distinct()
    }
}

/**
 * The photos the camera app writes for the file chooser (`EXTRA_OUTPUT`): files under the
 * cache's [DIR], reached by the camera app through the `FileProvider` (`file_paths.xml`'s
 * `capture`). A photo the page never got is deleted as the chooser answers; one the page got
 * stays for its upload – the engine reads the content URI when the form is sent, not when the
 * chooser answers – and is swept at a later start once it is old enough that no page is still
 * sending it, as Chrome's `clearCapturedCameraFiles` sweeps its own.
 */
object CapturedPhotos {
    const val DIR = "capture"
    /** A photo older than this at a start was uploaded long ago, or never picked. */
    const val KEEP_MS = 5 * 60 * 60 * 1000L

    /** The output file's name for a photo taken at `now`: one per capture, no two the same. */
    fun fileName(now: Long): String = "photo-$now.jpg"

    /** Whether a file in [DIR] is old enough at `now` to go. */
    fun stale(lastModified: Long, now: Long): Boolean = now - lastModified > KEEP_MS

    /** Delete the stale files in `dir` (which may not exist yet); how many went. */
    fun sweep(dir: File, now: Long): Int {
        val files = dir.listFiles() ?: return 0
        var removed = 0
        for (file in files) {
            if (file.isFile && stale(file.lastModified(), now) && file.delete()) removed++
        }
        return removed
    }
}

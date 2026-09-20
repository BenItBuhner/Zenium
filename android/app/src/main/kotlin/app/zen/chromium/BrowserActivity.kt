package app.zen.chromium

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import java.io.File

/**
 * The activity-bound plumbing every window that shows pages needs: the file chooser a page's
 * `<input type=file>` opens, the runtime permissions a site's camera, microphone or location
 * request needs, and the system dialogs a download's "ask where to save" and Settings' download
 * folder open. [MainActivity] (the browser) and [CustomTabActivity] (another app's custom tab)
 * both host [TabWebView]s through it.
 */
abstract class BrowserActivity : AppCompatActivity() {
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    /**
     * The photo the camera app writes for the chooser under way (`EXTRA_OUTPUT`, a file of ours
     * behind the `FileProvider`): the answer when the camera comes back with nothing else.
     */
    private var cameraOutput: CameraOutput? = null
    /** A word owed once the picker returns: the camera was refused ahead of it (§9.33's toast). */
    private var fileChooserToast: (() -> Unit)? = null
    private var permissionCallback: ((Map<String, Boolean>) -> Unit)? = null
    private var documentCallback: ((Uri?) -> Unit)? = null
    private var folderCallback: ((Uri?) -> Unit)? = null

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileChooserCallback ?: return@registerForActivityResult
        fileChooserCallback = null
        val capture = cameraOutput
        cameraOutput = null
        val uris = fileChooserResult(result.resultCode, result.data, capture)
        // A photo the page is not getting – the camera cancelled, a file picked instead – goes at
        // once; the one it is getting stays for the upload and is swept at the next start, as
        // Chrome's captured files are (`clearCapturedCameraFiles`).
        if (capture != null && (uris == null || uris.none { it == capture.uri })) capture.file.delete()
        callback.onReceiveValue(uris)
        fileChooserToast?.let { toast ->
            fileChooserToast = null
            toast()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sweepCaptures(cacheDir)
    }

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        val callback = permissionCallback ?: return@registerForActivityResult
        permissionCallback = null
        callback(results)
    }

    /** Downloads: "ask where to save" hands the system save dialog a name and type; it answers with a document URI. */
    private val documentCreator = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = documentCallback ?: return@registerForActivityResult
        documentCallback = null
        callback(if (result.resultCode == Activity.RESULT_OK) result.data?.data else null)
    }

    /** Downloads: the default location in Settings is a folder the user picks (a persistable tree URI). */
    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val callback = folderCallback ?: return@registerForActivityResult
        folderCallback = null
        callback(uri)
    }

    /**
     * A page's `<input type=file>` (OS-22): the system picker, with the camera beside the files
     * for an input taking images and the camcorder for one taking videos ([FileChooserPlan]),
     * offered through the chooser's `EXTRA_INITIAL_INTENTS` as Chrome's picker offers them;
     * `capture` on an input taking images (or videos) alone goes straight to the camera (or
     * camcorder). The photo is the camera app's to write into a file of ours (`EXTRA_OUTPUT`
     * behind the `FileProvider`, `res/xml/file_paths.xml`'s `capture`), handed to the page as
     * its content URI.
     *
     * The app declares CAMERA (#211), so Android will not let the camera app take a photo for it
     * without the runtime permission: as Chrome's `SelectFileDialog` does, it is asked for ahead
     * of the chooser whenever the camera would be in it (nothing when granted before), and a
     * refusal shows the picker alone with a toast on why (§9.33, #211's words) once the picker
     * has returned – over the picker it would not be seen – Open settings when the refusal is
     * for good. Answers `false` only when nothing could be shown at all.
     */
    fun showFileChooser(host: PageHost, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileChooserCallback?.onReceiveValue(null)
        cameraOutput?.file?.delete()
        cameraOutput = null
        fileChooserToast = null
        fileChooserCallback = callback
        val plan = FileChooserPlan.of(
            params.acceptTypes?.toList() ?: emptyList(),
            params.isCaptureEnabled,
            cameraAvailable(),
            ::mimeTypeOfExtension
        )
        val multiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        if (!plan.needsCamera) return launchFileChooser(plan, multiple)
        host.permissions.requestForApp(Manifest.permission.CAMERA) { grant ->
            // Overtaken by another chooser (or the tab is gone): that one has the callback now.
            if (fileChooserCallback !== callback) return@requestForApp
            if (grant == RuntimeGrant.GRANTED) {
                if (!launchFileChooser(plan, multiple)) callback.onReceiveValue(null)
                return@requestForApp
            }
            val permanent = grant == RuntimeGrant.DENIED_PERMANENTLY
            val message = if (permanent) FileChooserPlan.CAMERA_OFF_MESSAGE else plan.cameraRefusedMessage()
            if (message != null) fileChooserToast = {
                host.hostEvent("toast", json("message" to message, "kind" to "info", "action" to if (permanent) "settings" else null))
            }
            if (!launchFileChooser(plan.withoutCamera(), multiple)) {
                fileChooserToast = null
                callback.onReceiveValue(null)
            }
        }
        return true
    }

    /** Start the plan's intent; false (the callback dropped) when no activity answers it. */
    private fun launchFileChooser(plan: FileChooserPlan, multiple: Boolean): Boolean {
        return try {
            fileChooser.launch(fileChooserIntent(plan, multiple))
            true
        } catch (e: Exception) {
            Log.w(TAG, "file chooser could not start: $e")
            cameraOutput?.file?.delete()
            cameraOutput = null
            fileChooserCallback = null
            false
        }
    }

    /** Whether a camera app is there to answer the capture intents (and a camera behind it). */
    private fun cameraAvailable(): Boolean =
        packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) &&
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).resolveActivity(packageManager) != null

    private fun mimeTypeOfExtension(extension: String): String? =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)

    /** The intent for the plan: the capture-only app, the picker alone, or the chooser over both. */
    private fun fileChooserIntent(plan: FileChooserPlan, multiple: Boolean): Intent {
        val camera = if (plan.offerCamera) cameraIntent() else null
        val camcorder = if (plan.offerCamcorder) Intent(MediaStore.ACTION_VIDEO_CAPTURE) else null
        when (plan.captureOnly) {
            FileChooserPlan.Capture.IMAGE -> if (camera != null) return camera
            FileChooserPlan.Capture.VIDEO -> if (camcorder != null) return camcorder
            null -> {}
        }
        val picker = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = plan.pickerType
            if (plan.mimeTypes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, plan.mimeTypes.toTypedArray())
            if (multiple) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        val extras = listOfNotNull(camera, camcorder)
        if (extras.isEmpty()) return picker
        return Intent.createChooser(picker, null).apply {
            putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toTypedArray())
        }
    }

    /**
     * The camera intent with its output: a file under the cache's `capture` directory, reached
     * through the `FileProvider`, the grant riding on the clip (`EXTRA_OUTPUT` is not the
     * intent's data, so the flags alone would not reach the camera app). Null when the provider
     * refuses the path (a misconfiguration): the camera then stays out of the chooser.
     */
    private fun cameraIntent(): Intent? {
        val dir = File(cacheDir, CapturedPhotos.DIR)
        dir.mkdirs()
        val file = File(dir, CapturedPhotos.fileName(System.currentTimeMillis()))
        val uri = try {
            FileProvider.getUriForFile(this, "$packageName.files", file)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "no provider path for the camera's photo: $e")
            return null
        }
        cameraOutput = CameraOutput(file, uri)
        return Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            clipData = ClipData.newRawUri("capture", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
    }

    /**
     * What the chooser's result hands the page: the picked file (or files, from the clip that
     * `EXTRA_ALLOW_MULTIPLE` fills and `FileChooserParams.parseResult` never reads), else the
     * photo the camera wrote into the output file – a camera app answers with no data when it
     * was given `EXTRA_OUTPUT` – when there is one; null for a cancel or an empty answer.
     */
    private fun fileChooserResult(resultCode: Int, data: Intent?, capture: CameraOutput?): Array<Uri>? {
        if (resultCode != Activity.RESULT_OK) return null
        val clip = data?.clipData?.let { clip -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri?.toString() } } ?: emptyList()
        val picked = FileChooserPlan.resultUris(data?.dataString, clip).map(Uri::parse)
        if (picked.isNotEmpty()) return picked.toTypedArray()
        if (capture != null && capture.file.length() > 0) return arrayOf(capture.uri)
        return null
    }

    private class CameraOutput(val file: File, val uri: Uri)

    /**
     * The capture directory's leftovers go at every start: a photo the page was handed stays
     * for its upload (the engine reads the content URI when the form is sent, not when the
     * chooser answers), so – as Chrome's `clearCapturedCameraFiles` does – the sweep takes the
     * ones old enough that no page is still sending them.
     */
    private fun sweepCaptures(cacheDir: File) {
        val dir = File(cacheDir, CapturedPhotos.DIR)
        Thread { CapturedPhotos.sweep(dir, System.currentTimeMillis()) }.start()
    }

    fun requestRuntimePermissions(permissions: List<String>, callback: (Map<String, Boolean>) -> Unit) {
        permissionCallback?.invoke(emptyMap())
        permissionCallback = callback
        permissionLauncher.launch(permissions.toTypedArray())
    }

    /** System "save as" dialog for a download; answers with the document to write, or null when dismissed. */
    fun createDocument(name: String, mimeType: String, callback: (Uri?) -> Unit) {
        documentCallback?.invoke(null)
        documentCallback = callback
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType.ifEmpty { "application/octet-stream" }
            putExtra(Intent.EXTRA_TITLE, name)
        }
        try {
            documentCreator.launch(intent)
        } catch (e: Exception) {
            documentCallback = null
            callback(null)
        }
    }

    /** Folder picker for the downloads location; answers with a tree URI, or null when dismissed. */
    fun pickFolder(callback: (Uri?) -> Unit) {
        folderCallback?.invoke(null)
        folderCallback = callback
        try {
            folderPicker.launch(null)
        } catch (e: Exception) {
            folderCallback = null
            callback(null)
        }
    }

    companion object {
        private const val TAG = "ZenChooser"
    }
}

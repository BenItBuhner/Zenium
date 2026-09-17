package app.zen.chromium

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/**
 * The activity-bound plumbing every window that shows pages needs: the file chooser a page's
 * `<input type=file>` opens, the runtime permissions a site's camera, microphone or location
 * request needs, and the system dialogs a download's "ask where to save" and Settings' download
 * folder open. [MainActivity] (the browser) and [CustomTabActivity] (another app's custom tab)
 * both host [TabWebView]s through it.
 */
abstract class BrowserActivity : AppCompatActivity() {
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var permissionCallback: ((Map<String, Boolean>) -> Unit)? = null
    private var documentCallback: ((Uri?) -> Unit)? = null
    private var folderCallback: ((Uri?) -> Unit)? = null

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileChooserCallback ?: return@registerForActivityResult
        fileChooserCallback = null
        callback.onReceiveValue(
            if (result.resultCode == Activity.RESULT_OK)
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            else null
        )
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

    fun showFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = callback
        return try {
            fileChooser.launch(params.createIntent())
            true
        } catch (e: Exception) {
            fileChooserCallback = null
            false
        }
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
}

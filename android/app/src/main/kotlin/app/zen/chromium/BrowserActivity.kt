package app.zen.chromium

import android.app.Activity
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/**
 * The activity-bound plumbing every window that shows pages needs: the file chooser a page's
 * `<input type=file>` opens and the runtime permissions a site's camera, microphone or location
 * request needs. [MainActivity] (the browser) and [CustomTabActivity] (another app's custom tab)
 * both host [TabWebView]s through it.
 */
abstract class BrowserActivity : AppCompatActivity() {
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var permissionCallback: ((Map<String, Boolean>) -> Unit)? = null

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
}

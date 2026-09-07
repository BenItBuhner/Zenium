package app.zen.chromium

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

/**
 * Downloads through Android's `DownloadManager` (notifications, resume across app restarts),
 * reported to the core as they progress. The manager cannot pause/resume on request, so those
 * controls are no-ops here; cancel removes the transfer.
 */
class Downloads(private val context: Context, private val host: Host) {
    private val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    private val main = Handler(Looper.getMainLooper())

    private class Live(val downloadId: Long, val token: String, var coreId: String? = null)
    private val live = HashMap<String, Live>() // token → live
    private val byCoreId = HashMap<String, Live>()
    private var polling = false

    fun start(url: String, userAgent: String, contentDisposition: String?, mimeType: String?, contentLength: Long, sourceTabId: String) {
        if (url.startsWith("data:") || url.startsWith("blob:")) {
            Toast.makeText(context, "This kind of download is not supported yet", Toast.LENGTH_SHORT).show()
            return
        }
        val filename = URLUtil.guessFileName(url, contentDisposition, mimeType)
        val request = DownloadManager.Request(Uri.parse(url)).apply {
            setTitle(filename)
            setMimeType(mimeType)
            addRequestHeader("User-Agent", userAgent)
            CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
            } else {
                setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, filename)
            }
        }
        val id = try {
            manager.enqueue(request)
        } catch (e: Exception) {
            Toast.makeText(context, "Could not start download", Toast.LENGTH_SHORT).show()
            return
        }
        val token = "dm-$id"
        live[token] = Live(id, token)
        host.chrome.hostEvent(
            "download.started",
            json(
                "token" to token, "url" to url, "filename" to filename,
                "totalBytes" to contentLength.coerceAtLeast(0), "mimeType" to (mimeType ?: ""),
                "sourceTabId" to sourceTabId
            )
        )
        startPolling()
    }

    fun bind(token: String, coreId: String) {
        val l = live[token] ?: return
        l.coreId = coreId
        byCoreId[coreId] = l
    }

    fun cancel(coreId: String) {
        val l = byCoreId[coreId] ?: return
        manager.remove(l.downloadId)
        finish(l, "cancelled", "", "")
    }

    fun open(savePath: String, mimeType: String) {
        val uri = when {
            savePath.startsWith("content:") -> Uri.parse(savePath)
            savePath.startsWith("file:") -> fileProviderUri(File(Uri.parse(savePath).path ?: return))
            savePath.isNotEmpty() -> fileProviderUri(File(savePath))
            else -> return
        } ?: return
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mimeType.ifEmpty { "*/*" })
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(context, "No app can open this file", Toast.LENGTH_SHORT).show()
        }
    }

    fun showAll() {
        runCatching {
            context.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun fileProviderUri(file: File): Uri? = runCatching {
        FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    }.getOrElse { Uri.fromFile(file) }

    private fun startPolling() {
        if (polling) return
        polling = true
        main.postDelayed(::poll, 400)
    }

    private fun poll() {
        if (live.isEmpty()) {
            polling = false
            return
        }
        for (l in live.values.toList()) {
            val cursor = manager.query(DownloadManager.Query().setFilterById(l.downloadId))
            cursor.use { c ->
                if (!c.moveToFirst()) {
                    finish(l, "cancelled", "", "")
                    return@use
                }
                val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                val received = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                val localUri = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI)) ?: ""
                val title = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)) ?: ""
                when (status) {
                    DownloadManager.STATUS_SUCCESSFUL -> {
                        val path = manager.getUriForDownloadedFile(l.downloadId)?.toString() ?: localUri
                        finish(l, "completed", path, title)
                    }
                    DownloadManager.STATUS_FAILED -> finish(l, "interrupted", localUri, title)
                    else -> host.chrome.hostEvent(
                        "download.progress",
                        json(
                            "token" to l.token, "receivedBytes" to received, "totalBytes" to total.coerceAtLeast(0),
                            "state" to if (status == DownloadManager.STATUS_PAUSED) "paused" else "progressing"
                        )
                    )
                }
            }
        }
        if (live.isNotEmpty()) main.postDelayed(::poll, 500) else polling = false
    }

    private fun finish(l: Live, state: String, savePath: String, filename: String) {
        live.remove(l.token)
        l.coreId?.let { byCoreId.remove(it) }
        host.chrome.hostEvent(
            "download.done",
            json("token" to l.token, "state" to state, "savePath" to savePath, "filename" to filename)
        )
    }
}

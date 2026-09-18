package app.zen.chromium

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors

/**
 * The Android half of automatic updates. The core (running in the chrome WebView) has already
 * found the release on GitHub and verified its manifest; this class fetches the APK it names,
 * checks the SHA-256 the manifest promised, and hands the file to Android's package installer –
 * the same sideload flow F-Droid-style apps use. Android always asks the user to confirm, and it
 * only upgrades in place when the APK is signed with the same key as the installed app.
 */
class Updates(private val context: Context, private val host: Host) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-update") }
    @Volatile private var cancelledToken: String? = null

    fun download(token: String, url: String, name: String, size: Long, sha256: String, reply: (Any?) -> Unit) {
        if (isDebugApplicationId(context.packageName)) {
            reply(json("ok" to false, "cancelled" to false, "error" to DEBUG_BUILD_REASON))
            return
        }
        io.execute {
            val result = runCatching { fetch(token, url, name, size, sha256) }
            main.post {
                result.fold(
                    { file -> reply(json("ok" to true, "path" to file.absolutePath)) },
                    { e ->
                        val cancelled = e is CancellationException
                        reply(json("ok" to false, "cancelled" to cancelled, "error" to (e.message ?: e.javaClass.simpleName)))
                    }
                )
            }
        }
    }

    fun cancel(token: String) {
        cancelledToken = token
    }

    /** Start the system installer for a verified APK. The user confirms (or first allows Zen to install apps). */
    fun install(path: String): JSONObject {
        if (isDebugApplicationId(context.packageName)) return json("ok" to false, "reason" to DEBUG_BUILD_REASON)
        val file = File(path)
        if (!file.exists()) return json("ok" to false, "reason" to "the downloaded file is gone; download it again")
        if (!context.packageManager.canRequestPackageInstalls()) {
            // One-time "allow from this source" grant: Android opens the setting, the user taps Install again.
            runCatching {
                context.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
            return json("ok" to false, "reason" to "permission")
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            json("ok" to true)
        } catch (e: ActivityNotFoundException) {
            json("ok" to false, "reason" to "no package installer is available on this device")
        }
    }

    fun shutdown() {
        io.shutdownNow()
    }

    private fun fetch(token: String, url: String, name: String, size: Long, sha256: String): File {
        val dir = File(context.cacheDir, UPDATES_DIR).apply { mkdirs() }
        // Only the newest download is worth keeping.
        dir.listFiles()?.forEach { if (it.name != name) it.delete() }
        val file = File(dir, name)
        val partial = File(dir, "$name.part")
        try {
            val connection = open(url)
            val status = connection.responseCode
            if (status !in 200..299) throw IOException("download failed (HTTP $status)")
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: size
            val digest = MessageDigest.getInstance("SHA-256")
            val started = SystemClock.elapsedRealtime()
            var lastReport = 0L
            var transferred = 0L
            connection.inputStream.use { input ->
                FileOutputStream(partial).use { out ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        if (cancelledToken == token) throw CancellationException("cancelled")
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        digest.update(buffer, 0, n)
                        transferred += n
                        val now = SystemClock.elapsedRealtime()
                        if (now - lastReport >= 250) {
                            lastReport = now
                            report(token, transferred, total, now - started)
                        }
                    }
                }
            }
            if (transferred != size) throw IOException("the download is $transferred bytes, the release lists $size")
            val hex = digest.digest().joinToString("") { "%02x".format(it) }
            if (!hex.equals(sha256, ignoreCase = true)) throw IOException("the downloaded file is corrupt (checksum mismatch)")
            if (!partial.renameTo(file)) throw IOException("could not store the download")
            return file
        } catch (e: Exception) {
            partial.delete()
            throw e
        } finally {
            if (cancelledToken == token) cancelledToken = null
        }
    }

    /** GitHub answers release downloads with a redirect to its CDN; follow a few hops (https only). */
    private fun open(url: String): HttpURLConnection {
        var current = URL(url)
        for (hop in 0 until 6) {
            if (current.protocol != "https") throw IOException("refusing a non-https download")
            val connection = (current.openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 30_000
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/octet-stream")
            }
            val status = connection.responseCode
            if (status in 300..399) {
                val location = connection.getHeaderField("Location") ?: throw IOException("redirect without a location")
                connection.disconnect()
                current = URL(current, location)
                continue
            }
            return connection
        }
        throw IOException("too many redirects")
    }

    private fun report(token: String, transferred: Long, total: Long, elapsedMs: Long) {
        val seconds = (elapsedMs / 1000.0).coerceAtLeast(0.001)
        main.post {
            host.chrome.hostEvent(
                "update.progress",
                json("token" to token, "transferred" to transferred, "total" to total, "bytesPerSecond" to transferred / seconds)
            )
        }
    }

    companion object {
        const val UPDATES_DIR = "updates"

        /** The `applicationIdSuffix` of the debug build type (`android/app/build.gradle.kts`). */
        const val DEBUG_ID_SUFFIX = ".debug"
        private const val DEBUG_BUILD_REASON = "debug builds of Zenium do not install releases"

        /**
         * Whether `applicationId` is a debug build's. A debug build is not a release and no release
         * is an upgrade for it (it carries the debug key, and its own id): it neither looks for
         * releases – the core gives it the `dev` update target from the same id, see
         * `AndroidUpdateHost.target()` – nor downloads or installs one.
         */
        fun isDebugApplicationId(applicationId: String): Boolean = applicationId.endsWith(DEBUG_ID_SUFFIX)

        /** Hex SHA-256 of the certificate the running app is signed with; an APK must match it to upgrade in place. */
        fun signerSha256(context: Context): String? = runCatching {
            val pm = context.packageManager
            val signatures: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures
            }
            val first = signatures?.firstOrNull() ?: return null
            MessageDigest.getInstance("SHA-256").digest(first.toByteArray()).joinToString("") { "%02x".format(it) }
        }.getOrNull()
    }
}

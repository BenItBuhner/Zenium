package app.zen.chromium

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.net.HttpURLConnection
import java.net.URL

/**
 * The device side of a Digital Asset Links check, shared by the Auth Tab's return
 * ([AuthTabVerifier], CCT-13) and the Trusted Web Activity's scope ([TwaVerifier], CCT-20): the
 * statement file fetched over the host's own `HttpURLConnection` path, and the signing
 * fingerprints of the package the statement must name. The pure rules – which statement grants
 * what – stay in [AuthTab]. Called off the main thread.
 */
object DigitalAssetLinks {
    /** Where an origin's statements live: `<origin>/.well-known/assetlinks.json`. */
    fun statementUrl(origin: String): String = "$origin/.well-known/assetlinks.json"

    /**
     * The statement file at [url], fetched once – no redirects followed, at most
     * [MAX_STATEMENT_BYTES] read – or null for any answer but 200. A connection failure throws
     * (`IOException`): the caller decides what an offline device means.
     */
    fun fetchStatements(url: String): String? {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = FETCH_TIMEOUT_MS
        connection.readTimeout = FETCH_TIMEOUT_MS
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
            val text = connection.inputStream.use { stream -> stream.readBytes().take(MAX_STATEMENT_BYTES).toByteArray() }
            return String(text, Charsets.UTF_8)
        } finally {
            connection.disconnect()
        }
    }

    /**
     * The SHA-256 fingerprints of the package's signing certificates, as the statement spells
     * them, from the shape the device has (the repo's pattern, `Updates.signerSha256`): API 28's
     * `signingInfo`, or before it – Android 8.0 / 8.1, minSdk 26 – the legacy `signatures`, the
     * only field those levels carry ([AuthTab.SIGNING_INFO_SDK]). Empty for a package that is
     * not installed.
     */
    fun signingFingerprints(context: Context, pkg: String): List<String> {
        val pm = context.packageManager
        val certificates = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val signing = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo
                AuthTab.signerCertificates(
                    multipleSigners = signing?.hasMultipleSigners() == true,
                    apkContentsSigners = signing?.apkContentsSigners?.map { it.toByteArray() },
                    certificateHistory = signing?.signingCertificateHistory?.map { it.toByteArray() }
                )
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures?.map { it.toByteArray() }.orEmpty()
            }
        } catch (e: PackageManager.NameNotFoundException) {
            return emptyList()
        }
        return AuthTab.fingerprintsOf(certificates)
    }

    private const val FETCH_TIMEOUT_MS = 8_000
    /** A statement file past this is not the caller's few lines. */
    private const val MAX_STATEMENT_BYTES = 256 * 1024
}

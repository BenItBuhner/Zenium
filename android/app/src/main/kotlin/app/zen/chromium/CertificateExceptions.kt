package app.zen.chromium

import java.net.URI
import java.security.MessageDigest
import java.util.Base64

/**
 * The server certificates the user proceeded past this session, as the core keeps them
 * (`CertificateExceptions` in `src/core/security.ts`) and mirrors here through
 * `security.allowCertificate`, so `onReceivedSslError` can answer on the spot: per container, per
 * site (host and port) and per certificate, until Zenium quits or the container's data goes.
 * Nothing here is persisted. The WebView remembers a `proceed()` of its own for the profile, so a
 * container forgotten here also has its SSL preferences cleared (see `Security.forgetCertificates`).
 */
class CertificateExceptions {
    private val allowed = HashSet<String>()

    /** Remember `fingerprint` for the site of `url`; false when `url` is not https or the fingerprint is empty. */
    fun allow(containerId: String, url: String, fingerprint: String): Boolean {
        val key = key(containerId, url, fingerprint) ?: return false
        allowed.add(key)
        return true
    }

    fun isAllowed(containerId: String, url: String, fingerprint: String?): Boolean {
        val key = fingerprint?.let { key(containerId, url, it) } ?: return false
        return key in allowed
    }

    /** The container's session ended (private browsing) or its site data was cleared: its exceptions go. */
    fun forgetContainer(containerId: String) {
        allowed.removeAll { it.startsWith("$containerId|") }
    }

    val size: Int get() = allowed.size

    private fun key(containerId: String, url: String, fingerprint: String): String? {
        val site = siteOf(url) ?: return null
        if (fingerprint.isEmpty()) return null
        return "$containerId|$site|$fingerprint"
    }

    companion object {
        /** `host:port` of an https address (443 when it leaves the port out); null for any other URL. */
        fun siteOf(url: String): String? {
            val uri = runCatching { URI(url) }.getOrNull() ?: return null
            if (!"https".equals(uri.scheme, ignoreCase = true)) return null
            val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            val port = if (uri.port == -1) 443 else uri.port
            return "$host:$port"
        }

        /**
         * `sha256/<base64>` of the certificate's DER bytes: the form Chromium prints a certificate
         * hash in (and Electron's `Certificate.fingerprint` carries), so the two hosts' exceptions
         * name a certificate the same way.
         */
        fun fingerprintOf(der: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(der)
            return "sha256/" + Base64.getEncoder().encodeToString(digest)
        }
    }
}

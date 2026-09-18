package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The session's certificate exceptions as the WebView side keeps them (the core's copy decides,
 * `security.allowCertificate` mirrors it here): per container, site and certificate, until the
 * container's data goes.
 */
class CertificateExceptionsTest {
    private val expired = "https://expired.badssl.com/"
    private val fingerprint = "sha256/6vrsUckLNSQnSOaQlHcoKdzhUR9ctSYNeHx0kSVR9gs="

    @Test
    fun `an exception names a container, a site and a certificate`() {
        val exceptions = CertificateExceptions()
        assertFalse(exceptions.isAllowed("default", expired, fingerprint))
        assertTrue(exceptions.allow("default", expired, fingerprint))
        assertTrue(exceptions.isAllowed("default", expired, fingerprint))
        // Any page of the site over that certificate, whatever the case of the host.
        assertTrue(exceptions.isAllowed("default", "https://EXPIRED.badssl.com/deep/page?q=1", fingerprint))
        // Another certificate of the site asks again; another port is another site; another container another session.
        assertFalse(exceptions.isAllowed("default", expired, "sha256/other"))
        assertFalse(exceptions.isAllowed("default", "https://expired.badssl.com:8443/", fingerprint))
        assertFalse(exceptions.isAllowed("private", expired, fingerprint))
        assertEquals(1, exceptions.size)
    }

    @Test
    fun `nothing is remembered for plain http, an empty fingerprint or no fingerprint at all`() {
        val exceptions = CertificateExceptions()
        assertFalse(exceptions.allow("default", "http://plain.example/", fingerprint))
        assertFalse(exceptions.allow("default", expired, ""))
        assertFalse(exceptions.allow("default", "not a url", fingerprint))
        assertEquals(0, exceptions.size)
        assertFalse(exceptions.isAllowed("default", expired, null))
        assertFalse(exceptions.isAllowed("default", expired, ""))
    }

    @Test
    fun `a container's exceptions go together, and no other's`() {
        val exceptions = CertificateExceptions()
        exceptions.allow("default", expired, fingerprint)
        exceptions.allow("private", expired, fingerprint)
        exceptions.allow("private", "https://self-signed.badssl.com/", "sha256/self")
        exceptions.forgetContainer("private")
        assertFalse(exceptions.isAllowed("private", expired, fingerprint))
        assertFalse(exceptions.isAllowed("private", "https://self-signed.badssl.com/", "sha256/self"))
        assertTrue(exceptions.isAllowed("default", expired, fingerprint))
        assertEquals(1, exceptions.size)
        // A container whose id begins like another's is not swept up with it.
        exceptions.allow("work", expired, fingerprint)
        exceptions.allow("work2", expired, fingerprint)
        exceptions.forgetContainer("work")
        assertFalse(exceptions.isAllowed("work", expired, fingerprint))
        assertTrue(exceptions.isAllowed("work2", expired, fingerprint))
    }

    @Test
    fun `the site is the https host and port, 443 when left out`() {
        assertEquals("expired.badssl.com:443", CertificateExceptions.siteOf("https://Expired.BadSSL.com/"))
        assertEquals("self-signed.badssl.com:8443", CertificateExceptions.siteOf("https://self-signed.badssl.com:8443/a?b#c"))
        assertNull(CertificateExceptions.siteOf("http://plain.example/"))
        assertNull(CertificateExceptions.siteOf("zen://error?url=https%3A%2F%2Fa.example%2F"))
        assertNull(CertificateExceptions.siteOf("https:///nohost"))
        assertNull(CertificateExceptions.siteOf("not a url"))
        assertNull(CertificateExceptions.siteOf(""))
    }

    @Test
    fun `the fingerprint is Chromium's sha256 slash base64 of the DER bytes`() {
        // SHA-256 of no bytes and of "abc": the published test vectors, base64.
        assertEquals("sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=", CertificateExceptions.fingerprintOf(ByteArray(0)))
        assertEquals("sha256/ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=", CertificateExceptions.fingerprintOf("abc".toByteArray()))
        // The same bytes name the same certificate; a byte's difference another.
        val der = byteArrayOf(0x30, 0x82.toByte(), 0x01, 0x0a)
        assertEquals(CertificateExceptions.fingerprintOf(der), CertificateExceptions.fingerprintOf(der.copyOf()))
        assertFalse(CertificateExceptions.fingerprintOf(der) == CertificateExceptions.fingerprintOf(byteArrayOf(0x30, 0x82.toByte(), 0x01, 0x0b)))
    }
}

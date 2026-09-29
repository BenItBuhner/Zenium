package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The refusal the host answers for a request Chrome fails as a network error is read by the
 * extension page's `fetch` patch (`extensionCorsProxy.ts`, `NET_ERROR_HEADER`): the header's name
 * is the contract between the two sides, and the codes are Chrome's own error names.
 */
class NetErrorAnswerTest {
    @Test
    fun `the header and the codes are the page side's and Chrome's`() {
        assertEquals("X-Zenium-Net-Error", NetErrorAnswer.HEADER)
        assertEquals("ERR_BLOCKED_BY_CLIENT", NetErrorAnswer.BLOCKED)
        assertEquals("ERR_FILE_NOT_FOUND", NetErrorAnswer.FILE_NOT_FOUND)
    }

    @Test
    fun `a refusal carries its code and exposes the header to a cross-origin reader`() {
        // Another extension's page fetching this one's file is a cross-origin reader; without the
        // exposure its `fetch` could not see the header and would resolve the 404 as Chrome never does.
        assertEquals(
            mapOf("X-Zenium-Net-Error" to "ERR_BLOCKED_BY_CLIENT", "Access-Control-Expose-Headers" to "X-Zenium-Net-Error"),
            NetErrorAnswer.headers(NetErrorAnswer.BLOCKED)
        )
        assertEquals("ERR_FILE_NOT_FOUND", NetErrorAnswer.headers(NetErrorAnswer.FILE_NOT_FOUND)[NetErrorAnswer.HEADER])
    }
}

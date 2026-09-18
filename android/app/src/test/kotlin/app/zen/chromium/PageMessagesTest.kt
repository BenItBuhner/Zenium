package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageMessagesTest {
    private val token = "s3cret"

    private fun message(vararg pairs: Pair<String, Any?>): String =
        json("token" to token, *pairs).toString()

    @Test
    fun messagesWithoutThisSessionsTokenAreIgnored() {
        assertEquals(PageMessageRoute.Ignore, routePageMessage(null, token))
        assertEquals(PageMessageRoute.Ignore, routePageMessage("not json", token))
        assertEquals(PageMessageRoute.Ignore, routePageMessage("""{"type":"domReady"}""", token))
        assertEquals(PageMessageRoute.Ignore, routePageMessage("""{"token":"other","type":"domReady"}""", token))
    }

    @Test
    fun helloEvalResultAndDomReadyAreTheViewsOwn() {
        assertEquals(PageMessageRoute.Hello, routePageMessage(message("type" to "hello"), token))
        assertEquals(
            PageMessageRoute.EvalResult(7, "\"title\""),
            routePageMessage(message("type" to "evalResult", "id" to 7, "value" to "\"title\""), token)
        )
        assertEquals(
            PageMessageRoute.EvalResult(8, null),
            routePageMessage(message("type" to "evalResult", "id" to 8, "value" to null), token)
        )
        assertEquals(PageMessageRoute.DomReady, routePageMessage(message("type" to "domReady"), token))
    }

    @Test
    fun anythingElseGoesToTheCoreWithoutTheToken() {
        val route = routePageMessage(message("type" to "media", "playing" to true), token)
        assertTrue(route is PageMessageRoute.Forward)
        val forwarded = (route as PageMessageRoute.Forward).message
        assertFalse(forwarded.has("token"))
        assertEquals("media", forwarded.getString("type"))
        assertTrue(forwarded.getBoolean("playing"))
    }

    @Test
    fun theGateRaisesDomReadyOnceAtTheScriptsMessageAndNotAgainAtPageFinished() {
        val gate = DomReadyGate()
        gate.documentStarted()
        assertTrue(gate.scriptReady())
        assertFalse("a second DOMContentLoaded message must not raise it again", gate.scriptReady())
        assertFalse("page finished after the script reported must not raise it again", gate.pageFinished())
    }

    @Test
    fun theGateFallsBackToPageFinishedWhenTheScriptNeverReported() {
        val gate = DomReadyGate()
        gate.documentStarted()
        assertTrue(gate.pageFinished())
        assertFalse("a late script message after the fallback must not raise it again", gate.scriptReady())
    }

    @Test
    fun aNewDocumentArmsTheGateAgain() {
        val gate = DomReadyGate()
        gate.documentStarted()
        assertTrue(gate.scriptReady())
        gate.documentStarted()
        assertTrue("the next document gets its own domReady", gate.scriptReady())
        assertFalse(gate.pageFinished())
    }

    @Test
    fun aRestoredViewWithNoPageStartedStillRaisesOnce() {
        // A view whose first document never went through onPageStarted (loadDataWithBaseURL of a
        // zen:// page) still gets exactly one domReady at page finished.
        val gate = DomReadyGate()
        assertTrue(gate.pageFinished())
        assertFalse(gate.pageFinished())
    }

    @Test
    fun forwardedMessagesKeepTheirPayloadIntact() {
        val payload = JSONObject().put("a", 1).put("b", JSONObject().put("c", "d"))
        val route = routePageMessage(message("type" to "custom", "payload" to payload), token)
        val forwarded = (route as PageMessageRoute.Forward).message
        assertEquals(1, forwarded.getJSONObject("payload").getInt("a"))
        assertEquals("d", forwarded.getJSONObject("payload").getJSONObject("b").getString("c"))
    }
}

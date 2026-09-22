package app.zen.chromium.ext

import androidx.webkit.ProxyConfig
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure half of the proxy override: the runtime's `ext.proxy.set` message as the builder's terms. */
class ExtensionProxyTest {
    @Test
    fun `the runtime's rules, bypass list and flags are read in order`() {
        val plan = ExtensionProxy.Plan.of(
            JSONObject(
                """{"rules":[{"url":"http://http.proxy.test:8080","scheme":"http"},
                   {"url":"https://tls.proxy.test:443","scheme":"https"},
                   {"url":"socks5://socks.proxy.test:1080","scheme":"*"}],
                   "bypass":["localhost","10.0.2.2"],"bypassSimpleHostnames":false,"removeImplicitRules":true}"""
            )
        )
        assertEquals(listOf("http://http.proxy.test:8080", "https://tls.proxy.test:443", "socks5://socks.proxy.test:1080"), plan.rules.map { it.url })
        assertEquals(listOf(ProxyConfig.MATCH_HTTP, ProxyConfig.MATCH_HTTPS, ProxyConfig.MATCH_ALL_SCHEMES), plan.rules.map { it.scheme })
        assertEquals(listOf("localhost", "10.0.2.2"), plan.bypass)
        assertFalse(plan.bypassSimpleHostnames)
        assertTrue(plan.removeImplicitRules)
    }

    @Test
    fun `a direct rule, an empty message and an unknown scheme filter read as the builder takes them`() {
        val direct = ExtensionProxy.Plan.of(JSONObject("""{"rules":[{"url":"direct://","scheme":"*"}],"bypass":[],"bypassSimpleHostnames":true}"""))
        assertEquals(ExtensionProxy.DIRECT, direct.rules.single().url)
        assertEquals(ProxyConfig.MATCH_ALL_SCHEMES, direct.rules.single().scheme)
        assertTrue(direct.bypassSimpleHostnames)
        assertFalse(direct.removeImplicitRules)

        val empty = ExtensionProxy.Plan.of(JSONObject())
        assertTrue(empty.rules.isEmpty())
        assertTrue(empty.bypass.isEmpty())

        // A rule without a URL is nothing; a filter the builder has no constant for is every scheme.
        val odd = ExtensionProxy.Plan.of(JSONObject("""{"rules":[{"url":"","scheme":"http"},{"url":"http://p.test","scheme":"ftp"}],"bypass":[""]}"""))
        assertEquals(1, odd.rules.size)
        assertEquals(ProxyConfig.MATCH_ALL_SCHEMES, odd.rules.single().scheme)
        assertTrue(odd.bypass.isEmpty())
    }
}

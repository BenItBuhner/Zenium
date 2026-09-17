package app.zen.chromium

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ExternalProtocolsTest {
    /**
     * `VISIBLE_SCHEMES` says which schemes' apps Android 11+ lets Zenium see, which is only true
     * for the schemes the manifest queries: a scheme in one place but not the other would make
     * the sheet say "no app can open this" for a link an installed app handles.
     */
    @Test
    fun everyVisibleSchemeIsQueriedInTheManifest() {
        val manifest = listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
            .map(::File)
            .firstOrNull { it.exists() }
            ?.readText()
        assertTrue("AndroidManifest.xml not found from ${File(".").absolutePath}", manifest != null)
        val queries = manifest!!.substringAfter("<queries>").substringBefore("</queries>")
        val viewQueries = Regex("""<intent>\s*<action android:name="android\.intent\.action\.VIEW" />\s*<data android:scheme="([a-z]+)" />\s*</intent>""")
            .findAll(queries)
            .map { it.groupValues[1] }
            .toSet()
        for (scheme in ExternalProtocols.VISIBLE_SCHEMES) {
            assertTrue("$scheme is in VISIBLE_SCHEMES but has no VIEW query in the manifest", scheme in viewQueries)
        }
    }
}

package app.zen.chromium

import app.zen.chromium.ext.ExtensionPromptFallback
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The install / permission prompt's native fallback ([ExtensionPromptFallback]): the plan the
 * TypeScript host composes (`extensionPromptPlan.ts`) is read whole – title, description, icon,
 * caption, rows with their glyph kinds, Cancel and the verb with its tone – and drawn on the
 * chassis ([NativePromptSheet]) with nothing decided here; its rows' numbers are the renderer's
 * (`.zen-ext-dialog-body`'s 8 gap, `ExtensionIcon`'s corners); the glyph table names one
 * drawable per kind of `warningGlyph.ts`; and the Kotlin side asks through no Material alert.
 */
class ExtensionPromptFallbackTest {
    private val root = repoRoot()

    @Test
    fun thePlanIsReadWhole() {
        val plan = ExtensionPromptFallback.Plan.parse(
            JSONObject()
                .put("title", "Add \"Dark Reader\"?")
                .put("description", "From the Chrome Web Store")
                .put("icon", "data:image/png;base64,iVBORw0KGgo=")
                .put("caption", "It can:")
                .put(
                    "rows",
                    JSONArray()
                        .put(JSONObject().put("glyph", "globe").put("label", "Read and change all your data on all websites").put("deemphasized", false))
                        .put(JSONObject().put("glyph", "history").put("label", "Read your browsing history").put("deemphasized", false))
                )
                .put("secondary", "Cancel")
                .put("primary", JSONObject().put("label", "Add extension").put("tone", "accent"))
        )
        assertEquals("Add \"Dark Reader\"?", plan.title)
        assertEquals("From the Chrome Web Store", plan.description)
        assertEquals("data:image/png;base64,iVBORw0KGgo=", plan.icon)
        assertEquals("It can:", plan.caption)
        assertEquals(listOf("globe", "history"), plan.rows.map { it.glyph })
        assertEquals("Read your browsing history", plan.rows[1].label)
        assertFalse(plan.rows[0].deemphasized)
        assertEquals("Cancel", plan.secondary)
        assertEquals("Add extension", plan.primary)
        assertFalse(plan.destructive)
    }

    @Test
    fun aPlanWithNothingToWarnOfAndNoIdentityReadsAsSuch() {
        val plan = ExtensionPromptFallback.Plan.parse(
            JSONObject()
                .put("title", "\"Plain\" wants additional permissions")
                .put("description", JSONObject.NULL)
                .put("icon", JSONObject.NULL)
                .put("caption", JSONObject.NULL)
                .put("rows", JSONArray().put(JSONObject().put("glyph", JSONObject.NULL).put("label", "No new permissions are needed").put("deemphasized", true)))
                .put("secondary", "Cancel")
                .put("primary", JSONObject().put("label", "Allow").put("tone", "accent"))
        )
        assertNull(plan.description)
        assertNull(plan.icon)
        assertNull(plan.caption)
        assertNull(plan.rows.single().glyph)
        assertTrue(plan.rows.single().deemphasized)
        // §6: a destructive verb is the danger tone; the plan's tone decides, nothing here.
        val remove = ExtensionPromptFallback.Plan.parse(
            JSONObject().put("title", "Remove \"Plain\"?").put("primary", JSONObject().put("label", "Remove").put("tone", "danger"))
        )
        assertTrue(remove.destructive)
        assertNull(remove.secondary)
        assertTrue(remove.rows.isEmpty())
    }

    /** The glyph table covers `warningGlyph.ts`'s union exactly, and a drawable exists for each entry. */
    @Test
    fun theGlyphTableIsTheWarningGlyphUnion() {
        val union = Regex("""export type WarningGlyph =([\s\S]*?)\n\n""")
            .find(File(root, "src/renderer/src/lib/extensions/warningGlyph.ts").readText())!!
            .groupValues[1]
            .let { Regex("""'([a-z-]+)'""").findAll(it).map { m -> m.groupValues[1] }.toSet() }
        assertTrue(union.size > 20)
        assertEquals(union, ExtensionPromptFallback.Plan.GLYPHS.keys)
        for (kind in union) {
            val file = File(root, "android/app/src/main/res/drawable/ic_warn_${kind.replace('-', '_')}.xml")
            assertTrue("a drawable for $kind", file.isFile)
            // Lucide's 24 grid at the phone's stroke (`--v2-icon-stroke` 1.75), as ic_globe is drawn.
            val xml = file.readText()
            assertTrue("$kind on the 24 grid", xml.contains("android:viewportWidth=\"24\""))
            assertTrue("$kind at the phone's stroke", xml.contains("android:strokeWidth=\"1.75\""))
        }
        assertEquals("the phone's icon stroke", "1.75", Regex("""--v2-icon-stroke: ([\d.]+);""").findAll(File(root, "src/renderer/src/assets/main.css").readText()).map { it.groupValues[1] }.toSet().maxOrNull())
    }

    /** The renderer's numbers the rows take: the caption's 8 to the rows, the icon's corners. */
    @Test
    fun theRowsTakeTheRenderersNumbers() {
        val extensionsCss = File(root, "src/renderer/src/assets/extensions.css").readText().replace(Regex("""/\*[\s\S]*?\*/"""), "")
        val body = Regex("""\.zen-ext-dialog-body \{([^}]*)\}""").find(extensionsCss)!!.groupValues[1]
        assertEquals(PromptSheetSpec.CAPTION_GAP_DP, Regex("""gap: (\d+)px;""").find(body)!!.groupValues[1].toInt())
        val icon = File(root, "src/renderer/src/components/extensions/ExtensionIcon.tsx").readText()
        val corners = Regex("""borderRadius: size >= (\d+) \? (\d+) : (\d+)""").find(icon)!!.groupValues.drop(1).map { it.toInt() }
        assertEquals(corners[1], ExtensionPromptFallback.Plan.iconRadiusDp(corners[0]))
        assertEquals(corners[2], ExtensionPromptFallback.Plan.iconRadiusDp(corners[0] - 1))
        assertEquals("the phone's glyph is under the larger-corner size", corners[2], ExtensionPromptFallback.Plan.iconRadiusDp(PromptSheetSpec.GLYPH_DP))
    }

    /** The fallback is the chassis: no Material alert on the store's path, the Host routes the bridge method to it. */
    @Test
    fun theFallbackIsTheChassisNotAnAlert() {
        val fallback = File(root, "android/app/src/main/kotlin/app/zen/chromium/ext/ExtensionPromptFallback.kt").readText()
        assertTrue(fallback.contains("NativePromptSheet(activity, ink, content)"))
        assertTrue(fallback.contains("V2Ink(activity, host.themeDark)"))
        assertFalse(fallback.contains("AlertDialog"))
        assertFalse(fallback.contains("R.color."))
        val host = File(root, "android/app/src/main/kotlin/app/zen/chromium/Host.kt").readText()
        assertTrue(host.contains("\"extStore.prompt\" -> extPrompt.show(args, reply)"))
        val ts = File(root, "src/android/extensionHost.ts").readText()
        assertFalse("the Android host asks through no native message box", ts.contains("dialogs.confirm("))
        assertTrue(ts.contains("this.io.prompt(nativePromptPlan(request))"))
    }

    private companion object {
        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }
    }
}

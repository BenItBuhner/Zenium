package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A content script's dynamic `import()` calls as its file goes into its unit: a relative specifier
 * resolved against the file's own served URL as Chrome resolves it against its `chrome-extension://`
 * URL, and the keyword rewritten to the bootstrap's helper so the promise the script awaits resolves
 * past the page's policy as Chrome's does.
 */
class RelativeImportsTest {
    private val id = "amfojhdiedpdnlijjbhjnhokbnohfdfb"
    private val origin = "https://$id.ext.zenium.invalid"

    private fun rewritten(text: String, path: String, ownImport: Boolean = true): String {
        val sb = StringBuilder()
        RelativeImports.source(text, RelativeImports.edits(text, id, path, ownImport), transient = false).appendTo(sb)
        return sb.toString()
    }

    @Test
    fun `resolves a relative specifier against the file's directory, up past it and from the root`() {
        val path = "src/pages/contentInject/index.js"
        // eJOY's Vite loader, verbatim in shape.
        assertEquals("$origin/assets/js/inject.Cb-54asq.js", RelativeImports.resolve(id, path, "../../../assets/js/inject.Cb-54asq.js"))
        assertEquals("$origin/src/pages/contentInject/b.js", RelativeImports.resolve(id, path, "./b.js"))
        assertEquals("$origin/src/pages/b.js", RelativeImports.resolve(id, path, "../b.js"))
        assertEquals("$origin/c.js", RelativeImports.resolve(id, path, "/c.js"))
        // More `..` than directories: dropped at the root, as a URL parser drops them.
        assertEquals("$origin/x.js", RelativeImports.resolve(id, path, "../../../../../x.js"))
        // A leading slash on the file's own path, a query and a fragment on the specifier.
        assertEquals("$origin/chunk.js?v=2#top", RelativeImports.resolve(id, "/content.js", "./chunk.js?v=2#top"))
        assertEquals("$origin/x.js", RelativeImports.resolve(id, "content.js", "./x.js"))
    }

    @Test
    fun `rewrites the string-literal calls and leaves every other specifier as written`() {
        val text = """
            |c(()=>import("../../../assets/js/inject.Cb-54asq.js").then(n=>n.i),__vite__mapDeps([]));
            |const a = await import('./b.js');
            |const b = await import( "/c.js" , { with: { type: "json" } } );
            |import("https://cdn.example/x.js");
            |import(chrome.runtime.getURL("y.js"));
            |import("//cdn.example/x.js");
            |loader.import("./z.js"); ${'$'}import("./z.js"); reimport("./z.js");
            |import(`./t.js`);
            |import("bare-specifier");
        """.trimMargin()
        // The keyword kept (a `world: "MAIN"` group's): the specifiers alone.
        val out = rewritten(text, "src/pages/contentInject/index.js", ownImport = false)
        assertTrue(out.contains("""import("$origin/assets/js/inject.Cb-54asq.js").then(n=>n.i)"""))
        assertTrue(out.contains("""import('$origin/src/pages/contentInject/b.js')"""))
        assertTrue(out.contains("""import( "$origin/c.js" , { with"""))
        assertTrue(out.contains("""import("https://cdn.example/x.js")"""))
        assertTrue(out.contains("""import(chrome.runtime.getURL("y.js"))"""))
        assertTrue(out.contains("""import("//cdn.example/x.js")"""))
        assertTrue(out.contains("""loader.import("./z.js"); ${'$'}import("./z.js"); reimport("./z.js");"""))
        assertTrue(out.contains("import(`./t.js`)"))
        assertTrue(out.contains("""import("bare-specifier")"""))
        assertFalse(out.contains(RelativeImports.HELPER))
        assertEquals(3, RelativeImports.edits(text, id, "src/pages/contentInject/index.js", ownImport = false).size)
    }

    @Test
    fun `rewrites every dynamic import keyword of a content script to the helper and no other import`() {
        val text = """
            |import x from "./static.js";
            |import { y } from './named.js';
            |import "./side-effect.js";
            |const base = import.meta.url;
            |await import(T.runtime.getURL(`connectors/${'$'}{s?.js}`));
            |const a = await import('./b.js');
            |import( "/c.js" , { with: { type: "json" } } );
            |import("https://cdn.example/x.js").then(m => m.default);
            |loader.import("./z.js"); ${'$'}import("./z.js"); reimport("./z.js"); obj.import ("./z.js");
            |foo
            |import("./after-newline.js")
            |if (cond) import ( spec )
        """.trimMargin()
        val out = rewritten(text, "content/main.js")
        val h = RelativeImports.HELPER
        // Web Scrobbler's computed call, the keyword alone.
        assertTrue(out.contains("await $h(T.runtime.getURL(`connectors/${'$'}{s?.js}`));"))
        // The keyword and a relative literal together: one edit each, in order.
        assertTrue(out.contains("const a = await $h('$origin/content/b.js');"))
        assertTrue(out.contains("""$h( "$origin/c.js" , { with: { type: "json" } } );"""))
        assertTrue(out.contains("""$h("https://cdn.example/x.js").then(m => m.default);"""))
        // A line without a semicolon before the call: the identifier keeps the two statements apart as the keyword did.
        assertTrue(out.contains("foo\n$h(\"$origin/content/after-newline.js\")"))
        assertTrue(out.contains("if (cond) $h ( spec )"))
        // Static declarations, `import.meta`, members and longer names as written.
        assertTrue(out.contains("""import x from "./static.js";"""))
        assertTrue(out.contains("import { y } from './named.js';"))
        assertTrue(out.contains("""import "./side-effect.js";"""))
        assertTrue(out.contains("const base = import.meta.url;"))
        assertTrue(out.contains("""loader.import("./z.js"); ${'$'}import("./z.js"); reimport("./z.js"); obj.import ("./z.js");"""))
        // Six keyword edits, three of them with a literal to resolve as well.
        val edits = RelativeImports.edits(text, id, "content/main.js")
        assertEquals(9, edits.size)
        assertEquals(6, edits.count { it.replacement == h })
        // In order of position, never overlapping: what the copy relies on.
        for (i in 1 until edits.size) assertTrue(edits[i].start >= edits[i - 1].end)
        // The identifier the bootstrap binds in the scope; the TypeScript side names the same.
        assertEquals("__zenExtImport", h)
    }

    @Test
    fun `a file without one costs no edit and a source with edits reports the length it will write`() {
        assertTrue(RelativeImports.edits("console.log('important')", id, "cs.js").isEmpty())
        assertTrue(RelativeImports.edits("importScripts('./w.js')", id, "cs.js").isEmpty())
        assertTrue(RelativeImports.edits("import a from './a.js'; import.meta.url", id, "cs.js").isEmpty())
        val text = """import("./a.js");import("./a.js")"""
        for (ownImport in listOf(true, false)) {
            val edits = RelativeImports.edits(text, id, "dir/cs.js", ownImport)
            val source = RelativeImports.source(text, edits, transient = false)
            val sb = StringBuilder()
            source.appendTo(sb)
            assertEquals(sb.length, source.length)
            val call = if (ownImport) RelativeImports.HELPER else "import"
            assertEquals("""$call("$origin/dir/a.js");$call("$origin/dir/a.js")""", sb.toString())
        }
    }

    @Test
    fun `a transient source is written once and then released`() {
        val text = """import("./a.js")"""
        val source = RelativeImports.source(text, RelativeImports.edits(text, id, "cs.js"), transient = true)
        val sb = StringBuilder()
        source.appendTo(sb)
        assertEquals("""${RelativeImports.HELPER}("$origin/a.js")""", sb.toString())
        val second = runCatching { source.appendTo(StringBuilder()) }
        assertTrue(second.exceptionOrNull() is IllegalStateException)
    }
}

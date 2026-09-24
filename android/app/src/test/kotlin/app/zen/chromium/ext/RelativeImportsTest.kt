package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A content script's relative `import()` specifiers, resolved against the file's own served URL as Chrome resolves them against its `chrome-extension://` URL. */
class RelativeImportsTest {
    private val id = "amfojhdiedpdnlijjbhjnhokbnohfdfb"
    private val origin = "https://$id.ext.zenium.invalid"

    private fun rewritten(text: String, path: String): String {
        val sb = StringBuilder()
        RelativeImports.source(text, RelativeImports.edits(text, id, path), transient = false).appendTo(sb)
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
    fun `rewrites the string-literal calls and leaves every other import as written`() {
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
        val out = rewritten(text, "src/pages/contentInject/index.js")
        assertTrue(out.contains("""import("$origin/assets/js/inject.Cb-54asq.js").then(n=>n.i)"""))
        assertTrue(out.contains("""import('$origin/src/pages/contentInject/b.js')"""))
        assertTrue(out.contains("""import( "$origin/c.js" , { with"""))
        assertTrue(out.contains("""import("https://cdn.example/x.js")"""))
        assertTrue(out.contains("""import(chrome.runtime.getURL("y.js"))"""))
        assertTrue(out.contains("""import("//cdn.example/x.js")"""))
        assertTrue(out.contains("""loader.import("./z.js"); ${'$'}import("./z.js"); reimport("./z.js");"""))
        assertTrue(out.contains("import(`./t.js`)"))
        assertTrue(out.contains("""import("bare-specifier")"""))
        assertEquals(3, RelativeImports.edits(text, id, "src/pages/contentInject/index.js").size)
    }

    @Test
    fun `a file without one costs no edit and a source with edits reports the length it will write`() {
        assertTrue(RelativeImports.edits("console.log('important')", id, "cs.js").isEmpty())
        assertTrue(RelativeImports.edits("importScripts('./w.js')", id, "cs.js").isEmpty())
        val text = """import("./a.js");import("./a.js")"""
        val edits = RelativeImports.edits(text, id, "dir/cs.js")
        val source = RelativeImports.source(text, edits, transient = false)
        val sb = StringBuilder()
        source.appendTo(sb)
        assertEquals(sb.length, source.length)
        assertEquals("""import("$origin/dir/a.js");import("$origin/dir/a.js")""", sb.toString())
    }

    @Test
    fun `a transient source is written once and then released`() {
        val text = """import("./a.js")"""
        val source = RelativeImports.source(text, RelativeImports.edits(text, id, "cs.js"), transient = true)
        val sb = StringBuilder()
        source.appendTo(sb)
        assertEquals("""import("$origin/a.js")""", sb.toString())
        val second = runCatching { source.appendTo(StringBuilder()) }
        assertTrue(second.exceptionOrNull() is IllegalStateException)
    }
}

package app.zen.chromium.ext

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The page's `contextmenu` event for a long press the embedder answered with the sheet: the
 * hold's point goes from the sheet anchor (dp in the view's parent) to the view's own pixels,
 * and into a script the WebView evaluates in the main frame.
 */
class ContextMenuEventTest {
    @Test
    fun `the sheet anchor goes back to the view's own pixels`() {
        // `TabWebView.onLongPress`: anchorX = (left + lastTouchX) / density; the page wants lastTouchX.
        assertEquals(300.0, ContextMenuEvent.viewPixels(100.0, 0, 3f), 1e-9)
        assertEquals(420.0, ContextMenuEvent.viewPixels(200.0, 180, 3f), 1e-9)
        assertEquals(63.0, ContextMenuEvent.viewPixels(42.0, 0, 1.5f), 1e-9)
        // A point the host never had is the view's corner, not NaN in a script.
        assertEquals(0.0, ContextMenuEvent.viewPixels(Double.NaN, 180, 3f), 0.0)
        assertEquals(0.0, ContextMenuEvent.viewPixels(Double.POSITIVE_INFINITY, 0, 3f), 0.0)
    }

    @Test
    fun `the script is one expression over the two numbers, written with a decimal point in every locale`() {
        val before = Locale.getDefault()
        Locale.setDefault(Locale.GERMANY)
        try {
            val script = ContextMenuEvent.script(300.0, 1234.5)
            assertTrue(script, script.startsWith("(function(x,y){try{"))
            // German would write 1234,50 and break the argument list.
            assertTrue(script, script.endsWith("})(300.00,1234.50)"))
            assertFalse(script, script.contains("1234,50"))
            // A number the host could not make is the view's corner, never `NaN` or `Infinity` in the page.
            assertEquals("})(0.00,0.00)", ContextMenuEvent.script(Double.NaN, Double.NEGATIVE_INFINITY).substringAfterLast("}catch(e){return 'error: '+e}"))
        } finally {
            Locale.setDefault(before)
        }
    }

    @Test
    fun `the script dispatches Chrome's pair at the point under the finger, through the visual viewport, into a same-origin frame`() {
        val script = ContextMenuEvent.script(10.0, 20.0)
        // The view's pixels to the layout viewport's CSS pixels: the device pixel ratio, then the pinch zoom and its offset.
        assertTrue(script.contains("var cx=x/dpr,cy=y/dpr;"))
        assertTrue(script.contains("cx=cx/vv.scale+vv.offsetLeft;cy=cy/vv.scale+vv.offsetTop"))
        // Chrome's compatibility `mousemove`, then the `contextmenu` – a PointerEvent of the touch with no button, bubbling and cancelable.
        assertTrue(script.contains("new win.MouseEvent('mousemove',init)"))
        assertTrue(script.contains("new (win.PointerEvent||win.MouseEvent)('contextmenu',init)"))
        assertTrue(script.contains("bubbles:true,cancelable:true,composed:true"))
        assertTrue(script.contains("button:0,buttons:0,pointerId:2,pointerType:'touch',isPrimary:true"))
        // A same-origin frame under the point is entered with the point moved into it; a cross-origin one's document throws or is null and the frame element is the target.
        assertTrue(script.contains("el.tagName==='IFRAME'||el.tagName==='FRAME'"))
        assertTrue(script.contains("try{inner=el.contentDocument}catch(e){inner=null}"))
        assertTrue(script.contains("cx-=r.left+el.clientLeft;cy-=r.top+el.clientTop"))
        // Nothing under the point (a hold past the document) still tells the page: the body is the target.
        assertTrue(script.contains("if(!target){target=document.body||document.documentElement;targetDoc=document}"))
        // The answer the host logs on: the page's handler threw, or prevented a menu this host cannot withhold.
        assertTrue(script.contains("return ev.defaultPrevented?'prevented':'dispatched'"))
        assertTrue(script.contains("catch(e){return 'error: '+e}"))
    }
}

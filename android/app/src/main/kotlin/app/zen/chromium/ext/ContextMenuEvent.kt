package app.zen.chromium.ext

import java.util.Locale

/**
 * The page's DOM `contextmenu` event for a long press the embedder answered itself.
 *
 * Chrome dispatches `contextmenu` at a long press's point before it shows its menu (Blink's
 * `GestureManager::SendContextMenuEventForGesture`: a compatibility `mousemove` to the element
 * under the finger, then a `contextmenu` with no button and the gesture's `pointerType`), and
 * content scripts listen for it – Auto Clicker keeps the last one for the element its menu item
 * acts on. Zenium's `TabWebView.onLongPress` answers a link or image hold with the page sheet, and
 * a long press the embedder handles never reaches the renderer (`LinkHits`), so the page hears
 * nothing. The runtime, asked for the extensions' `chrome.contextMenus` items while the sheet is
 * built, has the host dispatch this event into the tab at the hold's point (`ext.contextMenuEvent`).
 *
 * The script takes the point in the view's own pixels and maps it through the visual viewport
 * (pinch zoom, the overview zoom of a desktop-layout page) to the layout viewport's CSS pixels,
 * finds the element there – descending into a same-origin frame, since `evaluateJavascript` runs
 * in the main frame and a cross-origin frame's document is out of reach – and dispatches the
 * two events on it. A page cannot prevent the sheet through it (the sheet is built before the
 * event lands), and the event is `isTrusted: false`, as every dispatched one is.
 */
object ContextMenuEvent {
    /** The hold's position in the view's own pixels, from the sheet anchor (dp in the view's parent, `TabWebView.onLongPress`). */
    fun viewPixels(anchorDp: Double, viewOffsetPx: Int, density: Float): Double =
        if (anchorDp.isFinite()) anchorDp * density - viewOffsetPx else 0.0

    /** A JavaScript expression dispatching the events at ([xPx], [yPx]); it answers `dispatched`, `prevented`, `none` or `error: …`. */
    fun script(xPx: Double, yPx: Double): String = "(function(x,y){" + BODY + "})(${number(xPx)},${number(yPx)})"

    private fun number(v: Double): String = String.format(Locale.ROOT, "%.2f", if (v.isFinite()) v else 0.0)

    private const val BODY =
        "try{" +
            "var vv=window.visualViewport,dpr=window.devicePixelRatio||1;" +
            "var cx=x/dpr,cy=y/dpr;" +
            "if(vv){cx=cx/vv.scale+vv.offsetLeft;cy=cy/vv.scale+vv.offsetTop}" +
            "var doc=document,target=null,targetDoc=document;" +
            "for(var depth=0;depth<8;depth++){" +
            "var el=doc.elementFromPoint(cx,cy)||(depth?doc.body||doc.documentElement:null);" +
            "if(!el)break;" +
            "target=el;targetDoc=doc;" +
            "var inner=null;" +
            "if(el.tagName==='IFRAME'||el.tagName==='FRAME'){try{inner=el.contentDocument}catch(e){inner=null}}" +
            "if(!inner)break;" +
            "var r=el.getBoundingClientRect();" +
            "cx-=r.left+el.clientLeft;cy-=r.top+el.clientTop;" +
            "doc=inner" +
            "}" +
            "if(!target){target=document.body||document.documentElement;targetDoc=document}" +
            "if(!target)return 'none';" +
            "var win=targetDoc.defaultView||window;" +
            "var caps=win.InputDeviceCapabilities?new win.InputDeviceCapabilities({firesTouchEvents:true}):undefined;" +
            "var init={bubbles:true,cancelable:true,composed:true,view:win,sourceCapabilities:caps,clientX:cx,clientY:cy,screenX:cx,screenY:cy,button:0,buttons:0,pointerId:2,pointerType:'touch',isPrimary:true};" +
            "target.dispatchEvent(new win.MouseEvent('mousemove',init));" +
            "var ev=new (win.PointerEvent||win.MouseEvent)('contextmenu',init);" +
            "target.dispatchEvent(ev);" +
            "return ev.defaultPrevented?'prevented':'dispatched'" +
            "}catch(e){return 'error: '+e}"
}

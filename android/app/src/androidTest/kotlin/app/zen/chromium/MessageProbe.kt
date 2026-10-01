package app.zen.chromium

import org.json.JSONObject
import org.json.JSONTokener

/**
 * The page's messages as either door shows them, in one shape. On the touch hosts the install
 * offer, the reader offer, the connectivity state and the phone's default-browser reminder go to
 * the PAGE-EDGE BAND (motion spec §3; the shared model `window.__zenStores.band`, Desktop's
 * `lib/band.ts`); everywhere else – and on the touch hosts until the band's layer mounts – they
 * go to the §9.33 BANNER STACK (`.zen-banner`). A driver that reads "the message up" reads it
 * through here and is the same on either door.
 *
 * [PROBE_JS] answers `{door, count, title, detail, action, actions, key, form, glyph, close,
 * role, top, left, width, height, theme, standing}`: `door` is [DOOR_BAND] when the band shows a
 * message (the entry `chooseBand` picks – a state before an offer, the newest, on the front tab,
 * while the host says a band may show and, for an offer, that offers may – not on a private
 * tab), [DOOR_BANNER] when the stack has a card, `""` when
 * neither. The band's words, key, form and action are the MODEL's; the document is read only for
 * the band's root ([BAND_ROOT] – how many stand, the role, the glyph, where it sits), the one DOM
 * name the band contributes. The banner's fields are the stack's, as the drivers read them before.
 *
 * A band is swiped UP ([swipeUp]); a banner sideways.
 */
object MessageProbe {
    /**
     * The band's root in the chrome's document (`PageEdgeBand`'s `.zen-band`, a `role="status"`
     * region with `data-form` and `data-tone`): the shared content component's one hook read here.
     */
    const val BAND_ROOT = ".zen-band"
    const val DOOR_BAND = "band"
    const val DOOR_BANNER = "banner"

    /** `shown`: the band entry shown now, or null (the model's `chooseBand`, in the page's words). */
    private const val SHOWN_BAND_JS =
        "var S=window.__zenStores&&window.__zenStores.band;var st=S?S.get():null;var shown=null;" +
            "if(st&&st.eligible){var c=st.entries.filter(function(e){return (e.tabId===null||e.tabId===st.front)&&(e.form==='state'||st.offers)});" +
            "shown=c.filter(function(e){return e.form==='state'})[0]||c[0]||null}"

    /** `cards`: the banner stack's cards not leaving, from the UI store (what the stack draws). */
    private const val BANNERS_JS =
        "var U=window.__zenStores&&window.__zenStores.ui;var cards=U?U.get().banners.filter(function(b){return !b.leaving}):[];"

    val PROBE_JS: String =
        "(function(){" + SHOWN_BAND_JS + BANNERS_JS +
            "var o={door:'',count:0,title:'',detail:'',action:'',actions:[],key:'',form:'',glyph:false,close:false,role:''," +
            "standing:st?st.entries.length:0,theme:document.documentElement.getAttribute('data-theme')};" +
            "if(shown){var b=document.querySelectorAll('$BAND_ROOT');var f=b[0];o.door='$DOOR_BAND';o.count=b.length;o.title=shown.title;" +
            "o.detail=shown.detail||'';o.action=shown.action?shown.action.label:'';o.actions=shown.action?[shown.action.label]:[];" +
            "o.key=shown.key;o.form=shown.form;o.close=true;o.closeLabel=shown.closeLabel||'Dismiss';" +
            "if(f){var r=f.getBoundingClientRect();o.role=f.getAttribute('role')||(f.querySelector('[role]')?f.querySelector('[role]').getAttribute('role'):'');" +
            "o.glyph=!!f.querySelector('svg');o.top=Math.round(r.top);o.left=Math.round(r.left);o.width=Math.round(r.width);o.height=Math.round(r.height)}}" +
            "else{var n=document.querySelectorAll('.zen-banner');var g=n[0];if(g){var q=g.getBoundingClientRect();var t=g.querySelector('.zen-banner-title span');" +
            "var a=g.querySelector('.zen-message-button');o.door='$DOOR_BANNER';o.count=n.length;o.title=t?(t.textContent||'').trim():'';" +
            "o.action=a?(a.textContent||'').trim():'';o.actions=o.action?[o.action]:[];o.glyph=!!g.querySelector('.zen-message-glyph');" +
            "o.close=!!g.querySelector('.zen-message-close');o.role=g.getAttribute('role')||'';o.top=Math.round(q.top);o.left=Math.round(q.left);" +
            "o.width=Math.round(q.width);o.height=Math.round(q.height)}else if(cards.length){o.door='$DOOR_BANNER';o.count=cards.length;o.title=cards[0].title||''}}" +
            "return JSON.stringify(o)})()"

    /** The titles of every message standing at either door, `|`-joined: the band's shown entry first, then the stack's cards. */
    val TITLES_JS: String =
        "(function(){" + SHOWN_BAND_JS + BANNERS_JS +
            "return (shown?[shown.title]:[]).concat(cards.map(function(b){return b.title})).join('|')})()"

    /** How many messages stand at either door (the band's entries, shown or waiting, and the stack's cards not leaving), as a string. */
    val LIVE_JS: String =
        "(function(){" + SHOWN_BAND_JS + BANNERS_JS + "return String((st?st.entries.length:0)+cards.length)})()"

    /**
     * Arm the presence log `window.__zenMessages` (or reset it): `shown` while a message's root
     * stands in the document at either door ([BAND_ROOT] or `.zen-banner`), `gone` otherwise; one
     * `querySelector` per DOM change (`childList`, subtree), touching nothing. Read it with
     * [LOG_JS]: `[[ms, 'shown' | 'gone'], …]` on the document's clock.
     */
    val ARM_LOG_JS: String =
        "(function(){var w=window;if(!w.__zenMessages){var log=[];var seen=null;var read=function(){" +
            "var s=document.querySelector('$BAND_ROOT, .zen-banner')?'shown':'gone';" +
            "if(s!==seen){seen=s;log.push([Math.round(performance.now()),s]);}};" +
            "new MutationObserver(read).observe(document.body,{subtree:true,childList:true});" +
            "w.__zenMessages={log:log,reset:function(){log.length=0;seen=null;read();}};read();}else{w.__zenMessages.reset();}return 'armed'})()"

    const val LOG_JS = "(function(){var b=window.__zenMessages;return b?JSON.stringify(b.log):'[]'})()"

    /** [PROBE_JS]'s answer as the chrome's `evaluateJavascript` hands it back (a JSON-quoted string), parsed; `{}` when it is not one. */
    fun parse(raw: String): JSONObject {
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw
        return runCatching { JSONObject(text) }.getOrDefault(JSONObject())
    }

    /** Whether the probe read the band (else the banner stack, or nothing). */
    fun isBand(probe: JSONObject): Boolean = probe.optString("door") == DOOR_BAND

    /**
     * How far up (px) a finger travels to take the band off: past its height – the probe's root
     * height when the root is found, else the two-line band's (76 CSS px) – with a margin, so the
     * release is well past the half-height rule (§3.2).
     */
    fun swipeUp(probe: JSONObject, density: Float): Float {
        val height = probe.optInt("height", 0).takeIf { it > 0 } ?: 76
        return height * density * 1.25f
    }
}

package app.zen.chromium

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import android.os.IBinder
import android.os.Parcel
import android.os.RemoteException
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.IntentCompat

/**
 * An Auth Tab's session (CCT-13; androidx.browser 1.9.0's `AuthTabSessionToken`): the client's
 * `AuthTabCallback` binder it made through the service's `newAuthTabSession`, or the
 * `PendingIntent` id of a pending session, carried on the intent under the custom tab's own
 * `EXTRA_SESSION` / `EXTRA_SESSION_ID`. Equal by binder, else by id, as the library's token is.
 *
 * On the wire by hand: the 1.9.0 library that generates these two AIDL transactions asks for
 * compileSdk 36 and AGP 8.9.1, which this build does not have, so the provider speaks them
 * itself. The layouts are the library's binary contract, as fixed as the extras' strings: the
 * browser library's AIDL pins every transaction id explicitly (`ICustomTabsService`'s run 2…16,
 * then 18 – 17 is a gap, not a slot to close), so a later release can only add ids, never move
 * these. The service's `newAuthTabSession(IAuthTabCallback, Bundle)` is
 * [TRANSACTION_NEW_AUTH_TAB_SESSION] (the callback binder, then a typed bundle: a 1 and the
 * bundle, or a 0; the reply a no-exception header and a boolean int), and the callback's
 * `onNavigationEvent(int, Bundle)` is [TRANSACTION_ON_NAVIGATION_EVENT], one-way (the event,
 * then the typed bundle). `AuthTabTest` pins both numbers against the compiled 1.9.0 stubs.
 */
class AuthTabSession(val callback: IBinder?, val id: PendingIntent?) {
    /** `AuthTabCallback.onNavigationEvent`: the same `CustomTabsCallback.NAVIGATION_*` codes a custom tab's session hears. */
    fun navigationEvent(event: Int) {
        val binder = callback ?: return
        val data = Parcel.obtain()
        try {
            data.writeInterfaceToken(CALLBACK_DESCRIPTOR)
            data.writeInt(event)
            data.writeInt(1)
            Bundle().writeToParcel(data, 0)
            binder.transact(TRANSACTION_ON_NAVIGATION_EVENT, data, null, IBinder.FLAG_ONEWAY)
        } catch (e: RemoteException) {
            // The client is gone; its session is cleaned up by its death recipient.
        } finally {
            data.recycle()
        }
    }

    override fun equals(other: Any?): Boolean {
        if (other !is AuthTabSession) return false
        if (callback != null || other.callback != null) return callback == other.callback
        return id != null && id == other.id
    }

    override fun hashCode(): Int = callback?.hashCode() ?: id?.hashCode() ?: 0

    companion object {
        const val SERVICE_DESCRIPTOR = "android.support.customtabs.ICustomTabsService"
        const val CALLBACK_DESCRIPTOR = "android.support.customtabs.IAuthTabCallback"
        /** `ICustomTabsService.Stub.TRANSACTION_newAuthTabSession` in androidx.browser 1.9.0. */
        const val TRANSACTION_NEW_AUTH_TAB_SESSION = IBinder.FIRST_CALL_TRANSACTION + 17
        /** `IAuthTabCallback.Stub.TRANSACTION_onNavigationEvent` in androidx.browser 1.9.0. */
        const val TRANSACTION_ON_NAVIGATION_EVENT = IBinder.FIRST_CALL_TRANSACTION + 1

        /**
         * The session an Auth Tab's intent names (`AuthTabSessionToken.createSessionTokenFromIntent`):
         * the callback binder under `EXTRA_SESSION`, the pending id under `EXTRA_SESSION_ID`; null
         * with neither (the builder puts a null binder there when the client made no session).
         */
        fun fromIntent(intent: Intent): AuthTabSession? {
            val extras = intent.extras ?: return null
            val binder = extras.getBinder(CustomTabsIntent.EXTRA_SESSION)
            val id = IntentCompat.getParcelableExtra(intent, CustomTabsIntent.EXTRA_SESSION_ID, PendingIntent::class.java)
            if (binder == null && id == null) return null
            return AuthTabSession(binder, id)
        }

        /**
         * The service side of `newAuthTabSession`, read off the transaction's parcel: the callback
         * binder and the pending id from the extras bundle. Used by [CustomTabsConnectionService]'s
         * binder for [TRANSACTION_NEW_AUTH_TAB_SESSION]; the parcel stands just past its interface token.
         */
        fun readNewSession(data: Parcel): AuthTabSession {
            val binder = data.readStrongBinder()
            val extras = if (data.readInt() != 0) Bundle.CREATOR.createFromParcel(data) else null
            val id = extras?.let { androidx.core.os.BundleCompat.getParcelable(it, CustomTabsIntent.EXTRA_SESSION_ID, PendingIntent::class.java) }
            return AuthTabSession(binder, id)
        }
    }
}

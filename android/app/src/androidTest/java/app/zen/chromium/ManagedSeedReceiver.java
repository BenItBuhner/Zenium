package app.zen.chromium;

import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import java.util.ArrayList;
import java.util.Collections;

/**
 * The managed-configuration driver's hands in the test package's OWN process. The driver
 * (ManagedDemo) runs inside Zenium's process under Zenium's uid, and Android's device policy
 * calls that act as the device owner – setting an app's restrictions, giving the ownership back
 * – are refused unless they come from the uid that owns the admin ({@link ManagedTestAdmin}, the
 * test package's; the first run's {@code SecurityException: Admin ... is not owned by uid}). So
 * the driver sends this receiver an ORDERED broadcast, the system starts the test package's
 * process to deliver it, and the call is made here as the owner: {@link #ACTION_SEED} sets the
 * bundle the intent carries on the package it names; {@link #ACTION_RELEASE} clears that
 * package's bundle and clears the device owner (the owner's own {@code clearDeviceOwnerApp}).
 * The outcome goes back as the broadcast's result: {@link Activity#RESULT_OK} with a note, or
 * {@link Activity#RESULT_CANCELED} with the exception's text.
 *
 * Test-only, like the admin: exported so the driver's process can reach it, and only ever able
 * to act while the shell has made this test package the device owner for a run. Nothing in
 * Zenium references it. Plain Java on framework classes only, as {@link ShareTargetActivity} is:
 * the test package's own process has no Kotlin runtime.
 */
public class ManagedSeedReceiver extends BroadcastReceiver {
    public static final String ACTION_SEED = "app.zen.chromium.test.MANAGED_SEED";
    public static final String ACTION_RELEASE = "app.zen.chromium.test.MANAGED_RELEASE";
    /** The package whose restrictions are set or cleared (Zenium's). */
    public static final String EXTRA_PACKAGE = "package";
    /** The app-restrictions bundle to set ({@link #ACTION_SEED}). */
    public static final String EXTRA_RESTRICTIONS = "restrictions";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!isOrderedBroadcast()) return;
        String action = intent.getAction();
        String target = intent.getStringExtra(EXTRA_PACKAGE);
        if (action == null || target == null) {
            setResult(Activity.RESULT_CANCELED, "no action or no package on the intent", null);
            return;
        }
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, ManagedTestAdmin.class);
        try {
            if (ACTION_SEED.equals(action)) {
                Bundle restrictions = intent.getBundleExtra(EXTRA_RESTRICTIONS);
                if (restrictions == null) restrictions = new Bundle();
                dpm.setApplicationRestrictions(admin, target, restrictions);
                ArrayList<String> keys = new ArrayList<>(restrictions.keySet());
                Collections.sort(keys);
                setResult(Activity.RESULT_OK, "set " + keys + " on " + target + " as uid " + android.os.Process.myUid(), null);
            } else if (ACTION_RELEASE.equals(action)) {
                dpm.setApplicationRestrictions(admin, target, new Bundle());
                dpm.clearDeviceOwnerApp(context.getPackageName());
                setResult(Activity.RESULT_OK, "cleared " + target + "'s restrictions and the device owner as uid " + android.os.Process.myUid(), null);
            } else {
                setResult(Activity.RESULT_CANCELED, "unknown action " + action, null);
            }
        } catch (RuntimeException e) {
            setResult(Activity.RESULT_CANCELED, e.toString(), null);
        }
    }
}

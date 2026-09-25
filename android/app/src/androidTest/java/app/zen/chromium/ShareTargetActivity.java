package app.zen.chromium;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The other app in the share panel demo: "Nimbus Notes", a share target for {@code text/plain}
 * (the manifest's intent filter) that shows what it was sent. It lives in the instrumentation
 * APK but runs in that package's own process, not Zenium's, so it is plain Java on framework
 * classes only, as {@link CustomTabCallerActivity} is: the driver (ShareDemo, in Zenium's
 * process) reads its window through the accessibility tree – the line starting "Received:"
 * carries {@link Intent#EXTRA_TEXT}, the one under it the type and the subject – and presses Done.
 *
 * A row of the panel sends the same intent Zenium would hand the system sheet, direct to this
 * component (Chrome's {@code shareDirectly}: {@code setComponent}, {@code FLAG_ACTIVITY_FORWARD_RESULT},
 * {@code FLAG_ACTIVITY_PREVIOUS_IS_TOP}); singleTop, so a second share lands in {@link #onNewIntent}.
 */
public class ShareTargetActivity extends Activity {
    private static final int BRAND = 0xFF0F8B6E;

    private TextView received;
    private TextView details;
    private int shares = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildContent());
        take(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        take(intent);
    }

    private void take(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            received.setText("Received: nothing");
            details.setText("Share a page to Nimbus Notes to see it here.");
            return;
        }
        shares++;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        received.setText("Received: " + (text == null ? "(no text)" : text));
        details.setText(
            "type " + intent.getType() + " · subject " + (subject == null ? "(none)" : subject)
                + " · share " + shares + " · from " + (getReferrer() == null ? "?" : getReferrer().getHost())
        );
    }

    private ViewGroup buildContent() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(Color.WHITE);
        int pad = dp(24);
        column.setPadding(pad, dp(64), pad, pad);

        TextView brand = new TextView(this);
        brand.setText("Nimbus Notes");
        brand.setTextColor(BRAND);
        brand.setTypeface(Typeface.DEFAULT_BOLD);
        brand.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        column.addView(brand);

        received = new TextView(this);
        received.setTextColor(0xFF1D1D2C);
        received.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        received.setPadding(0, dp(32), 0, 0);
        column.addView(received);

        details = new TextView(this);
        details.setTextColor(0xFF5A5A6E);
        details.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        details.setPadding(0, dp(12), 0, 0);
        column.addView(details);

        Button done = new Button(this);
        done.setText("Done");
        done.setAllCaps(false);
        done.setTextColor(Color.WHITE);
        done.setBackgroundColor(BRAND);
        done.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        done.setOnClickListener(v -> finish());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(52)
        );
        params.topMargin = dp(40);
        params.gravity = Gravity.CENTER_HORIZONTAL;
        column.addView(done, params);
        return column;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }
}

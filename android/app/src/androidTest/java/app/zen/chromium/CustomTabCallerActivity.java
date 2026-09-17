package app.zen.chromium;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The other app in the custom tabs demo: "Nimbus News", a news reader whose story button opens
 * the story in a custom tab. It lives in the instrumentation APK but runs in that package's own
 * process, not Zenium's, so it is plain Java on framework classes only – the test APK does not
 * carry the libraries Zenium's APK already has (Kotlin, androidx.browser), and this process has
 * no access to them.
 *
 * The driver (CustomTabsDemo) prepares the {@code CustomTabsIntent} with a real session in
 * Zenium's process and hands it over as {@link #EXTRA_LAUNCH}; the button fires it from here, so
 * the custom tab stacks on this task the way it would for any app. Without one (started by hand)
 * the button builds a session-less custom tab intent from the raw extras.
 */
public class CustomTabCallerActivity extends Activity {
    /** A Parcelable {@link Intent}: the custom tab to start when the button is pressed. */
    public static final String EXTRA_LAUNCH = "app.zen.chromium.demo.LAUNCH";
    /** The browser's package for the fallback intent (the debug build's applicationId by default). */
    public static final String EXTRA_BROWSER = "app.zen.chromium.demo.BROWSER";

    private static final int BRAND = 0xFF2E5BFF;
    private static final String STORY_URL = "https://en.wikipedia.org/wiki/Damping";
    private static final String DEFAULT_BROWSER = "io.github.benitbuhner.zenium.debug";

    private Intent launch;
    private String browser = DEFAULT_BROWSER;
    private TextView status;
    private int opened = 0;

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

    @Override
    protected void onResume() {
        super.onResume();
        if (opened > 0) status.setText("Back in Nimbus News after custom tab " + opened);
    }

    @SuppressWarnings("deprecation")
    private void take(Intent intent) {
        if (intent == null) return;
        Intent next = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? intent.getParcelableExtra(EXTRA_LAUNCH, Intent.class)
            : intent.getParcelableExtra(EXTRA_LAUNCH);
        if (next != null) launch = next;
        String pkg = intent.getStringExtra(EXTRA_BROWSER);
        if (pkg != null) browser = pkg;
    }

    private void open() {
        Intent intent = launch != null ? new Intent(launch) : fallback();
        opened++;
        status.setText("Opening the story in a custom tab…");
        startActivity(intent);
    }

    /** A custom tab intent built from the raw extras, as an app without the androidx library would. */
    private Intent fallback() {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(STORY_URL));
        Bundle extras = new Bundle();
        extras.putBinder("android.support.customtabs.extra.SESSION", null);
        intent.putExtras(extras);
        intent.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", BRAND);
        intent.putExtra("android.support.customtabs.extra.TITLE_VISIBILITY", 1);
        intent.setPackage(browser);
        return intent;
    }

    // --- the screen -----------------------------------------------------------------------------

    private View buildContent() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(Color.WHITE);

        TextView bar = new TextView(this);
        bar.setText("Nimbus News");
        bar.setTextColor(Color.WHITE);
        bar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        bar.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        bar.setBackgroundColor(BRAND);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(20), dp(44), dp(20), dp(16));
        column.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable cardBackground = new GradientDrawable();
        cardBackground.setColor(0xFFF3F5FA);
        cardBackground.setCornerRadius(dp(16));
        card.setBackground(cardBackground);
        card.setPadding(dp(20), dp(20), dp(20), dp(20));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardParams.setMargins(dp(16), dp(20), dp(16), 0);
        column.addView(card, cardParams);

        card.addView(text("SCIENCE", 12, 0xFF5B6B8C, Typeface.create("sans-serif-medium", Typeface.NORMAL)));
        TextView headline = text("Why suspension bridges hum, and what stops them", 24, 0xFF111827, Typeface.create("sans-serif", Typeface.BOLD));
        headline.setPadding(0, dp(8), 0, dp(10));
        card.addView(headline);
        card.addView(text(
            "Every long span has a note of its own. Engineers tune it out with dampers – the same idea " +
                "that keeps a car from bouncing and a door from slamming.",
            15, 0xFF374151, Typeface.DEFAULT
        ));

        Button read = new Button(this);
        read.setText("Read the story");
        read.setAllCaps(false);
        read.setTextColor(Color.WHITE);
        read.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        GradientDrawable buttonBackground = new GradientDrawable();
        buttonBackground.setColor(BRAND);
        buttonBackground.setCornerRadius(dp(12));
        read.setBackground(buttonBackground);
        read.setStateListAnimator(null);
        read.setOnClickListener(v -> open());
        LinearLayout.LayoutParams readParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        readParams.setMargins(0, dp(20), 0, 0);
        card.addView(read, readParams);

        status = text("The story opens in a custom tab", 13, 0xFF6B7280, Typeface.DEFAULT);
        status.setPadding(dp(20), dp(24), dp(20), 0);
        column.addView(status);
        return column;
    }

    private TextView text(String value, int sp, int color, Typeface typeface) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(color);
        view.setTypeface(typeface);
        return view;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }
}

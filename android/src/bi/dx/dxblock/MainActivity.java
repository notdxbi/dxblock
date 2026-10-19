package bi.dx.dxblock;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.format.DateUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.text.NumberFormat;

public class MainActivity extends Activity {
    // dx.block's theme (src/ui/theme.css)
    static final int BG = 0xff08080a, PANEL = 0xff121216, LINE = 0xff23232b, TEXT = 0xfff4f4f6,
            MUTED = 0xff8d8d99, ACCENT = 0xffe50914, OK = 0xff22d38a, WARN = 0xffffb020;
    static final String ACTION_SETTING = "com.samsung.android.sbrowser.contentBlocker.ACTION_SETTING";
    static final String REPO = "https://github.com/notdxbi/dxblock";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView status, statusSub;
    private Button updateBtn;
    private boolean busy;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Updater.schedule(this);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        col.setPadding(pad, pad, pad, pad);

        // Header
        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher);
        head.addView(logo, new LinearLayout.LayoutParams(dp(52), dp(52)));
        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        titles.setPadding(dp(14), 0, 0, 0);
        TextView title = text("dx.block", 26, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        titles.addView(title);
        titles.addView(text("Ad blocker for Samsung Internet", 14, MUTED));
        head.addView(titles);
        col.addView(head);

        // Status
        LinearLayout card = card(col);
        status = text("", 20, TEXT);
        status.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(status);
        statusSub = text("", 14, MUTED);
        statusSub.setPadding(0, dp(4), 0, dp(14));
        card.addView(statusSub);
        updateBtn = button("Update filters now", false);
        updateBtn.setOnClickListener(v -> run(true));
        card.addView(updateBtn);

        // Turn on
        card = card(col);
        card.addView(heading("Turn it on"));
        boolean hasBrowser = installed();
        if (hasBrowser) {
            card.addView(body("Open Samsung Internet's ad blockers and switch on dx.block. That's it: ads, trackers, "
                    + "malware sites and cookie banners are blocked from then on, and the filters update by themselves every day."));
            Button open = button("Open Samsung Internet ad blockers", true);
            open.setOnClickListener(v -> openSettings());
            card.addView(open);
            TextView help = body("Not in the list? Samsung Internet only lists ad blockers Samsung has approved. Until dx.block is approved, "
                    + "type internet://contentblock in Samsung Internet's address bar, turn on Developer mode, then come back here and tap the button again.");
            help.setTextColor(MUTED);
            help.setTextSize(13);
            help.setPadding(0, dp(14), 0, 0);
            card.addView(help);
        } else {
            card.addView(body("dx.block plugs into Samsung Internet, which isn't installed on this phone."));
            Button get = button("Get Samsung Internet", true);
            get.setOnClickListener(v -> openUrl("market://details?id=" + Updater.BROWSERS[0]));
            card.addView(get);
        }

        // Lists
        card = card(col);
        card.addView(heading("Filter lists"));
        for (final Filters.ListInfo l : Updater.lists(this)) {
            Switch sw = new Switch(this);
            sw.setText(l.name);
            sw.setTextColor(TEXT);
            sw.setTextSize(15);
            sw.setChecked(Updater.enabled(this, l));
            sw.setPadding(0, dp(8), 0, 0);
            sw.setOnCheckedChangeListener((b, on) -> {
                Updater.prefs(this).edit().putBoolean("list." + l.id, on).apply();
                run(false);
            });
            card.addView(sw, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            TextView d = text(l.desc, 13, MUTED);
            d.setPadding(0, 0, dp(56), dp(8));
            card.addView(d);
        }

        // Allowlist
        card = card(col);
        card.addView(heading("Allowed sites"));
        card.addView(body("Sites where nothing is blocked, one per line."));
        final EditText allow = new EditText(this);
        allow.setText(Updater.prefs(this).getString("allow", ""));
        allow.setHint("example.com");
        allow.setHintTextColor(0xff5d5d68);
        allow.setTextColor(TEXT);
        allow.setMinLines(3);
        allow.setGravity(Gravity.TOP);
        allow.setBackground(rounded(BG, LINE, 10));
        allow.setPadding(dp(12), dp(10), dp(12), dp(10));
        card.addView(allow, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        Button save = button("Save", false);
        save.setOnClickListener(v -> {
            Updater.prefs(this).edit().putString("allow", allow.getText().toString().trim()).apply();
            run(false);
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        card.addView(save, lp);

        TextView foot = text("Free and open source (GPL-3.0)\ngithub.com/notdxbi/dxblock", 13, MUTED);
        foot.setGravity(Gravity.CENTER);
        foot.setPadding(0, dp(24), 0, dp(8));
        foot.setOnClickListener(v -> openUrl(REPO));
        col.addView(foot);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.addView(col);
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            col.setPadding(pad + insets.getSystemWindowInsetLeft(), pad + insets.getSystemWindowInsetTop(),
                    pad + insets.getSystemWindowInsetRight(), pad + insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        setContentView(scroll);
        showStatus(null);

        // First launch: build from the lists inside the app, then fetch fresh ones
        if (!Updater.filtersFile(this).exists()) run(Updater.prefs(this).getLong("updated", 0) == 0);
    }

    private void run(final boolean download) {
        if (busy) return;
        busy = true;
        updateBtn.setEnabled(false);
        status.setText(download ? "Updating filters…" : "Applying…");
        new Thread(() -> {
            final Updater.Result r = Updater.rebuild(getApplicationContext(), download);
            ui.post(() -> {
                busy = false;
                updateBtn.setEnabled(true);
                showStatus(r);
            });
        }).start();
    }

    private void showStatus(Updater.Result r) {
        int rules = Updater.prefs(this).getInt("rules", 0);
        long updated = Updater.prefs(this).getLong("updated", 0);
        status.setText(rules > 0 ? NumberFormat.getInstance().format(rules) + " filters ready" : "Getting filters ready…");
        status.setCompoundDrawablesRelativeWithIntrinsicBounds(dot(rules > 0 ? OK : WARN), null, null, null);
        status.setCompoundDrawablePadding(dp(10));
        long now = System.currentTimeMillis();
        String sub = updated == 0 ? "Using the lists built into the app"
                : now - updated < DateUtils.MINUTE_IN_MILLIS ? "Updated just now"
                : "Updated " + DateUtils.getRelativeTimeSpanString(updated, now, DateUtils.MINUTE_IN_MILLIS);
        if (r != null && !r.failed.isEmpty()) sub += "\nCouldn't download: " + String.join(", ", r.failed) + " (kept the last copy)";
        statusSub.setText(sub);
    }

    private boolean installed() {
        for (String pkg : Updater.BROWSERS) {
            try {
                getPackageManager().getPackageInfo(pkg, 0);
                return true;
            } catch (PackageManager.NameNotFoundException ignored) {
            }
        }
        return false;
    }

    private void openSettings() {
        Intent i = new Intent(ACTION_SETTING);
        if (!getPackageManager().queryIntentActivities(i, PackageManager.MATCH_DEFAULT_ONLY).isEmpty()) {
            startActivity(i);
            return;
        }
        Intent launch = getPackageManager().getLaunchIntentForPackage(Updater.BROWSERS[0]);
        if (launch != null) startActivity(launch);
        Toast.makeText(this, "In Samsung Internet: Menu → Ad blockers → dx.block", Toast.LENGTH_LONG).show();
    }

    private void openUrl(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, url, Toast.LENGTH_LONG).show();
        }
    }

    // ------------------------------------------------------------------ view helpers

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        return t;
    }

    private TextView heading(String s) {
        TextView t = text(s, 17, TEXT);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, 0, 0, dp(8));
        return t;
    }

    private TextView body(String s) {
        TextView t = text(s, 15, 0xffc9c9d1);
        t.setLineSpacing(0, 1.15f);
        t.setPadding(0, 0, 0, dp(14));
        return t;
    }

    private LinearLayout card(LinearLayout parent) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setBackground(rounded(PANEL, LINE, 18));
        c.setPadding(dp(18), dp(18), dp(18), dp(18));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        parent.addView(c, lp);
        return c;
    }

    private Button button(String s, boolean primary) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(15);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(primary ? Color.WHITE : TEXT);
        b.setBackground(rounded(primary ? ACCENT : 0xff1c1c22, primary ? ACCENT : LINE, 12));
        b.setMinHeight(dp(48));
        b.setStateListAnimator(null);
        return b;
    }

    private GradientDrawable rounded(int fill, int stroke, int radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setStroke(dp(1), stroke);
        g.setCornerRadius(dp(radius));
        return g;
    }

    private GradientDrawable dot(int color) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(color);
        g.setSize(dp(10), dp(10));
        return g;
    }
}

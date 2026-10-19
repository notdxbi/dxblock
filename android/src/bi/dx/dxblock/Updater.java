package bi.dx.dxblock;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Builds the filter file from the enabled lists and tells Samsung Internet to reload it. */
public final class Updater {
    private Updater() {}

    static final String[] BROWSERS = { "com.sec.android.app.sbrowser", "com.sec.android.app.sbrowser.beta" };
    static final String ACTION_UPDATE = "com.samsung.android.sbrowser.contentBlocker.ACTION_UPDATE";
    static final long DAY = 24L * 60 * 60 * 1000;
    private static final int JOB_ID = 1;
    private static List<Filters.ListInfo> lists;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("dxblock", Context.MODE_PRIVATE);
    }

    static File filtersFile(Context c) {
        return new File(c.getFilesDir(), "filters.txt");
    }

    static synchronized List<Filters.ListInfo> lists(Context c) {
        if (lists == null) {
            try {
                lists = Filters.parseLists(Filters.readAll(c.getAssets().open("lists.tsv")));
            } catch (IOException e) {
                lists = new ArrayList<>();
            }
        }
        return lists;
    }

    static boolean enabled(Context c, Filters.ListInfo l) {
        return prefs(c).getBoolean("list." + l.id, l.on);
    }

    static List<String> allowed(Context c) {
        return Arrays.asList(prefs(c).getString("allow", "").split("\\s+"));
    }

    /** Rule count, plus the lists that couldn't be downloaded (they fall back to the last copy). */
    static final class Result {
        int rules;
        final List<String> failed = new ArrayList<>();
    }

    /**
     * download=false rebuilds from the saved copies (after a switch or allowlist change),
     * download=true fetches fresh lists first.
     */
    static synchronized Result rebuild(Context c, boolean download) {
        Result result = new Result();
        File dir = new File(c.getFilesDir(), "lists");
        dir.mkdirs();
        List<String> texts = new ArrayList<>();
        for (Filters.ListInfo l : lists(c)) {
            if (!enabled(c, l)) continue;
            File saved = new File(dir, l.id + ".txt");
            String text = null;
            if (download || (!saved.exists() && !hasAsset(c, l.id))) {
                try {
                    text = Filters.fetchList(l.url);
                    write(saved, text);
                } catch (IOException e) {
                    result.failed.add(l.name);
                }
            }
            try {
                if (text == null && saved.exists()) text = Filters.readAll(new FileInputStream(saved));
                if (text == null && hasAsset(c, l.id)) text = Filters.readAll(c.getAssets().open("lists/" + l.id + ".txt"));
            } catch (IOException ignored) {
            }
            if (text != null) texts.add(text);
        }

        File out = filtersFile(c), tmp = new File(c.getFilesDir(), "filters.tmp");
        try (Writer w = new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8)) {
            result.rules = Filters.build(texts, allowed(c), w);
        } catch (IOException e) {
            result.rules = prefs(c).getInt("rules", 0);
            return result;
        }
        tmp.renameTo(out);
        SharedPreferences.Editor e = prefs(c).edit().putInt("rules", result.rules);
        if (download && result.failed.isEmpty()) e.putLong("updated", System.currentTimeMillis());
        e.apply();
        notifyBrowsers(c);
        return result;
    }

    private static boolean hasAsset(Context c, String id) {
        try {
            c.getAssets().open("lists/" + id + ".txt").close();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static void write(File f, String text) throws IOException {
        try (FileOutputStream o = new FileOutputStream(f)) {
            o.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    static void notifyBrowsers(Context c) {
        for (String pkg : BROWSERS) {
            Intent i = new Intent(ACTION_UPDATE);
            i.setData(Uri.parse("package:" + c.getPackageName()));
            i.setPackage(pkg);
            c.sendBroadcast(i);
        }
    }

    /** Daily refresh on any network; survives reboots. */
    static void schedule(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null || js.getPendingJob(JOB_ID) != null) return;
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, UpdateJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(DAY)
                .setPersisted(true)
                .build());
    }
}

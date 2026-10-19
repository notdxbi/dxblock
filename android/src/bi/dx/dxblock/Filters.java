package bi.dx.dxblock;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

/**
 * Turns dx.block's filter lists (uBlock / AdGuard / EasyList syntax) into the plain Adblock Plus
 * syntax Samsung Internet's content blocker understands. Rules it can't express (scriptlets,
 * procedural cosmetics, redirects, removeparam, ...) are dropped rather than half-applied.
 *
 * Plain Java on purpose: the Android app runs it on the phone, and the desktop build runs the
 * same class to download the bundled snapshot (see main()).
 */
public final class Filters {
    private Filters() {}

    public static final class ListInfo {
        public final String id, name, desc, url;
        public final boolean on;
        ListInfo(String id, boolean on, String name, String desc, String url) {
            this.id = id; this.on = on; this.name = name; this.desc = desc; this.url = url;
        }
    }

    /** lists.tsv: id, on (1/0), name, description, url. Generated from tools/lists.mjs. */
    public static List<ListInfo> parseLists(String tsv) {
        List<ListInfo> out = new ArrayList<>();
        for (String line : tsv.split("\n")) {
            String[] f = line.split("\t");
            if (f.length < 5 || line.startsWith("#")) continue;
            out.add(new ListInfo(f[0], f[1].equals("1"), f[2], f[3], f[4].trim()));
        }
        return out;
    }

    // ------------------------------------------------------------------ download

    public static String fetch(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", "dx.block-samsung");
        c.setRequestProperty("Accept-Encoding", "gzip");
        try {
            if (c.getResponseCode() != 200) throw new IOException(url + " -> HTTP " + c.getResponseCode());
            InputStream in = c.getInputStream();
            if ("gzip".equalsIgnoreCase(c.getContentEncoding())) in = new GZIPInputStream(in);
            return readAll(in);
        } finally {
            c.disconnect();
        }
    }

    public static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] b = new byte[65536];
        for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
        in.close();
        return buf.toString("UTF-8");
    }

    private static final Pattern INCLUDE = Pattern.compile("(?m)^!#include\\s+(\\S+)\\s*$");

    /** Downloads a list and inlines its !#include files (same directory only, like uBlock). */
    public static String fetchList(String url) throws IOException {
        String text = fetch(url);
        Matcher m = INCLUDE.matcher(text);
        StringBuffer sb = new StringBuffer();
        String base = url.substring(0, url.lastIndexOf('/') + 1);
        while (m.find()) {
            String name = m.group(1);
            String sub = name.contains("..") || name.contains("://") ? "" : fetch(base + name);
            m.appendReplacement(sb, Matcher.quoteReplacement(sub));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    // ------------------------------------------------------------------ conversion

    /** Merges lists into one ABP filter file. Returns the number of rules written. */
    public static int build(List<String> lists, List<String> allowedSites, Writer out) throws IOException {
        // $badfilter cancels the identical rule anywhere in any list
        Set<String> cancelled = new HashSet<>();
        for (String text : lists) {
            for (String raw : text.split("\n")) {
                String line = raw.trim();
                if (line.contains("badfilter")) cancelled.add(line.replaceAll("(\\$|,)badfilter", "").replaceAll("\\$$", ""));
            }
        }
        Set<String> seen = new LinkedHashSet<>();
        for (String site : allowedSites) {
            String host = site.trim().toLowerCase().replaceFirst("^[a-z]+://", "").replaceFirst("[/:].*$", "");
            if (DOMAIN.matcher(host).matches()) seen.add("@@||" + host + "^$document");
        }
        for (String text : lists) {
            Deque cond = new Deque();
            for (String raw : text.split("\n")) {
                String line = raw.trim();
                if (line.startsWith("!#if ")) { cond.push(cond.active() && evalCondition(line.substring(5).trim())); continue; }
                if (line.startsWith("!#else")) { cond.flip(); continue; }
                if (line.startsWith("!#endif")) { cond.pop(); continue; }
                if (!cond.active() || cancelled.contains(line)) continue;
                String rule = convert(line);
                if (rule != null) seen.add(rule);
            }
        }
        out.write("[Adblock Plus 2.0]\n! Title: dx.block for Samsung Internet\n");
        for (String r : seen) { out.write(r); out.write('\n'); }
        out.flush();
        return seen.size();
    }

    /** Stack of !#if states. */
    private static final class Deque {
        private final boolean[] parent = new boolean[64], self = new boolean[64];
        private int depth;
        boolean active() { return depth == 0 || (parent[depth - 1] && self[depth - 1]); }
        void push(boolean v) { if (depth < 64) { parent[depth] = active(); self[depth] = v; depth++; } }
        void flip() { if (depth > 0) self[depth - 1] = !self[depth - 1]; }
        void pop() { if (depth > 0) depth--; }
    }

    // What the Samsung Internet engine is: a Chromium browser on a phone, with a plain ABP engine
    private static final Set<String> ENV = new HashSet<>(Arrays.asList(
            "env_mobile", "env_chromium", "ext_abp"));

    static boolean evalCondition(String expr) {
        return new Cond(expr.replace(" ", "")).or();
    }

    private static final class Cond {
        final String s; int i;
        Cond(String s) { this.s = s; }
        boolean or() { boolean v = and(); while (s.startsWith("||", i)) { i += 2; v |= and(); } return v; }
        boolean and() { boolean v = not(); while (s.startsWith("&&", i)) { i += 2; v &= not(); } return v; }
        boolean not() {
            if (i < s.length() && s.charAt(i) == '!') { i++; return !not(); }
            if (i < s.length() && s.charAt(i) == '(') { i++; boolean v = or(); if (i < s.length() && s.charAt(i) == ')') i++; return v; }
            int start = i;
            while (i < s.length() && (Character.isLetterOrDigit(s.charAt(i)) || s.charAt(i) == '_')) i++;
            return ENV.contains(s.substring(start, i));
        }
    }

    private static final Pattern DOMAIN = Pattern.compile("[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+");
    private static final Pattern DOMAIN_ITEM = Pattern.compile("~?[a-z0-9]([a-z0-9.-]*[a-z0-9])?");
    private static final Pattern HOSTS_LINE = Pattern.compile("^(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1)\\s+(\\S+)");
    private static final Pattern COSMETIC = Pattern.compile("^([^#\\s$]*?)(#@?(?:\\$\\??|\\?|%)?#|\\$@?\\$)(.*)$");

    // Procedural / uBlock-only / AdGuard-only selector syntax a plain CSS engine can't apply
    private static final String[] PROCEDURAL = {
            ":has-text(", ":-abp-", ":upward(", ":remove(", ":style(", ":matches-css", ":xpath(",
            ":min-text-length(", ":watch-attr(", ":others(", ":matches-path(", ":matches-attr(",
            ":matches-prop(", ":remove-attr(", ":remove-class(", ":contains(", ":nth-ancestor(",
            ":if(", ":if-not(", ":matches-media(", ":shadow", ":spath(", ":xpath", "{", "}",
    };

    private static final Set<String> OPTIONS = new HashSet<>(Arrays.asList(
            "script", "image", "stylesheet", "object", "xmlhttprequest", "subdocument", "ping",
            "websocket", "webrtc", "document", "elemhide", "generichide", "genericblock", "popup",
            "font", "media", "other", "third-party", "match-case"));

    private static final Map<String, String> ALIASES = new HashMap<>();
    static {
        String[] a = {
                "3p", "third-party", "1p", "~third-party", "first-party", "~third-party",
                "xhr", "xmlhttprequest", "css", "stylesheet", "frame", "subdocument",
                "ehide", "elemhide", "ghide", "generichide", "doc", "document",
        };
        for (int i = 0; i < a.length; i += 2) ALIASES.put(a[i], a[i + 1]);
    }

    /** One rule in, one ABP rule (or null when it can't be expressed) out. */
    static String convert(String line) {
        if (line.isEmpty() || line.charAt(0) == '!' || line.charAt(0) == '[' || line.charAt(0) == '#') return null;
        for (int k = 0; k < line.length(); k++) if (line.charAt(k) > 126 || line.charAt(k) < 32) return null;

        Matcher h = HOSTS_LINE.matcher(line);
        if (h.find()) return DOMAIN.matcher(h.group(1)).matches() ? "||" + h.group(1) + "^" : null;

        if (line.contains("#") || line.contains("$$") || line.contains("$@$")) {
            Matcher m = COSMETIC.matcher(line);
            if (m.matches()) return cosmetic(m.group(1), m.group(2), m.group(3));
        }
        return network(line);
    }

    private static String cosmetic(String domains, String sep, String selector) {
        if (!sep.equals("##") && !sep.equals("#@#")) return null;
        if (selector.isEmpty() || selector.startsWith("+js(") || selector.startsWith("^")) return null;
        for (String p : PROCEDURAL) if (selector.contains(p)) return null;
        if (!domains.isEmpty()) {
            domains = domains.toLowerCase();
            for (String d : domains.split(",")) if (!DOMAIN_ITEM.matcher(d).matches()) return null;
        } else if (sep.equals("#@#")) {
            return null;
        }
        return domains + sep + selector;
    }

    private static String network(String line) {
        boolean allow = line.startsWith("@@");
        String body = allow ? line.substring(2) : line;
        String pattern = body, opts = null;
        // /regex/$options: the options start after the regex's closing slash
        int regexEnd = body.startsWith("/") ? body.lastIndexOf("/$") : -1;
        int dollar = regexEnd > 0 ? regexEnd + 1 : body.indexOf('$');
        if (dollar >= 0) {
            pattern = body.substring(0, dollar);
            opts = body.substring(dollar + 1);
        }
        if (pattern.indexOf(' ') >= 0 || pattern.contains("#")) return null;
        // Bare domains in domain-style lists mean "this host"
        if (DOMAIN.matcher(pattern).matches() && opts == null && !allow) pattern = "||" + pattern + "^";

        List<String> kept = new ArrayList<>();
        boolean hasDomain = false;
        if (opts != null) {
            for (String o : opts.split(",")) {
                o = o.trim();
                if (o.isEmpty()) continue;
                boolean neg = o.startsWith("~");
                String name = neg ? o.substring(1) : o, value = null;
                int eq = name.indexOf('=');
                if (eq >= 0) { value = name.substring(eq + 1); name = name.substring(0, eq); }
                name = name.toLowerCase();
                if (name.equals("important") || name.equals("all") || name.equals("_")) continue;
                if (name.equals("domain") || name.equals("from")) {
                    if (neg || value == null || value.isEmpty()) return null;
                    value = value.toLowerCase();
                    for (String d : value.split("\\|")) if (!DOMAIN_ITEM.matcher(d).matches()) return null;
                    kept.add("domain=" + value);
                    hasDomain = true;
                    continue;
                }
                if (value != null) return null; // redirect=, removeparam=, csp=, to=, method=, ...
                String mapped = ALIASES.containsKey(name) ? ALIASES.get(name) : name;
                if (mapped.startsWith("~")) { neg = !neg; mapped = mapped.substring(1); }
                if (!OPTIONS.contains(mapped)) return null;
                kept.add((neg ? "~" : "") + mapped);
            }
        }
        // A rule that would match every request on every site is never what a list meant for this engine
        String bare = pattern.replace("*", "").replace("|", "").replace("^", "");
        if (bare.length() < 3 && !hasDomain) return null;
        return (allow ? "@@" : "") + pattern + (kept.isEmpty() ? "" : "$" + String.join(",", kept));
    }

    // ------------------------------------------------------------------ desktop build

    /**
     * java bi.dx.dxblock.Filters lists.tsv assetsDir
     * Downloads every list that is on by default into assetsDir/lists/<id>.txt (the offline
     * snapshot inside the APK) and writes assetsDir/../filters-preview.txt with the conversion.
     */
    public static void main(String[] args) throws IOException {
        List<ListInfo> lists = parseLists(new String(Files.readAllBytes(new File(args[0]).toPath()), StandardCharsets.UTF_8));
        File dir = new File(args[1], "lists");
        dir.mkdirs();
        List<String> texts = new ArrayList<>();
        for (ListInfo l : lists) {
            if (!l.on) continue;
            String text = fetchList(l.url);
            Files.write(new File(dir, l.id + ".txt").toPath(), text.getBytes(StandardCharsets.UTF_8));
            texts.add(text);
            System.out.println("  " + l.id + ": " + text.split("\n").length + " lines");
        }
        File preview = new File(args[2]);
        try (Writer w = new OutputStreamWriter(new FileOutputStream(preview), StandardCharsets.UTF_8)) {
            System.out.println(":: " + build(texts, new ArrayList<String>(), w) + " Samsung Internet rules");
        }
    }
}

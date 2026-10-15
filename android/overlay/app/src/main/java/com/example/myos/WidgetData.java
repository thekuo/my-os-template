package com.example.myos;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/** Last good GET /api/v1/widget/today response, so the widget renders instantly and offline. */
final class WidgetData {
    private static final String PREFS = "myos_widget";

    private WidgetData() { }

    static void save(Context c, String json) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("json", json).putLong("at", System.currentTimeMillis()).putBoolean("unpaired", false).apply();
    }

    static void markUnpaired(Context c) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("unpaired", true).apply();
    }

    static boolean unpaired(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("unpaired", false);
    }

    static JSONObject load(Context c) {
        String s = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("json", null);
        if (s == null) return null;
        try { return new JSONObject(s); } catch (Exception e) { return null; }
    }
    // Rows checked off in the widget and not yet confirmed by the server (shown checked, dimmed)
    static synchronized boolean togglePending(Context c, String id) {
        Set<String> s = new HashSet<>(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet("pending", new HashSet<>()));
        boolean added = s.add(id);
        if (!added) s.remove(id);
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet("pending", s).apply();
        return added;
    }

    static synchronized void clearPending(Context c, String id) {
        Set<String> s = new HashSet<>(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet("pending", new HashSet<>()));
        if (s.remove(id)) c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet("pending", s).apply();
    }

    static boolean isPending(Context c, String id) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet("pending", new HashSet<>()).contains(id);
    }

    /** Drop a completed row from the cached response so the widget doesn't wait for the next refresh. */
    static synchronized void removeItem(Context c, String id) {
        JSONObject d = load(c);
        if (d == null) return;
        JSONArray items = d.optJSONArray("items"), kept = new JSONArray();
        if (items == null) return;
        for (int i = 0; i < items.length(); i++) {
            JSONObject t = items.optJSONObject(i);
            if (t != null && !id.equals(t.optString("id"))) kept.put(t);
        }
        try {
            d.put("items", kept);
            d.put("count", kept.length());
        } catch (Exception ignored) { }
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("json", d.toString()).apply();
    }
}

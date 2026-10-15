package com.example.myos;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;

/** To-dos typed into the add-task widget that the server hasn't confirmed yet (survives offline and app kills). */
final class TaskQueue {
    private static final String PREFS = "myos_add_queue";

    private TaskQueue() { }

    static synchronized void add(Context c, String title) {
        JSONArray a = load(c);
        try {
            a.put(new JSONObject().put("title", title).put("client_id", UUID.randomUUID().toString()));
        } catch (Exception ignored) { }
        save(c, a);
    }

    static synchronized JSONArray load(Context c) {
        try { return new JSONArray(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("items", "[]")); }
        catch (Exception e) { return new JSONArray(); }
    }

    static synchronized void remove(Context c, String clientId) {
        JSONArray a = load(c), kept = new JSONArray();
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null && !clientId.equals(o.optString("client_id"))) kept.put(o);
        }
        save(c, kept);
    }

    static int size(Context c) { return load(c).length(); }

    private static void save(Context c, JSONArray a) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("items", a.toString()).apply();
    }
}

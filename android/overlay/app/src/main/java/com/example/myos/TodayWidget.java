package com.example.myos;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.text.format.DateFormat;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** Things-style Today widget: titles, flags and deadline text from GET /api/v1/widget/today. Tap opens the app. */
public class TodayWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        render(context);
        WidgetRefreshWorker.schedule(context);
        WidgetRefreshWorker.refreshNow(context);
    }

    @Override
    public void onEnabled(Context context) {
        WidgetRefreshWorker.schedule(context);
    }

    @Override
    public void onDisabled(Context context) {
        WidgetRefreshWorker.cancel(context);
    }

    static void render(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, TodayWidget.class));
        if (ids.length == 0) return;
        JSONObject d = WidgetData.load(c);
        PendingIntent open = PendingIntent.getActivity(c, 10,
            new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        for (int id : ids) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_today);
            v.setTextViewText(R.id.w_sub, subtitle(c, d));
            Intent svc = new Intent(c, TodayWidgetService.class).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
            svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
            v.setRemoteAdapter(R.id.w_list, svc);
            v.setEmptyView(R.id.w_list, R.id.w_empty);
            v.setTextViewText(R.id.w_empty, d == null || WidgetData.unpaired(c) && d.optInt("count", 0) == 0
                ? "Open my-os once to show Today here" : "Nothing left for today");
            v.setOnClickPendingIntent(R.id.w_head, open);
            v.setOnClickPendingIntent(R.id.w_empty, open);
            v.setPendingIntentTemplate(R.id.w_list, PendingIntent.getActivity(c, 11,
                new Intent(c, WidgetActionActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION),
                PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)); // rows fill in open / toggle+id
            m.updateAppWidget(id, v);
        }
        m.notifyAppWidgetViewDataChanged(ids, R.id.w_list);
    }

    private static String subtitle(Context c, JSONObject d) {
        if (d == null) return "";
        JSONObject next = d.optJSONObject("next_event");
        if (next != null) {
            String t = time(c, next.optString("start"));
            if (t != null) return t + " " + next.optString("title");
        }
        int ev = d.optInt("events_left", 0);
        return ev > 0 ? ev + (ev == 1 ? " event left" : " events left") : "";
    }

    /** "2026-10-12T22:00:00.000Z" or "...T15:00:00-07:00" → local time like "3:00 PM". */
    private static String time(Context c, String iso) {
        try {
            if (iso == null || iso.length() < 19) return null;
            SimpleDateFormat in = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            in.setTimeZone(TimeZone.getTimeZone("UTC"));
            Date base = in.parse(iso.substring(0, 19));
            if (base == null) return null;
            String rest = iso.substring(19).replaceFirst("^\\.\\d+", "");
            long offsetMin = 0;
            if (rest.length() >= 6 && (rest.charAt(0) == '+' || rest.charAt(0) == '-')) {
                offsetMin = Integer.parseInt(rest.substring(1, 3)) * 60L + Integer.parseInt(rest.substring(4, 6));
                if (rest.charAt(0) == '+') offsetMin = -offsetMin;
            }
            return DateFormat.getTimeFormat(c).format(new Date(base.getTime() + offsetMin * 60000L));
        } catch (Exception e) {
            return null;
        }
    }
}

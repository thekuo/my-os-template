package com.example.myos;

import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

/** Rows for the Today widget's list, from the cached widget/today response. */
public class TodayWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static final class Factory implements RemoteViewsFactory {
        private final Context c;
        private JSONArray items = new JSONArray();

        Factory(Context c) { this.c = c; }

        @Override public void onCreate() { }

        @Override
        public void onDataSetChanged() {
            JSONObject d = WidgetData.load(c);
            JSONArray a = d == null ? null : d.optJSONArray("items");
            items = a == null ? new JSONArray() : a;
        }

        @Override public void onDestroy() { }
        @Override public int getCount() { return items.length(); }

        @Override
        public RemoteViews getViewAt(int i) {
            JSONObject t = items.optJSONObject(i);
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_item);
            if (t == null) return v;
            String id = t.optString("id", "");
            boolean done = WidgetData.isPending(c, id);
            v.setTextViewText(R.id.wi_title, t.optString("title", ""));
            v.setTextColor(R.id.wi_title, c.getColor(done ? R.color.widget_fg3 : R.color.widget_fg));
            v.setImageViewResource(R.id.wi_box, done ? R.drawable.widget_box_done : R.drawable.widget_box);
            v.setContentDescription(R.id.wi_box, done ? "Undo complete" : "Complete");
            String meta = t.isNull("deadline_text") ? "" : t.optString("deadline_text", "");
            v.setTextViewText(R.id.wi_meta, meta);
            v.setViewVisibility(R.id.wi_meta, meta.isEmpty() ? View.GONE : View.VISIBLE);
            v.setViewVisibility(R.id.wi_flag, t.optBoolean("flagged") ? View.VISIBLE : View.GONE);
            v.setViewVisibility(R.id.wi_moon, t.optBoolean("evening") ? View.VISIBLE : View.GONE);
            v.setOnClickFillInIntent(R.id.wi_root, new Intent().putExtra(WidgetActionActivity.EXTRA_ACTION, "open"));
            v.setOnClickFillInIntent(R.id.wi_box, new Intent()
                .putExtra(WidgetActionActivity.EXTRA_ACTION, "toggle").putExtra(WidgetActionActivity.EXTRA_ID, id));
            return v;
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int i) { return i; }
        @Override public boolean hasStableIds() { return false; }
    }
}

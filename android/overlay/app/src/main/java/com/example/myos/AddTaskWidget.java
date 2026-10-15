package com.example.myos;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.RemoteViews;

/** Small "+ Add task" widget: tap opens QuickAddActivity with the keyboard up. Shows how many entries still wait to send. */
public class AddTaskWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        render(context);
        if (TaskQueue.size(context) > 0) CreateTaskWorker.enqueue(context, false);
    }

    static void render(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, AddTaskWidget.class));
        if (ids.length == 0) return;
        PendingIntent open = PendingIntent.getActivity(c, 20,
            new Intent(c, QuickAddActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        int waiting = TaskQueue.size(c);
        for (int id : ids) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_add);
            v.setOnClickPendingIntent(R.id.wa_root, open);
            v.setTextViewText(R.id.wa_count, waiting + " waiting");
            v.setViewVisibility(R.id.wa_count, waiting > 0 ? View.VISIBLE : View.GONE);
            m.updateAppWidget(id, v);
        }
    }
}

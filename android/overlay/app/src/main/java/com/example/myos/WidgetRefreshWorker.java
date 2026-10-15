package com.example.myos;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/** Fetches Today for the widget: every 30 minutes, and right away when the app goes to the background. */
public class WidgetRefreshWorker extends Worker {
    private static final String PERIODIC = "myos-widget";
    private static final String NOW = "myos-widget-now";

    public WidgetRefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        try {
            Api.Resp r = Api.call(c, "GET", "/api/v1/widget/today", null);
            if (r.code == 200) WidgetData.save(c, r.body);
            else if (r.code == -1 || r.code == 401) WidgetData.markUnpaired(c);
            TodayWidget.render(c);
            return r.code >= 500 ? Result.retry() : Result.success();
        } catch (Exception e) {
            TodayWidget.render(c);
            return Result.retry();
        }
    }

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    static boolean hasWidgets(Context c) {
        return AppWidgetManager.getInstance(c).getAppWidgetIds(new ComponentName(c, TodayWidget.class)).length > 0;
    }

    static void schedule(Context c) {
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(WidgetRefreshWorker.class, 30, TimeUnit.MINUTES)
            .setConstraints(online()).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    static void refreshNow(Context c) {
        if (!hasWidgets(c)) return;
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(WidgetRefreshWorker.class).setConstraints(online()).build();
        WorkManager.getInstance(c).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, req);
    }

    static void cancel(Context c) {
        WorkManager.getInstance(c).cancelUniqueWork(PERIODIC);
    }
}

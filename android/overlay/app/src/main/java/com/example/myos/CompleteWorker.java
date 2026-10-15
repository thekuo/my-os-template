package com.example.myos;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/** Completes a to-do checked off in the widget, after a short linger so a second tap can undo it. */
public class CompleteWorker extends Worker {
    static final long LINGER_MS = 2500;

    public CompleteWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static String name(String id) { return "myos-complete-" + id; }

    static void enqueue(Context c, String id) {
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(CompleteWorker.class)
            .setInitialDelay(LINGER_MS, TimeUnit.MILLISECONDS)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInputData(new Data.Builder().putString("id", id).build())
            .build();
        WorkManager.getInstance(c).enqueueUniqueWork(name(id), ExistingWorkPolicy.REPLACE, req);
    }

    static void cancel(Context c, String id) {
        WorkManager.getInstance(c).cancelUniqueWork(name(id));
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        String id = getInputData().getString("id");
        if (id == null || !WidgetData.isPending(c, id)) return Result.success(); // undone meanwhile
        try {
            Api.Resp r = Api.call(c, "PATCH", "/api/v1/tasks/" + android.net.Uri.encode(id), "{\"completed\":true}");
            if (r.code >= 200 && r.code < 300) {
                WidgetData.removeItem(c, id);
            } else if (r.code >= 500) {
                return getRunAttemptCount() < 3 ? Result.retry() : giveUp(c, id);
            } else {
                return giveUp(c, id); // 401/403 (not allowed or not paired), 404: put the row back
            }
            WidgetData.clearPending(c, id);
            TodayWidget.render(c);
            MainActivity.requestReload(c);
            WidgetRefreshWorker.refreshNow(c);
            return Result.success();
        } catch (Exception e) {
            return getRunAttemptCount() < 3 ? Result.retry() : giveUp(c, id);
        }
    }

    private Result giveUp(Context c, String id) {
        WidgetData.clearPending(c, id);
        TodayWidget.render(c);
        return Result.failure();
    }
}

package com.example.myos;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

/** Sends queued add-task widget entries to Inbox with the device token; offline or not-yet-allowed = retry later. */
public class CreateTaskWorker extends Worker {
    private static final String NAME = "myos-create-tasks";

    public CreateTaskWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** now = a fresh entry: replace any waiting retry so it goes out at once (client_id makes a resend harmless). */
    static void enqueue(Context c, boolean now) {
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(CreateTaskWorker.class)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(c).enqueueUniqueWork(NAME, now ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.KEEP, req);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        JSONArray items = TaskQueue.load(c);
        boolean retry = false;
        for (int i = 0; i < items.length(); i++) {
            JSONObject t = items.optJSONObject(i);
            if (t == null) continue;
            String clientId = t.optString("client_id");
            try {
                JSONObject body = new JSONObject().put("title", t.optString("title")).put("client_id", clientId);
                Api.Resp r = Api.call(c, "POST", "/api/v1/tasks", body.toString());
                if (r.code >= 200 && r.code < 300) TaskQueue.remove(c, clientId);
                else if (r.code == 400) TaskQueue.remove(c, clientId); // the server will never take it (e.g. too long)
                else retry = true; // -1 not paired yet, 401/403 scope not live yet, 5xx: keep it and try later
            } catch (Exception e) {
                retry = true;
            }
        }
        AddTaskWidget.render(c);
        if (TaskQueue.size(c) < items.length()) MainActivity.requestReload(c); // the open app shows the new Inbox items
        return retry ? Result.retry() : Result.success();
    }
}

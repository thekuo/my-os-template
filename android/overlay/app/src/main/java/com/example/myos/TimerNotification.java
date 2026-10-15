package com.example.myos;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Toggl-style ongoing notification: to-do title, a chronometer counting up, and Stop. */
final class TimerNotification {
    static final String CHANNEL = "timer";
    static final int ID = 9001;
    static final int PERMISSION_REQUEST = 7301;
    private static final String PREFS = "myos_timer";

    private TimerNotification() { }

    static void show(Context c, String title, long startedAt) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("title", title).putLong("startedAt", startedAt).apply();
        post(c, title, startedAt, null);
    }

    /** Stop failed (offline, not paired): keep the timer visible and say so. */
    static void stopFailed(Context c) {
        android.content.SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        post(c, p.getString("title", ""), p.getLong("startedAt", System.currentTimeMillis()), "Couldn't stop. Open my-os to stop it.");
    }

    static void cancel(Context c) {
        NotificationManagerCompat.from(c).cancel(ID);
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    /** After the user grants notifications: show the timer that was waiting for it, if one is still running. */
    static void repost(Context c) {
        android.content.SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (p.contains("startedAt")) post(c, p.getString("title", ""), p.getLong("startedAt", System.currentTimeMillis()), null);
    }

    private static void post(Context c, String title, long startedAt, String note) {
        if (Build.VERSION.SDK_INT >= 33
            && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // First timer: ask (only possible from the activity); repost() runs when the answer comes back
            android.app.Activity a = MainActivity.current;
            if (a != null) a.runOnUiThread(() -> a.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, PERMISSION_REQUEST));
            return;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Running timer", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent open = PendingIntent.getActivity(c, 1,
            new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP), flags);
        PendingIntent stop = PendingIntent.getBroadcast(c, 2, new Intent(c, TimerStopReceiver.class), flags);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.myos_stat)
            .setColor(c.getColor(R.color.myos_teal))
            .setContentTitle(title == null || title.isEmpty() ? "Timer running" : title)
            .setContentText(note != null ? note : "Timer running")
            .setWhen(startedAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setContentIntent(open)
            .addAction(0, "Stop", stop);
        NotificationManagerCompat.from(c).notify(ID, b.build());
    }
}

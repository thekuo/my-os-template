package com.example.myos;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The notification's Stop button: stops the timer on the server with the device token. */
public class TimerStopReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        final PendingResult pending = goAsync();
        final Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                Api.Resp r = Api.call(app, "POST", "/api/v1/timer", "{\"action\":\"stop\"}");
                if (r.code >= 200 && r.code < 300) {
                    TimerNotification.cancel(app);
                    MainActivity.requestReload(app); // the open app shows stale timer state until it reloads
                    WidgetRefreshWorker.refreshNow(app);
                } else {
                    TimerNotification.stopFailed(app);
                }
            } catch (Exception e) {
                TimerNotification.stopFailed(app);
            } finally {
                pending.finish();
            }
        }).start();
    }
}

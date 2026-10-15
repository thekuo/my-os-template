package com.example.myos;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;

/**
 * Invisible trampoline for widget row taps (a widget may always start an activity; a background receiver
 * may not open the app on newer Android). "toggle" checks a row off with the app's linger-then-commit
 * behavior; "open" opens my-os.
 */
public class WidgetActionActivity extends Activity {
    static final String EXTRA_ACTION = "myos.action";
    static final String EXTRA_ID = "myos.id";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent in = getIntent();
        String action = in == null ? null : in.getStringExtra(EXTRA_ACTION);
        String id = in == null ? null : in.getStringExtra(EXTRA_ID);
        if ("toggle".equals(action) && id != null) {
            boolean nowDone = WidgetData.togglePending(this, id);
            tick(this);
            if (nowDone) CompleteWorker.enqueue(this, id);
            else CompleteWorker.cancel(this, id); // tapped again within the linger: undo
            TodayWidget.render(this);
        } else {
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        }
        finish();
        overridePendingTransition(0, 0);
    }

    static void tick(Context c) {
        Vibrator v = c.getSystemService(Vibrator.class);
        if (v == null || !v.hasVibrator()) return;
        if (Build.VERSION.SDK_INT >= 29) v.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK));
        else if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(20, VibrationEffect.DEFAULT_AMPLITUDE));
        else v.vibrate(20);
    }
}

package com.example.myos;

import android.content.Context;
import android.webkit.JavascriptInterface;

/**
 * window.MyOSNative: a fallback path for the few harmless things the page asks of the shell (timer notification,
 * haptic tick, widget refresh) when Capacitor's bridge isn't present. No tokens or data pass through here.
 */
final class NativeShell {
    private final Context c;

    NativeShell(Context c) { this.c = c; }

    @JavascriptInterface
    public void setTimer(String title, double startedAt) {
        TimerNotification.show(c, title == null ? "" : title, (long) startedAt);
    }

    @JavascriptInterface
    public void clearTimer() {
        TimerNotification.cancel(c);
    }

    @JavascriptInterface
    public void haptic() {
        WidgetActionActivity.tick(c);
    }

    @JavascriptInterface
    public void refreshWidget() {
        WidgetRefreshWorker.refreshNow(c);
    }
}

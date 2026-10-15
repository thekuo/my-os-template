package com.example.myos;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Build;
import android.util.Base64;
import android.webkit.WebView;

import java.io.ByteArrayOutputStream;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Small native surface for the my-os web app. Calls are only honored from the app's own origin. */
@CapacitorPlugin(name = "MyOSShell")
public class ShellPlugin extends Plugin {

    private boolean fromApp(PluginCall call) {
        String[] url = new String[1];
        try {
            java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
            getActivity().runOnUiThread(() -> { url[0] = getBridge().getWebView().getUrl(); done.countDown(); });
            done.await(1, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException ignored) { }
        if (MainActivity.isAppUrl(url[0])) return true;
        call.reject("not allowed from this page");
        return false;
    }

    @PluginMethod
    public void setChrome(PluginCall call) {
        int color = MainActivity.parseColor(call.getString("color", ""), 0);
        if (color == 0) { call.reject("bad color"); return; }
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).applyChrome(color));
        call.resolve();
    }

    @PluginMethod
    public void deviceStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("paired", TokenStore.get(getContext()) != null);
        r.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        call.resolve(r);
    }

    @PluginMethod
    public void setDeviceToken(PluginCall call) {
        if (!fromApp(call)) return;
        String token = call.getString("token");
        if (token == null || token.isEmpty() || token.length() > 512) { call.reject("bad token"); return; }
        try {
            TokenStore.save(getContext(), token, call.getString("id", ""));
            if (TaskQueue.size(getContext()) > 0) CreateTaskWorker.enqueue(getContext(), true); // entries made before pairing
            call.resolve();
        } catch (Exception e) {
            call.reject("could not store token", e);
        }
    }

    @PluginMethod
    public void clearDeviceToken(PluginCall call) {
        if (!fromApp(call)) return;
        TokenStore.clear(getContext());
        call.resolve();
    }

    /** Ongoing timer notification; the page calls this when the server says a timer is running. */
    @PluginMethod
    public void setTimer(PluginCall call) {
        if (!fromApp(call)) return;
        Double startedAt = call.getDouble("startedAt");
        if (startedAt == null) { call.reject("startedAt required"); return; }
        TimerNotification.show(getContext(), call.getString("title", ""), startedAt.longValue());
        call.resolve();
    }

    @PluginMethod
    public void clearTimer(PluginCall call) {
        TimerNotification.cancel(getContext());
        call.resolve();
    }

    @PluginMethod
    public void refreshWidget(PluginCall call) {
        WidgetRefreshWorker.refreshNow(getContext());
        call.resolve();
    }

    /** JPEG of what the WebView shows, as a data URL of at most ~590 KB (the server's feedback cap is 600 KB). */
    @PluginMethod
    public void screenshot(PluginCall call) {
        if (!fromApp(call)) return;
        getActivity().runOnUiThread(() -> {
            try {
                WebView wv = getBridge().getWebView();
                int w = wv.getWidth(), h = wv.getHeight();
                if (w == 0 || h == 0) { call.reject("no view"); return; }
                float scale = Math.min(1f, 720f / w);
                Bitmap b = Bitmap.createBitmap(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(b);
                canvas.scale(scale, scale);
                canvas.translate(-wv.getScrollX(), -wv.getScrollY());
                wv.draw(canvas);
                String url = null;
                for (int q = 75; q >= 25 && url == null; q -= 10) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    b.compress(Bitmap.CompressFormat.JPEG, q, out);
                    String s = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                    if (s.length() <= 590_000) url = s;
                }
                b.recycle();
                if (url == null) { call.reject("screenshot too large"); return; }
                JSObject r = new JSObject();
                r.put("dataUrl", url);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("screenshot failed", e);
            }
        });
    }
}

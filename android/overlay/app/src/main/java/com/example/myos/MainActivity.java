package com.example.myos;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.ColorUtils;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.WebViewListener;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

public class MainActivity extends BridgeActivity {
    static final String APP_HOST = "v1.my-os.example.com";

    // Runs before the page's own scripts. The web app's service worker serves the page from its cache, which skips
    // Capacitor's proxy, so the native bridge (window.Capacitor) never gets injected and every plugin call is a no-op.
    // Inside the shell: no service worker (the shell has its own offline page), and drop any one already installed.
    static final String NO_SERVICE_WORKER_JS =
        "(function(){try{var sw=navigator.serviceWorker;if(!sw)return;"
        + "var fake=function(){return Promise.resolve({unregister:function(){return Promise.resolve(true);}});};"
        + "try{Object.defineProperty(sw,'register',{value:fake,configurable:true});}catch(e){sw.register=fake;}"
        + "sw.getRegistrations().then(function(rs){if(!rs.length)return;"
        + "return Promise.all(rs.map(function(r){return r.unregister();}))"
        + ".then(function(){return window.caches?caches.keys():[];})"
        + ".then(function(ks){return Promise.all(ks.filter(function(k){return k.indexOf('myos-v1-')===0;}).map(function(k){return caches.delete(k);}));})"
        + ".then(function(){if(sw.controller&&!sessionStorage.getItem('myosNoSw')){sessionStorage.setItem('myosNoSw','1');location.reload();}});"
        + "}).catch(function(){});}catch(e){}})();";

    static volatile MainActivity current; // for the notification-permission prompt from background code
    private volatile boolean pageLoaded = false;
    private String shellJs;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Keep the system splash up until the remote page has loaded (at most 2.5 s)
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        final long started = SystemClock.uptimeMillis();
        splash.setKeepOnScreenCondition(() -> !pageLoaded && SystemClock.uptimeMillis() - started < 2500);

        registerPlugin(ShellPlugin.class);
        super.onCreate(savedInstanceState);
        lockOrientation(getResources().getConfiguration());

        // Draw edge to edge and pad the WebView by the system bars and the keyboard ourselves:
        // same result on every Android version, and the keyboard resizes the page (adjustResize).
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        final WebView webView = getBridge().getWebView();
        final View container = (View) webView.getParent();
        ViewCompat.setOnApplyWindowInsetsListener(container, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
            lp.setMargins(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            webView.setLayoutParams(lp);
            return WindowInsetsCompat.CONSUMED;
        });
        applyChrome(getColor(R.color.myos_bg));
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, NO_SERVICE_WORKER_JS, Collections.singleton("https://" + APP_HOST));
        }
        // Minimal second path to the native side that doesn't depend on Capacitor's injected bridge
        webView.addJavascriptInterface(new NativeShell(getApplicationContext()), "MyOSNative");

        // Capacitor shows the errorPath (offline) page for ANY main-frame HTTP error. The server answers 401 with
        // its login page when signed out, so only network failures (onReceivedError, untouched) and 5xx count.
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (request.isForMainFrame() && errorResponse.getStatusCode() < 500) return;
                super.onReceivedHttpError(view, request, errorResponse);
            }
        });

        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                pageLoaded = true;
                if (isAppUrl(view.getUrl())) view.evaluateJavascript(shellJs(), null);
            }
        });

        // Back gesture / button (predictive back is enabled in the manifest): ask the page first,
        // and only leave the app when it had nothing to close or go back to.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge().getWebView();
                if (!isAppUrl(wv.getUrl())) { moveTaskToBack(true); return; }
                wv.evaluateJavascript(
                    "(function(){try{return !!(window.myosShell&&window.myosShell.back());}catch(e){return false;}})()",
                    handled -> { if (!"true".equals(handled)) moveTaskToBack(true); });
            }
        });
    }

    /** Portrait on phones; any orientation on large screens (tablets, unfolded foldables: smallest width >= 600dp). */
    private void lockOrientation(Configuration c) {
        setRequestedOrientation(c.smallestScreenWidthDp >= 600
            ? ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig); // the manifest handles size changes in place, so fold/unfold land here
        lockOrientation(newConfig);
    }

    @Override
    public void onPause() {
        super.onPause();
        if (current == this) current = null;
        CookieManager.getInstance().flush(); // keep the login cookie if Android kills the process
        WidgetRefreshWorker.refreshNow(this); // the widget catches up with what was just done in the app
    }

    @Override
    public void onResume() {
        super.onResume();
        current = this;
        if (TaskQueue.size(this) > 0) CreateTaskWorker.enqueue(this, false); // add-task entries still waiting
        // The timer was stopped from the notification while the app was in the background: show fresh state
        if (getSharedPreferences("myos_state", MODE_PRIVATE).getBoolean("reload", false)) {
            getSharedPreferences("myos_state", MODE_PRIVATE).edit().remove("reload").apply();
            WebView wv = getBridge() == null ? null : getBridge().getWebView();
            if (wv != null && isAppUrl(wv.getUrl())) wv.reload();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == TimerNotification.PERMISSION_REQUEST) TimerNotification.repost(this); // granted: show the waiting timer
    }

    static void requestReload(android.content.Context c) {
        c.getSharedPreferences("myos_state", MODE_PRIVATE).edit().putBoolean("reload", true).apply();
    }

    static boolean isAppUrl(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        return "https".equals(u.getScheme()) && APP_HOST.equals(u.getHost());
    }

    /** Status and navigation bar area take the page's background; icons go dark on light backgrounds. */
    void applyChrome(int color) {
        View container = (View) getBridge().getWebView().getParent();
        container.setBackgroundColor(color);
        getWindow().getDecorView().setBackgroundColor(color);
        boolean light = ColorUtils.calculateLuminance(color) > 0.5;
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setAppearanceLightStatusBars(light);
        c.setAppearanceLightNavigationBars(light);
    }

    private String shellJs() {
        if (shellJs != null) return shellJs;
        String version = "unknown";
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { }
        try (InputStream in = getAssets().open("myos-shell.js")) {
            byte[] buf = new byte[in.available()];
            int off = 0, n;
            while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
            shellJs = new String(buf, 0, off, StandardCharsets.UTF_8).replace("__MYOS_SHELL_VERSION__", version);
        } catch (Exception e) {
            shellJs = "";
        }
        return shellJs;
    }

    static int parseColor(String s, int fallback) {
        try { return Color.parseColor(s); } catch (Exception e) { return fallback; }
    }
}

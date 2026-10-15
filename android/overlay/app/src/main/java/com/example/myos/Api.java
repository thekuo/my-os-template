package com.example.myos;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** my-os API calls from native code, authenticated with the device token (never the agent key). */
final class Api {
    static final String BASE = "https://" + MainActivity.APP_HOST;

    static final class Resp {
        int code; // HTTP status, or -1 when the phone isn't paired yet
        String body = "";
    }

    private Api() { }

    static Resp call(Context c, String method, String path, String json) throws IOException {
        Resp r = new Resp();
        String token = TokenStore.get(c);
        if (token == null) { r.code = -1; return r; }
        HttpURLConnection conn = (HttpURLConnection) new URL(BASE + path).openConnection();
        try {
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod(method);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            if (json != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = conn.getOutputStream()) { o.write(json.getBytes(StandardCharsets.UTF_8)); }
            }
            r.code = conn.getResponseCode();
            InputStream in = r.code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in != null) {
                try (InputStream s = in) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
                    r.body = out.toString("UTF-8");
                }
            }
        } finally {
            conn.disconnect();
        }
        if (r.code == 401) TokenStore.clear(c); // revoked in Settings: the app pairs again on its next open
        return r;
    }
}

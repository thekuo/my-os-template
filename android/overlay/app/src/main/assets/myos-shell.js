// my-os Android shell bridge. Injected by MainActivity into pages on v1.my-os.example.com after each load.
// The web app feature-detects it:   if (window.myosShell) myosShell.haptic('success')
// or listens for the 'myosshell' event (fired once it is installed). Nothing here is needed on plain web.
(function () {
  if (window.myosShell) return;
  var cap = window.Capacitor;
  var VERSION = '__MYOS_SHELL_VERSION__';

  // Capacitor's bridge when the page has it; else window.MyOSNative (added by the shell itself) for the few
  // calls that must work regardless: timer notification, haptic tick, widget refresh.
  function nativeFallback(plugin, method, opts) {
    var n = window.MyOSNative;
    if (!n) return null;
    var o = opts || {};
    if (plugin === 'MyOSShell' && method === 'setTimer') { n.setTimer(String(o.title || ''), +o.startedAt || Date.now()); return {}; }
    if (plugin === 'MyOSShell' && method === 'clearTimer') { n.clearTimer(); return {}; }
    if (plugin === 'MyOSShell' && method === 'refreshWidget') { n.refreshWidget(); return {}; }
    if (plugin === 'Haptics') { n.haptic(); return {}; }
    return null;
  }
  function bridged() { return !!(cap && (typeof cap.nativePromise === 'function' || cap.Plugins)); }
  function call(plugin, method, opts) {
    try {
      if (cap && typeof cap.nativePromise === 'function') return cap.nativePromise(plugin, method, opts || {});
      var p = cap && cap.Plugins && cap.Plugins[plugin];
      if (p && typeof p[method] === 'function') return p[method](opts || {});
      var r = nativeFallback(plugin, method, opts);
      if (r) return Promise.resolve(r);
    } catch (e) { /* bridge not ready */ }
    return Promise.resolve(null);
  }

  var HAPTICS = {
    light:   ['impact', { style: 'LIGHT' }],
    medium:  ['impact', { style: 'MEDIUM' }],
    heavy:   ['impact', { style: 'HEAVY' }],
    success: ['notification', { type: 'SUCCESS' }],
    warning: ['notification', { type: 'WARNING' }],
    error:   ['notification', { type: 'ERROR' }]
  };

  function haptic(kind) {
    var h = HAPTICS[kind] || HAPTICS.light;
    call('Haptics', h[0], h[1]).catch(function () {});
  }

  // Back: the web app can set myosShell.onBack = () => true|false (true = handled).
  // Until it does, close the obvious overlays of the v1 UI, then step back through its #route history.
  function back() {
    try {
      var hook = typeof shell.onBack === 'function' ? shell.onBack : window.myosBack; // the page may register before we're injected
      if (typeof hook === 'function') { var r = hook(); if (r === true || r === false) return r; }
    } catch (e) { /* fall through */ }
    var $ = function (s) { return document.querySelector(s); };
    var find = $('#find-ov'), scrim = $('#scrim');
    if (find && !find.hidden) { var fc = $('#find-cancel'); if (fc) fc.click(); else find.hidden = true; return true; }
    if (scrim && !scrim.hidden) { scrim.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }
    if ($('.row.open')) { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; }
    var r = (location.hash || '').replace(/^#/, '');
    if (r && r !== 'home' && r !== 'today' && history.length > 1) { history.back(); return true; }
    return false;
  }

  // Status/navigation bar color follows the page background (light, dark, or the app's own theme setting).
  var lastColor = null;
  function syncChrome() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor;
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = getComputedStyle(document.documentElement).backgroundColor;
      var m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return;
      var hex = '#' + [m[1], m[2], m[3]].map(function (n) { return ('0' + (+n).toString(16)).slice(-2); }).join('');
      if (hex === lastColor) return;
      lastColor = hex;
      call('MyOSShell', 'setChrome', { color: hex });
    } catch (e) { /* ignore */ }
  }

  // Device token: pair once after login so native pieces (widget, timer notification) can call the API.
  // The token goes straight into Android encrypted storage and is never handed back to JS.
  function pair() {
    call('MyOSShell', 'deviceStatus').then(function (s) {
      if (!s || s.paired) return;
      return fetch('/api/v1/devices', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Android: ' + (s.model || 'phone'), scopes: ['widget', 'timer', 'feedback'] })
      }).then(function (res) {
        if (!res.ok) return null; // 404 until the server ships device tokens; retried next launch
        return res.json();
      }).then(function (j) {
        if (j && j.token) return call('MyOSShell', 'setDeviceToken', { token: j.token, id: j.id || '' });
      });
    }).catch(function () {});
  }

  var shell = {
    native: true,
    platform: 'android',
    version: VERSION,
    haptic: haptic,
    onBack: null,
    back: back,
    syncChrome: syncChrome
  };
  window.myosShell = shell;

  // Existing navigator.vibrate() calls in the web app become real haptics (short = light tick, longer/pattern = success)
  try {
    navigator.vibrate = function (p) {
      var total = Array.isArray(p) ? p.reduce(function (a, b) { return a + (+b || 0); }, 0) : (+p || 0);
      if (total > 0) haptic(Array.isArray(p) && p.length > 1 || total >= 30 ? 'success' : 'light');
      return true;
    };
  } catch (e) { /* read-only in some engines */ }

  syncChrome();
  try {
    new MutationObserver(syncChrome).observe(document.documentElement, { attributes: true, subtree: false });
    new MutationObserver(syncChrome).observe(document.body, { attributes: true, subtree: false });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncChrome);
  } catch (e) { /* ignore */ }
  setTimeout(syncChrome, 1500);

  try {
    var sw = navigator.serviceWorker;
    if (sw && sw.controller) sw.getRegistrations().then(function (rs) {
      return Promise.all(rs.map(function (r) { return r.unregister(); }));
    }).then(function () { return window.caches ? caches.keys() : []; }).then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k.indexOf('myos-v1-') === 0; }).map(function (k) { return caches.delete(k); }));
    }).then(function () {
      if (!bridged() && !sessionStorage.getItem('myosNoSw2')) { sessionStorage.setItem('myosNoSw2', '1'); location.reload(); }
    }).catch(function () {});
  } catch (e) { /* ignore */ }

  var inApp = !/\/login\b/.test(location.pathname) && !!document.getElementById('app');
  // Only pair from the app itself, not the login page
  if (inApp) pair();
  if (inApp) phase5b();

  // ---- Phase 5b: timer notification, reminders, shake screenshot, keyboard. All of it reads the app's own
  // API traffic (a fetch wrapper), so the web app needs no changes. ----
  function phase5b() {
    var noop = function () {};

    // Notification permission (Android 13+), asked once, the first time a timer or reminder needs it
    var perm = null;
    function canNotify() {
      if (!perm) perm = call('LocalNotifications', 'checkPermissions').then(function (r) {
        if (r && r.display === 'granted') return true;
        return call('LocalNotifications', 'requestPermissions').then(function (q) { return !!q && q.display === 'granted'; });
      }).catch(function () { perm = null; return false; });
      return perm;
    }

    // Timer: mirror the server's running timer as an ongoing notification with Stop
    var timerKey = null;
    function showTimer(run) {
      var key = run ? run.task_id + '@' + run.started_at : '';
      if (key === timerKey) return;
      timerKey = key;
      if (!run) { call('MyOSShell', 'clearTimer'); return; }
      // The native side asks for the notification permission on first use if it doesn't have it
      call('MyOSShell', 'setTimer', { title: run.title || '', startedAt: Date.parse(run.started_at) });
    }

    // Reminders: local notifications for open to-dos with reminder_at, re-synced whenever the app sees changes
    var reminders = {}, remTimer = null;
    function notifId(id) { var h = 7; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0; return (Math.abs(h) % 2000000000) + 10000; }
    function live(t) { return t && !t.completed_at && !t.dropped_at && !t.canceled_at && !t.trashed_at && !t.completed && !t.canceled && !t.trashed; }
    function syncReminders() { clearTimeout(remTimer); remTimer = setTimeout(doSyncReminders, 800); }
    function doSyncReminders() {
      var now = Date.now(), list = [];
      Object.keys(reminders).forEach(function (id) {
        var r = reminders[id], at = Date.parse(r.at);
        if (at > now + 5000 && at < now + 60 * 86400000) list.push({
          id: notifId(id), title: r.title || 'Reminder', body: 'my-os reminder',
          schedule: { at: new Date(at).toISOString(), allowWhileIdle: true },
          smallIcon: 'myos_stat', extra: { taskId: id, myos: 1 }
        });
      });
      var prev = [];
      try { prev = JSON.parse(localStorage.getItem('myosShellReminders') || '[]'); } catch (e) { prev = []; }
      var cancel = prev.length ? call('LocalNotifications', 'cancel', { notifications: prev.map(function (id) { return { id: id }; }) }) : Promise.resolve();
      cancel.catch(noop).then(function () {
        if (!list.length) return true;
        return canNotify().then(function (ok) { return ok && call('LocalNotifications', 'schedule', { notifications: list }); });
      }).then(function () {
        try { localStorage.setItem('myosShellReminders', JSON.stringify(list.map(function (n) { return n.id; }))); } catch (e) { /* ignore */ }
      }).catch(noop);
    }

    function onState(j) {
      if (!j) return;
      showTimer(j.timer || null);
      if (Array.isArray(j.tasks)) {
        reminders = {};
        j.tasks.forEach(function (t) { if (t && t.reminder_at && live(t)) reminders[t.id] = { title: t.title, at: t.reminder_at }; });
        syncReminders();
      }
    }
    function onTaskWrite(path, sent, got) {
      var m = path.match(/^\/api\/v1\/tasks\/([^/]+)$/), id = (m && decodeURIComponent(m[1])) || (got && got.id);
      if (!id) return;
      var rec = got && got.id === id ? got : null, cur = reminders[id], b = sent || {};
      var at = rec && 'reminder_at' in rec ? rec.reminder_at : ('reminder_at' in b ? b.reminder_at : cur && cur.at);
      var title = (rec && rec.title) || b.title || (cur && cur.title) || '';
      if (!at || b.completed || b.canceled || b.trashed || (rec && !live(rec))) delete reminders[id];
      else reminders[id] = { title: title, at: at };
      syncReminders();
      call('MyOSShell', 'refreshWidget');
    }

    // Shake: the app opens its feedback sheet on shake (same event, its listener runs first). Hide that sheet
    // before it is ever painted, screenshot the screen underneath, then show the sheet.
    var lastShot = null, shakeAt = 0;
    addEventListener('devicemotion', function (e) {
      var a = e.accelerationIncludingGravity;
      if (!a || Math.hypot(a.x || 0, a.y || 0, a.z || 0) <= 30 || Date.now() - shakeAt < 3000) return;
      if (!document.getElementById('fb-note')) return; // the app didn't open feedback for this shake
      shakeAt = Date.now();
      var root = document.documentElement;
      root.classList.add('myos-shot');
      call('MyOSShell', 'screenshot').then(function (r) {
        if (r && r.dataUrl) lastShot = { dataUrl: r.dataUrl, at: Date.now() };
      }).catch(noop).then(function () { root.classList.remove('myos-shot'); });
    });

    // The fetch wrapper: watch state/timer/task responses; attach the shake screenshot to the feedback POST
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var path = '';
      try { path = new URL(url, location.href).pathname; } catch (e) { /* ignore */ }
      var body = init && typeof init.body === 'string' ? init.body : null, sent = null;
      try { sent = body ? JSON.parse(body) : null; } catch (e) { sent = null; }
      if (method === 'POST' && path === '/api/v1/feedback' && sent) {
        if (!sent.screenshot && lastShot && Date.now() - lastShot.at < 600000) sent.screenshot = lastShot.dataUrl;
        lastShot = null;
        sent.app_version = (String(sent.app_version || '') + ' · android ' + VERSION + (bridged() ? '' : ' nb')).slice(0, 40);
        init = Object.assign({}, init, { body: JSON.stringify(sent) });
      }
      var p = origFetch(input, init);
      p.then(function (res) {
        if (!res.ok) return;
        if (path === '/api/v1/state' && method === 'GET') res.clone().json().then(onState).catch(noop);
        else if (path === '/api/v1/timer' && method === 'POST') res.clone().json().then(function (j) { showTimer(j && j.running || null); }).catch(noop);
        else if (/^\/api\/v1\/tasks(\/|$)/.test(path) && (method === 'PATCH' || method === 'POST')) res.clone().json().then(function (j) { onTaskWrite(path, sent, j); }).catch(function () { onTaskWrite(path, sent, null); });
      }, noop);
      return p;
    };

    // The app loaded its state before this script was injected: read it once ourselves
    origFetch('/api/v1/state', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(onState).catch(noop);

    // Keyboard: keep the open card fully above it, and hide the + button while typing or a card is open.
    // The keyboard, the WebView resize and the card's expand animation finish in no fixed order (a fast tap on
    // the title focuses before the card has grown), so instead of one scroll, re-check for ~1.2 s until the
    // card's bottom sits above the keyboard. Extra bottom padding lets even the last card scroll up.
    try {
      var st = document.createElement('style');
      st.textContent = 'html.myos-kb #plus, html:has(.row.open) #plus { display: none !important; }'
        + ' html.myos-shot #scrim { visibility: hidden !important; }'
        + ' html.myos-kb #view { padding-bottom: 45vh !important; }';
      document.head.appendChild(st);
    } catch (e) { /* ignore */ }
    var tallest = innerHeight, wide = innerWidth, settleUntil = 0, settling = false;
    function kbOpen() { return innerHeight < tallest - 120; }
    function liftOnce() {
      var card = document.querySelector('.row.open');
      if (!card || !kbOpen()) return;
      var r = card.getBoundingClientRect(), room = innerHeight - 8;
      if (r.bottom > room || r.top < 0) {
        var fits = r.height <= room - 8;
        card.scrollIntoView({ block: fits ? 'end' : 'start', behavior: 'auto' });
      }
    }
    function settle() {
      settleUntil = Date.now() + 1200;
      if (settling) return;
      settling = true;
      (function step() {
        liftOnce();
        if (Date.now() < settleUntil) setTimeout(step, 80);
        else settling = false;
      })();
    }
    function onSize() {
      if (innerWidth !== wide) { wide = innerWidth; tallest = innerHeight; } // rotation
      if (innerHeight > tallest) tallest = innerHeight;
      document.documentElement.classList.toggle('myos-kb', kbOpen());
      if (kbOpen()) settle();
    }
    addEventListener('resize', onSize);
    if (window.visualViewport) visualViewport.addEventListener('resize', onSize);
    document.addEventListener('focusin', function (e) {
      if (e.target && e.target.closest && e.target.closest('.row.open')) settle();
    });
    document.addEventListener('transitionend', function (e) {
      if (e.target && e.target.closest && e.target.closest('.row.open') && kbOpen()) settle();
    }, true);

    // Settings footer shows the Android build next to the web version ("my-os v1-p3 · Android 1.0.13")
    function stampVersion() {
      var ps = document.querySelectorAll('#view p.list-sub');
      for (var i = 0; i < ps.length; i++) {
        var t = ps[i].textContent || '';
        if (/^my-os\s/.test(t) && t.indexOf('Android') < 0) ps[i].textContent = t + ' · Android ' + VERSION + (bridged() ? '' : ' (no bridge)');
      }
    }
    try { var view = document.getElementById('view'); if (view) new MutationObserver(stampVersion).observe(view, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    stampVersion();
  }

  try { window.dispatchEvent(new CustomEvent('myosshell', { detail: shell })); } catch (e) { /* ignore */ }
})();

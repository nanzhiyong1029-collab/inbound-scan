// 离线缓存 APP 外壳（不缓存 API 请求）
var CACHE = 'inbound-scan-v1.5.3';
var LIB = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
var FILES = ['./', 'index.html', 'style.css?v=1.5.3', 'app.js?v=1.5.3', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES).then(function () { return c.add(LIB).catch(function () { }); }); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (e.request.url === LIB) { e.respondWith(caches.match(LIB).then(function (hit) { return hit || fetch(e.request).then(function (r) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(LIB, cp); }); return r; }); })); return; }
  if (u.origin !== location.origin) return;   // API 走网络
  // 页面：网络优先（拿到新版本），断网用缓存；静态文件：缓存优先
  if (e.request.mode === 'navigate') {
    // v1.5.3：有 Wi-Fi 但上不了网时不要一直等 —— 3 秒没回应就先用缓存的页面
    var net = fetch(e.request).then(function (r) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put('./', cp); }); return r; });
    var slow = new Promise(function (res) { setTimeout(res, 3000); }).then(function () { return caches.match('./'); });
    e.respondWith(Promise.race([net.catch(function () { return caches.match('./'); }), slow.then(function (hit) { return hit || net; })]));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (hit) { return hit || fetch(e.request); }));
});

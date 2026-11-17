// 离线缓存 APP 外壳（不缓存 API 请求）
var CACHE = 'inbound-scan-v1.9.4';
var LIB = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
// v1.6 缅甸文字体（拣货缅甸语用），离线也要能显示
var FONTS = [400, 700].map(function (w) { return 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-myanmar@5.2.5/files/noto-sans-myanmar-myanmar-' + w + '-normal.woff2'; });
var FILES = ['./', 'index.html', 'style.css?v=1.9.4', 'app.js?v=1.9.4', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES).then(function () { return Promise.all([LIB].concat(FONTS).map(function (u) { return c.add(u).catch(function () { }); })); }); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE && k !== 'inbound-scan-keep'; })   /* v1.8.0 设备钥匙备份不能删 */.map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (e.request.url === LIB || FONTS.indexOf(e.request.url) >= 0) { e.respondWith(caches.match(e.request.url).then(function (hit) { return hit || fetch(e.request).then(function (r) { var cp = r.clone(); if (r.ok) caches.open(CACHE).then(function (c) { c.put(e.request.url, cp); }); return r; }); })); return; }
  if (u.origin !== location.origin) return;   // API 走网络
  // 页面：网络优先（拿到新版本），断网用缓存；静态文件：缓存优先
  if (e.request.mode === 'navigate') {
    if (!/\/(index\.html)?$/.test(u.pathname)) return;     // v1.8.0：只有 APP 首页存成离线页（扫码测试页等不能盖掉它）
    // v1.8.0：有 Wi-Fi 但上不了网时不要一直等 —— 3 秒没回应就先用缓存的页面
    var net = fetch(e.request).then(function (r) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put('./', cp); }); return r; });
    var slow = new Promise(function (res) { setTimeout(res, 3000); }).then(function () { return caches.match('./'); });
    e.respondWith(Promise.race([net.catch(function () { return caches.match('./'); }), slow.then(function (hit) { return hit || net; })]));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (hit) { return hit || fetch(e.request); }));
});

// 离线缓存 APP 外壳（不缓存 API 请求）
var CACHE = 'inbound-scan-v1.9.54-t52+v2-46e2a0';
var LIB = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
// v1.6 缅甸文字体（拣货缅甸语用），离线也要能显示
var FONTS = [400, 700].map(function (w) { return 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-myanmar@5.2.5/files/noto-sans-myanmar-myanmar-' + w + '-normal.woff2'; });
var FILES = ['./', 'index.html', 'style.css?v=1.9.54-t52', 'app.js?v=1.9.54-t52', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
// B5 新前端（docs/24 A5）：v2/ 的全部文件一起预缓存（没打开过的新页面断网也能开）。下一行由 AWMS 仓库 scripts/pda-publish.mjs 写入，缓存名也跟着带上新前端的构建号
var V2 = ["v2/boot.js?b=46e2a0","v2/c-chunk-2SON6WLT.js","v2/c-chunk-2WHGGVMH.js","v2/c-chunk-45GETRTV.js","v2/c-chunk-6JFOSGYF.js","v2/c-chunk-6X6MWN6A.js","v2/c-chunk-AYDFUG6Z.js","v2/c-chunk-CJEHLMJO.js","v2/c-chunk-D3YFZUDC.js","v2/c-chunk-DAJ7DKZY.js","v2/c-chunk-DGCLKTUJ.js","v2/c-chunk-JNZBTVWL.js","v2/c-chunk-L6OQBW6J.js","v2/c-chunk-LIMHLXSY.js","v2/c-chunk-LYDRSNLV.js","v2/c-chunk-NNDOUMN5.js","v2/c-chunk-PZ5KDET3.js","v2/c-chunk-RX3YZJDS.js","v2/c-chunk-XXVKFAUC.js","v2/c-chunk-ZH3UCKML.js","v2/c-chunk-ZZFBPZX7.js","v2/p-auth.js?b=46e2a0","v2/p-is.js?b=46e2a0","v2/p-lc.js?b=46e2a0","v2/p-ld.js?b=46e2a0","v2/p-map.js?b=46e2a0","v2/p-mv2.js?b=46e2a0","v2/p-pl.js?b=46e2a0","v2/p-q.js?b=46e2a0","v2/p-sort.js?b=46e2a0","v2/p-sys.js?b=46e2a0","v2/p-t.js?b=46e2a0","v2/perf.js?b=46e2a0"];
FILES = FILES.concat(V2);
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES).then(function () { return Promise.all([LIB].concat(FONTS).map(function (u) { return c.add(u).catch(function () { }); })); }); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  // P-092：只删自己的旧版本缓存（inbound-scan-v…）。同一网站上别人的缓存（AWMS /p/ 和 1.0 后台同站，后台是 awms-*）不动；
  // 设备钥匙备份 inbound-scan-keep 也不是 inbound-scan-v 开头，照样留着（v1.8.0）
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE && k.indexOf('inbound-scan-v') === 0; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
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

// 离线缓存 APP 外壳（不缓存 API 请求）
var CACHE = 'inbound-scan-v1.9.54-t50+v2-77a81d';
var LIB = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
// v1.6 缅甸文字体（拣货缅甸语用），离线也要能显示
var FONTS = [400, 700].map(function (w) { return 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-myanmar@5.2.5/files/noto-sans-myanmar-myanmar-' + w + '-normal.woff2'; });
var FILES = ['./', 'index.html', 'style.css?v=1.9.54-t50', 'app.js?v=1.9.54-t50', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
// B5 新前端（docs/24 A5）：v2/ 的全部文件一起预缓存（没打开过的新页面断网也能开）。下一行由 AWMS 仓库 scripts/pda-publish.mjs 写入，缓存名也跟着带上新前端的构建号
var V2 = ["v2/boot.js?b=77a81d","v2/c-chunk-45GETRTV.js","v2/c-chunk-4Y4HXNUR.js","v2/c-chunk-6X6MWN6A.js","v2/c-chunk-7ICLTE36.js","v2/c-chunk-DGCLKTUJ.js","v2/c-chunk-GPR2ZVTG.js","v2/c-chunk-GV556FA4.js","v2/c-chunk-HCBDFNZB.js","v2/c-chunk-HNHYYFOG.js","v2/c-chunk-IULNAW2Y.js","v2/c-chunk-LIMHLXSY.js","v2/c-chunk-LVVHHWFZ.js","v2/c-chunk-MC2PKUPY.js","v2/c-chunk-NHMOPNG4.js","v2/c-chunk-QA6DI7TA.js","v2/c-chunk-QUQSDBAE.js","v2/c-chunk-UOOBHOVG.js","v2/c-chunk-UUWHKQ2H.js","v2/c-chunk-W4DH5S3V.js","v2/c-chunk-ZJA7G4B5.js","v2/p-auth.js?b=77a81d","v2/p-is.js?b=77a81d","v2/p-lc.js?b=77a81d","v2/p-ld.js?b=77a81d","v2/p-map.js?b=77a81d","v2/p-mv2.js?b=77a81d","v2/p-pl.js?b=77a81d","v2/p-q.js?b=77a81d","v2/p-sort.js?b=77a81d","v2/p-sys.js?b=77a81d","v2/p-t.js?b=77a81d","v2/perf.js?b=77a81d"];
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

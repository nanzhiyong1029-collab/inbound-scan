/* 入库条码采集 + 库位转移 PWA  v1.4.7
 * 页面：#/ 任务列表 → #/job/<JobID> 商品清单 → #/p/<JobID>/<ProductID> 条码采集
 * 原则：只采集原始资料，不做任何核对。先存手机（离线队列），再上传云端。 */
(function () {
  'use strict';
  var VERSION = '1.9.16';
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var app = $('#app');

  // ---------------- 本地存储（全部 try/catch） ----------------
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { } }
  };
  // 安全（v1.2）：每台设备自己的凭据 cfg.d（办公室可单独撤销）+ 员工 PIN 登录得到的会话 sess（后台核对）
  var TOKEN_RE = /^[0-9a-f]{40,80}$/;
  var cfg = LS.get('cfg', null);               // {u: WebApp URL, d: 设备凭据}
  var authMsg = '';
  if (cfg && !(cfg.u && TOKEN_RE.test(cfg.d || ''))) { cfg = null; LS.del('cfg'); authMsg = '系统已升级：请找办公室要本设备的新设置链接（旧链接已停用）。未上传的资料仍保存在本机。'; }
  // v1.6.2 设备钥匙存 3 份（localStorage + IndexedDB + Cache Storage），任一份还在就自动补回其他两份；
  //        只有后台确认“已撤销”才删除。浏览器“清除网站数据”会把 3 份一起删掉，这种情况只能重新发链接
  var KEEP = 'inbound-scan-keep', KEEP_URL = './__device-key__';
  var cfgHold = false;                          // 后台暂时不认这把钥匙（但没确认撤销）：保留钥匙，显示设置页 + 重试
  var keepIdb = function (mode, fn) {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no idb'));
      var r = indexedDB.open(KEEP, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onerror = function () { rej(r.error); };
      r.onsuccess = function () {
        try { var t = r.result.transaction('kv', mode), st = t.objectStore('kv'), q = fn(st); t.oncomplete = function () { res(q && q.result); r.result.close(); }; t.onerror = function () { rej(t.error); }; }
        catch (e) { rej(e); }
      };
    });
  };
  var CFGK = {
    save: function (c) {
      LS.set('cfg', c);
      var j = JSON.stringify(c);
      keepIdb('readwrite', function (st) { return st.put(j, 'cfg'); }).catch(function () { });
      try { if (window.caches) caches.open(KEEP).then(function (k) { return k.put(KEEP_URL, new Response(j, { headers: { 'Content-Type': 'application/json' } })); }).catch(function () { }); } catch (e) { }
    },
    clear: function () {
      LS.del('cfg');
      keepIdb('readwrite', function (st) { return st.delete('cfg'); }).catch(function () { });
      try { if (window.caches) caches.open(KEEP).then(function (k) { return k.delete(KEEP_URL); }).catch(function () { }); } catch (e) { }
    },
    /** 读另外两份：IndexedDB 优先，再看 Cache Storage */
    restore: function () {
      var ok = function (j) { try { var c = typeof j === 'string' ? JSON.parse(j) : j; return c && c.u && TOKEN_RE.test(c.d || '') ? c : null; } catch (e) { return null; } };
      var fromCache = function () {
        try { if (!window.caches) return Promise.resolve(null); } catch (e) { return Promise.resolve(null); }
        return caches.open(KEEP).then(function (k) { return k.match(KEEP_URL); }).then(function (r) { return r ? r.text() : null; }).then(ok, function () { return null; });
      };
      var t = new Promise(function (res) { setTimeout(function () { res(null); }, 1500); });
      return Promise.race([keepIdb('readonly', function (st) { return st.get('cfg'); }).then(ok, function () { return null; }).then(function (c) { return c || fromCache(); }), t]);
    }
  };
  if (cfg) CFGK.save(cfg);                      // 每次打开都把 3 份补齐
  var sess = LS.get('sess', null);             // {t: 会话, name: 员工, dev: 设备编号}
  if (sess && !(sess.t && sess.name)) sess = null;
  var operator = sess ? sess.name : '';
  LS.del('operator');
  var device = LS.get('device', '');
  if (!device) { device = 'D' + Math.random().toString(36).slice(2, 8).toUpperCase(); LS.set('device', device); }
  var prefs = LS.get('prefs', { pda: true, autoNext: true });
  var outbox = LS.get('outbox', []);           // 待上传的保存记录（先持久化再上传）
  var lastSyncError = '';

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 1800);
  }
  // 日期：只输入数字，按马来西亚习惯 日/月/年（6 位 ddmmyy 或 8 位 ddmmyyyy）
  function pad2(n) { return ('0' + n).slice(-2); }
  function dmyFormat(v) {
    var d = String(v || '').replace(/\D/g, '').slice(0, 8);
    if (d.length <= 2) return d;
    if (d.length <= 4) return d.slice(0, 2) + '/' + d.slice(2);
    return d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4);
  }
  function dmyToIso(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (!d) return '';
    var dd, mm, yy;
    if (d.length === 6) { dd = +d.slice(0, 2); mm = +d.slice(2, 4); yy = 2000 + +d.slice(4); }
    else if (d.length === 8) { dd = +d.slice(0, 2); mm = +d.slice(2, 4); yy = +d.slice(4); }
    else return null;
    var t = new Date(Date.UTC(yy, mm - 1, dd));
    if (t.getUTCFullYear() !== yy || t.getUTCMonth() !== mm - 1 || t.getUTCDate() !== dd) return null;
    return yy + '-' + pad2(mm) + '-' + pad2(dd);
  }
  // 日期联动：有效期 = 生产日期 + 保质期(月)（同一天；该月没有这一天就取月底）
  function addMonths(iso, n) {
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return null;
    var y = +m[1], mo = +m[2] - 1 + n, d = +m[3];
    var ty = y + Math.floor(mo / 12), tm = ((mo % 12) + 12) % 12;
    var last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return ty + '-' + pad2(tm + 1) + '-' + pad2(Math.min(d, last));
  }
  /** 两个日期相差几个月（四舍五入，例如 22/09/2026 → 21/03/2028 = 18） */
  function monthsBetween(a, b) {
    var x = String(a).split('-').map(Number), y = String(b).split('-').map(Number);
    return Math.round((y[0] - x[0]) * 12 + (y[1] - x[1]) + (y[2] - x[2]) / 30);
  }
  /** 应收 / 实收：返回 { cls, diff }（只做显示，不做核对） */
  function pickCmp(exp, got) {
    if (got === '' || got == null || exp === '' || exp == null || isNaN(+exp) || isNaN(+got)) return { cls: '', diff: '' };
    var d = Math.round((+got - +exp) * 1000) / 1000;
    return { cls: d === 0 ? 'eq' : (d < 0 ? 'lt' : 'gt'), diff: d === 0 ? '' : (d > 0 ? '+' + d : String(d)) };
  }
  function isoToDmy(s) { var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] + '/' + m[1] : String(s || ''); }
  function hhmm(iso) { try { var d = new Date(iso); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); } catch (e) { return ''; } }

  // ---------------- 首次设置：#setup=<base64> ----------------
  function readSetupLink() {
    var m = location.hash.match(/#setup=([A-Za-z0-9_\-=]+)/);
    if (!m) return false;
    try {
      var b = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      var json = decodeURIComponent(Array.prototype.map.call(atob(b), function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''));
      var o = JSON.parse(json);
      if (o.u && TOKEN_RE.test(o.d || '')) {
        cfg = { u: o.u, d: o.d, r: o.r === 'up' || o.r === 'rc' || o.r === 'wc' ? o.r : '' }; CFGK.save(cfg); authMsg = ''; cfgHold = false;
        if (inAppBrowser()) setTimeout(function () { modal('<h3>请用 Chrome 打开</h3><p>现在是在聊天软件（WhatsApp / 微信等）里面打开的。设置只保存在这里，以后从桌面图标或 Chrome 打开会找不到。</p><p>请点右上角 <b>⋮</b> →「<b>在 Chrome 中打开</b>」（或复制链接到 Chrome 打开）。</p><div class="row"><button class="btn save" id="iaOk">知道了</button></div>', function (m) { $('#iaOk', m).onclick = closeModal; }); }, 300);
        setSession(null); toast(cfg.r === 'up' ? '设置已保存：这台电脑用来上传 DO' : cfg.r === 'rc' ? '设置已保存：这台电脑用来查看库位记录' : cfg.r === 'wc' ? '设置已保存：库位中控台平板，请登录' : '设置已保存，请登录');
      } else if (o.k) { authMsg = '这是旧版设置链接，已停用。请找办公室在【PDA 设备管理】生成本设备的新链接。'; toast('旧版链接已停用', 3000); }
      else toast('设置链接无效');
    } catch (e) { toast('设置链接无效'); }
    history.replaceState(null, '', location.pathname + '#/');
    return true;
  }
  readSetupLink();

  // ---------------- 网络 ----------------
  /** v1.6.2 后台回 DEVICE：2 秒后再问一次（ping），两次都说“已撤销”才删钥匙 */
  function devCheck(e) {
    if (devCheck.busy) throw e;
    devCheck.busy = true;
    return new Promise(function (r) { setTimeout(r, 2000); }).then(function () {
      return fetch(cfg.u, { method: 'POST', body: JSON.stringify({ action: 'ping', dev: cfg.d }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' }).then(function (r) { return r.json(); });
    }).then(function (d) {
      devCheck.busy = false;
      if (d.ok) throw Object.assign(new Error('网络不稳定，请再试一次'), { server: true });    // 第二次又好了：不动钥匙
      authLost('device', d.message || e.message, e.revoked && !!d.revoked);
      throw e;
    }, function (x) { devCheck.busy = false; if (x === e || x.server) throw x; throw e; });
  }
  function api(params, post) {
    if (!cfg) return Promise.reject(new Error('NOCFG'));
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, post ? 45000 : 30000);
    // 凭据只放在 POST 内容里，不出现在网址中
    var body = Object.assign({}, params, { dev: cfg.d, sess: sess ? sess.t : '' });
    var req = fetch(cfg.u, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl && ctl.signal });
    return req.then(function (r) { return r.json(); }).then(function (d) {
      clearTimeout(timer);
      setOnline(true);
      if (!d.ok) {
        var e = new Error(d.message || d.error || '服务器错误'); e.server = true; e.code = d.error;
        if (d.mods) updateMods(d.mods);
        if (d.error === 'DEVICE') { e.revoked = !!d.revoked; return devCheck(e); }
        else if (d.error === 'SESSION') authLost('session', e.message);
        throw e;
      }
      if (d.mods) updateMods(d.mods);
      return d;
    }, function (err) {
      clearTimeout(timer);
      setOnline(false);
      var e = new Error('网络不可用'); e.network = true; throw e;
    });
  }

  function setSession(s) { sess = s; operator = s ? s.name : ''; if (s) LS.set('sess', s); else LS.del('sess'); }
  // ---------- 手输（v1.4.1）：PDA 模式下扫描框平时不弹键盘；用手点一下输入框就弹出键盘，离开后恢复 ----------
  function kbdTap(e) {
    var t = e.target;
    if (!t || t.tagName !== 'INPUT' || t.getAttribute('inputmode') !== 'none') return;
    t.setAttribute('inputmode', 'text'); t.setAttribute('data-im', 'none');
    if (document.activeElement === t) { t.blur(); setTimeout(function () { t.focus(); }, 30); }   // 已经有光标：重新聚焦才会弹键盘
  }
  document.addEventListener('pointerdown', kbdTap, true);
  document.addEventListener('touchstart', kbdTap, { capture: true, passive: true });
  document.addEventListener('focusout', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute || t.getAttribute('data-im') !== 'none') return;
    setTimeout(function () { if (document.activeElement !== t) { t.setAttribute('inputmode', 'none'); t.removeAttribute('data-im'); } }, 150);
  }, true);

  // ---------- 员工可用模块（v1.4.1，办公室在【员工 / PIN 管理】打勾） ----------
  var ALL_MODS = [['in', '#/'], ['t', '#/t'], ['ld', '#/ld'], ['pk', '#/pk'], ['lm', '#/lm']];
  function myMods() { return sess && Array.isArray(sess.mods) ? sess.mods : ['in', 't', 'ld', 'pk']; }
  function hashMod(h) { h = h || '#/'; return h === '#/t' ? 't' : /^#\/ld(\/|$)/.test(h) ? 'ld' : /^#\/pk(\/|$)/.test(h) ? 'pk' : /^#\/lm(\/|$)/.test(h) ? 'lm' : 'in'; }
  function modHome() { var m = myMods(); return (ALL_MODS.filter(function (x) { return m.indexOf(x[0]) >= 0; })[0] || [])[1] || ''; }
  function updateMods(mods) {
    if (!sess || !Array.isArray(mods) || mods.join() === myMods().join()) return;
    sess.mods = mods; LS.set('sess', sess);
    if (myMods().indexOf(hashMod(location.hash)) < 0 && !(leaveGuard && leaveGuard())) setTimeout(route, 0);
  }
  /** 在聊天软件内置浏览器 / Android WebView 里打开 */
  function inAppBrowser() { return /WhatsApp|MicroMessenger|WeChat|FBAN|FBAV|Instagram|Line\/|Telegram|; wv\)/i.test(navigator.userAgent || ''); }
  /** 后台说设备被撤销 / 登录失效。v1.6.2：只有后台明确说“已撤销”（再问一次确认）才删钥匙；否则保留钥匙，显示设置页 + 重试 */
  function authLost(kind, msg, revoked) {
    if (kind === 'device') {
      if (revoked) { cfg = null; CFGK.clear(); authMsg = msg + '（未上传的资料仍保存在本机）'; }
      else { cfgHold = true; authMsg = '暂时连不上设备授权：' + msg + '。设置已保留在本机，可以点“重试连接”；如果办公室已经重新生成了链接，请打开新链接。'; }
    }
    else authMsg = msg;
    setSession(null);
    if (!(leaveGuard && leaveGuard())) setTimeout(route, 0); else toast(msg, 3000);
  }

  var online = navigator.onLine !== false;
  function setOnline(v) { online = v; renderNet(); }
  function renderNet() {
    var n = $('#net'), t = $('#netText');
    var pend = outbox.length + (typeof tqCount === 'number' ? tqCount : 0) + (typeof ldPendN === 'number' ? ldPendN : 0);
    if (!n) return;
    n.className = !online ? 'off' : (pend ? 'sync' : '');
    t.textContent = (!online ? '离线' : '在线') + (pend ? ' · 待上传 ' + pend : '');
  }
  var persisted = null;   // v1.6.2 菜单里显示是否批准长期保存
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(function (p) { return p || navigator.storage.persist(); }).then(function (p) { persisted = !!p; }).catch(function () { });   // v1.5.3 尽量不让浏览器清掉手机里的资料
  } catch (e) { }
  window.addEventListener('online', function () { setOnline(true); flush(); flushTransfers(); ldFlush(); });
  window.addEventListener('offline', function () { setOnline(false); });

  // ---------------- 离线队列：上传 ----------------
  var flushing = null;
  function flush() {
    if (flushing) return flushing;
    // 只上传当前登录员工自己的记录（后台按会话记录操作员，不能替别人上传）
    var mine = outbox.filter(function (s) { return s.operator === operator; });
    if (!mine.length || !cfg || !sess) { renderNet(); return Promise.resolve(); }
    var batch = mine.slice(0, 40);
    flushing = api({ action: 'saveBatch', saves: batch }, true).then(function (d) {
      var done = {};
      (d.results || []).forEach(function (r) {
        if (r.status === 'saved' || r.status === 'duplicate' || r.status === 'stale' || r.status === 'error' || r.status === 'rejected') done[r.saveId] = r;
        if (r.status === 'error' || r.status === 'rejected') {
          var orig = batch.filter(function (s) { return s.saveId === r.saveId; })[0];
          var failed = LS.get('failed', []); failed.push({ r: r, s: orig, at: new Date().toISOString() }); LS.set('failed', failed.slice(-200));
          toast('有资料被服务器拒绝：' + (r.message || ''), 4000);
        }
      });
      outbox = LS.get('outbox', []).filter(function (s) { return !done[s.saveId]; });
      LS.set('outbox', outbox);
      batch.forEach(function (s) {
        var r = done[s.saveId];
        if (!r) return;
        var c = cacheGet(s.jobId);
        if (c) {
          var p = c.map[s.productId];
          if (p && p.pendingId === s.saveId) { delete p.pendingId; if (r.productStatus) p.status = r.productStatus; }
          if (d.jobs && d.jobs[s.jobId]) Object.assign(c.job, d.jobs[s.jobId]);
          cachePut(s.jobId, c);
        }
      });
      lastSyncError = '';
      flushing = null;
      renderNet();
      document.dispatchEvent(new CustomEvent('synced', { detail: done }));
      if (outbox.some(function (s) { return s.operator === operator; })) return flush();
    }, function (e) {
      lastSyncError = e.message;
      flushing = null;
      renderNet();
    });
    return flushing;
  }
  setInterval(function () { if (outbox.length && sess) flush(); if (tqCount && sess) flushTransfers(); if (ldPendN && sess) ldFlush(); }, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && outbox.length) flush(); });

  // ---------------- 商品缓存（每个任务一份） ----------------
  var memCache = {};
  function cacheGet(jobId) {
    if (memCache[jobId]) return memCache[jobId];
    var c = LS.get('p_' + jobId, null);
    if (!c) return null;
    c.map = {}; c.list.forEach(function (p) { c.map[p.id] = p; });
    memCache[jobId] = c;
    return c;
  }
  function cachePut(jobId, c) {
    memCache[jobId] = c;
    var ok = LS.set('p_' + jobId, { job: c.job, list: c.list, at: c.at });
    if (!ok) { // 空间不够：删掉其他任务的缓存再试
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('p_') === 0 && k !== 'p_' + jobId) LS.del(k); });
      LS.set('p_' + jobId, { job: c.job, list: c.list, at: c.at });
    }
  }
  function fromServer(d) {
    var cols = d.cols, list = d.rows.map(function (r) { var o = {}; cols.forEach(function (k, i) { o[k] = r[i]; }); return o; });
    return { job: d.job, list: list, at: new Date().toISOString() };
  }
  function loadProducts(jobId) {
    return api({ action: 'products', jobId: jobId }).then(function (d) {
      var c = fromServer(d);
      // 还没上传的本地修改优先
      var pend = {}; outbox.forEach(function (s) { if (s.jobId === jobId) pend[s.productId] = s; });
      c.map = {};
      c.list.forEach(function (p) { c.map[p.id] = p; if (pend[p.id]) applyLocal(p, pend[p.id]); });
      cachePut(jobId, c);
      return c;
    });
  }
  function hasV(x) { return x !== null && x !== undefined && String(x).trim() !== ''; }
  function statusOf(f) {
    var any = ['pcs', 'pack', 'ctn', 'reason', 'qty', 'mfg', 'shelf', 'exp', 'remark'].some(function (k) { return hasV(f[k]); }) || f.specBad === true || f.specBad === 'Y';
    if (!any) return '未采集';
    var codesOk = hasV(f.reason) || (hasV(f.pcs) && hasV(f.ctn));
    var qtyOk = hasV(f.qty) || f.reason === '货没收到不知道实际码';
    return codesOk && qtyOk ? '已采集' : '部分采集';
  }
  function applyLocal(p, s) {
    Object.keys(s.fields).forEach(function (k) { p[k] = s.fields[k]; });
    p.specBad = s.fields.specBad ? 'Y' : '';
    p.status = statusOf(s.fields); p.op = s.operator; p.time = s.clientTime.slice(0, 16).replace('T', ' '); p.pendingId = s.saveId;
  }
  function counts(list) {
    var c = { done: 0, partial: 0, todo: 0 };
    list.forEach(function (p) { if (p.status === '已采集') c.done++; else if (p.status === '部分采集') c.partial++; else c.todo++; });
    return c;
  }

  // ---------------- 顶栏 & 菜单 ----------------
  $('#back').onclick = function () { goBack(); };
  $('#menuBtn').onclick = openMenu;
  function setBar(title, back) { $('#title').textContent = title; $('#back').hidden = !back; }
  // ---------- v1.6 仓库拣货：中文 / 缅甸语（只在拣货页面）。界面文字用对照表（MY_DICT）整句替换；
  //            品名用后台 Google 翻译的 descMy；条码、批次、库位、任务号、数字不翻（data-nt 或本来就没有中文） ----------
  var LANG = LS.get('pkLang', 'zh') === 'my' ? 'my' : 'zh', MY_KEYS = null;
  var MY_DICT = {
    "装车点货": "ကားတင်ပစ္စည်း စစ်ဆေး",
    "设置已保存，请登录": "ဆက်တင် သိမ်းပြီး၊ ဝင်ရောက်ပါ",
    "还没上传": "မတင်ရသေး",
    "网络不可用": "အင်တာနက် မရနိုင်ပါ",
    "库位 ": "စင်နေရာ ",
    "没有网络：显示手机里的任务，可以继续拣货，记录联网后自动上传": "အင်တာနက်မရှိပါ — ဖုန်းထဲက လုပ်ငန်းများကို ပြထားသည်။ ဆက်ထုတ်နိုင်ပြီး မှတ်တမ်းများကို အင်တာနက်ရလျှင် အလိုအလျောက် တင်ပို့မည်",
    "任务已完成，不能再修改。需要更正请找办公室重新打开。": "လုပ်ငန်း ပြီးဆုံးပြီ၊ ထပ်ပြင်၍ မရပါ။ ပြင်ရန်လိုလျှင် ရုံးခန်းကို ပြန်ဖွင့်ခိုင်းပါ။",
    "没有找到。可以输入品名、条码后几位、批次号或库位（如": "မတွေ့ပါ။ ပစ္စည်းအမည်၊ ဘားကုဒ် နောက်ဆုံးဂဏန်းများ၊ အသုတ်နံပါတ် သို့မဟုတ် စင်နေရာ ရိုက်ထည့်နိုင်သည် (ဥပမာ",
    "任务已完成，不能修改。需要更正请找办公室重新打开。": "လုပ်ငန်း ပြီးဆုံးပြီ၊ ပြင်၍ မရပါ။ ပြင်ရန်လိုလျှင် ရုံးခန်းကို ပြန်ဖွင့်ခိုင်းပါ။",
    "离线：这个任务还没下载到手机。第一次打开需要联网。": "အော့ဖ်လိုင်း — ဤလုပ်ငန်းကို ဖုန်းထဲ မဒေါင်းရသေးပါ။ ပထမအကြိမ် ဖွင့်ရန် အင်တာနက်လိုသည်။",
    "撤销。修改、撤销、调整都会另记一笔，原记录保留。": "ပယ်ဖျက်နိုင်သည်။ ပြင်ခြင်း၊ ပယ်ဖျက်ခြင်းတိုင်းကို သီးခြားမှတ်ထားပြီး မူလမှတ်တမ်း ကျန်ရှိမည်။",
    "扫货架上的库位码；标签坏了可以在这里输入，例如": "စင်ပေါ်ရှိ စင်နေရာကုဒ်ကို စကင်ဖတ်ပါ။ တံဆိပ်ပျက်နေလျှင် ဤနေရာတွင် ရိုက်ထည့်ပါ၊ ဥပမာ",
    "现在没有网络，手机里也还没有下载过的拣货任务。": "အင်တာနက်မရှိပါ၊ ဖုန်းထဲတွင်လည်း ဒေါင်းထားသော ပစ္စည်းထုတ်လုပ်ငန်း မရှိသေးပါ။",
    "取消“确认拣完”？这个商品会回到“未拣完”。": "“ထုတ်ပြီးကြောင်း အတည်ပြု” ကို ပယ်မလား? ဤပစ္စည်း “မထုတ်ရသေး” သို့ ပြန်သွားမည်။",
    "，不能再修改。需要更正请找办公室重新打开。": "၊ ထပ်ပြင်၍ မရပါ။ ပြင်ရန်လိုလျှင် ရုံးခန်းကို ပြန်ဖွင့်ခိုင်းပါ။",
    "可能是箱子上的备用码。请手动搜索（品名、": "သေတ္တာပေါ်ရှိ အရန်ကုဒ် ဖြစ်နိုင်သည်။ ကိုယ်တိုင်ရှာပါ (ပစ္စည်းအမည်၊ ",
    "或条码后几位），或从列表里选正确的商品。": "သို့မဟုတ် ဘားကုဒ် နောက်ဆုံးဂဏန်းများ)၊ သို့မဟုတ် စာရင်းထဲမှ မှန်ကန်သော ပစ္စည်းကို ရွေးပါ။",
    "搜索商品（品名、条码后几位、批次、库位）": "ပစ္စည်းရှာ (အမည်၊ ဘားကုဒ်နောက်ဂဏန်း၊ အသုတ်၊ စင်နေရာ)",
    "数量太大——是不是扫到了条码？请输入数量": "အရေအတွက် များလွန်းသည် — ဘားကုဒ်ကို စကင်ဖတ်မိသလား? အရေအတွက် ရိုက်ထည့်ပါ",
    "时可以带进新任务（会注明今天的日期）。": "တွင် လုပ်ငန်းအသစ်ထဲ ထည့်နိုင်သည် (ယနေ့ရက်စွဲ မှတ်ထားမည်)။",
    "联网后打开任务一次，之后断网也能继续。": "အင်တာနက်ရလျှင် လုပ်ငန်းကို တစ်ကြိမ်ဖွင့်ပါ၊ ထို့နောက် အင်တာနက်မရှိလည်း ဆက်လုပ်နိုင်သည်။",
    "。之后还可以继续加数量，或取消确认。": "။ ထို့နောက် အရေအတွက် ဆက်ထည့်နိုင်သည်၊ သို့မဟုတ် အတည်ပြုချက်ကို ပယ်နိုင်သည်။",
    "提交的是实际拣到的数量，不需要改成和": "တင်သွင်းသည်မှာ တကယ်ထုတ်ရသော အရေအတွက် ဖြစ်သည်၊ ပြင်ရန်မလိုပါ — ",
    "点错了可以修改或撤销，原记录会保留": "မှားလျှင် ပြင်နိုင် သို့မဟုတ် ပယ်ဖျက်နိုင်သည်၊ မူလမှတ်တမ်း ကျန်ရှိမည်",
    "没有找到。可以输入品名的一部分、": "မတွေ့ပါ။ ပစ္စည်းအမည် တစ်စိတ်တစ်ပိုင်း၊ ",
    "用下面的数字键输入本次拣到的数量": "အောက်ပါ နံပါတ်ခလုတ်များဖြင့် ယခုထုတ်ရသော အရေအတွက် ထည့်ပါ",
    "已不能再拣货。请回到任务列表。": "ထပ်ထုတ်၍ မရတော့ပါ။ လုပ်ငန်းစာရင်းသို့ ပြန်သွားပါ။",
    "已完成（没网，联网后自动上传）": "ပြီးဆုံးပြီ (အင်တာနက်မရှိ၊ ရလျှင် အလိုအလျောက် တင်ပို့မည်)",
    "扫描条码，或点这里手输（后几位": "ဘားကုဒ် စကင်ဖတ်ပါ၊ သို့မဟုတ် ဤနေရာနှိပ်၍ ရိုက်ထည့်ပါ (နောက်ဂဏန်း",
    "扫货架库位码可记录（可不扫）": "စင်နေရာကုဒ် စကင်ဖတ်၍ မှတ်နိုင်သည် (မဖတ်လည်း ရသည်)",
    "）、批次号、品名或条码后几位": ")၊ အသုတ်နံပါတ်၊ ပစ္စည်းအမည် သို့မဟုတ် ဘားကုဒ်နောက်ဂဏန်း",
    "找不到更多？确认拣完（短少": "ထပ်မတွေ့တော့ဘူးလား? ထုတ်ပြီးကြောင်း အတည်ပြု (လိုနေ",
    "没有找到。可以输入库位（如": "မတွေ့ပါ။ စင်နေရာ ရိုက်ထည့်နိုင်သည် (ဥပမာ",
    "这个拣货任务已被删除或取消": "ဤပစ္စည်းထုတ်လုပ်ငန်းကို ဖျက်ပြီး သို့မဟုတ် ပယ်ဖျက်ပြီး",
    "条码正确（就是这个商品）": "ဘားကုဒ် မှန်ပါသည် (ဤပစ္စည်း ဖြစ်သည်)",
    "没有拣货任务。办公室上传": "ပစ္စည်းထုတ်လုပ်ငန်း မရှိပါ။ ရုံးခန်းမှ ",
    "点批次号或库位可以只看它": "အသုတ်နံပါတ် သို့မဟုတ် စင်နေရာကို နှိပ်၍ ၎င်းကိုသာ ကြည့်နိုင်သည်",
    "离线：显示上次的任务列表": "အော့ဖ်လိုင်း — နောက်ဆုံးလုပ်ငန်းစာရင်းကို ပြထားသည်",
    "项，请输入更多字缩小范围": " မျိုး ကျန်သေးသည်၊ စာလုံးထပ်ထည့်၍ ကျဉ်းပါ",
    "可以点“完成拣货”复核": "“ပစ္စည်းထုတ်ပြီး” ကိုနှိပ်၍ ပြန်စစ်နိုင်သည်",
    "未下载，需联网打开一次": "မဒေါင်းရသေး၊ အင်တာနက်ဖြင့် တစ်ကြိမ်ဖွင့်ရန်လို",
    "行（不同批次），请选择": " ကြောင်း (အသုတ်မတူ)၊ ရွေးပါ",
    "请输入拣到的数量（大于": "ထုတ်ရသော အရေအတွက် ထည့်ပါ (",
    "）？撤销后不计入累计（": ")? ပယ်ဖျက်ပြီးနောက် စုစုပေါင်းတွင် မပါတော့ပါ (",
    "，这个条码还有其它批次": "၊ ဤဘားကုဒ်တွင် အခြားအသုတ်များလည်း ရှိသည်",
    "：只显示这个库位的商品": " — ဤစင်နေရာရှိ ပစ္စည်းများကိုသာ ပြသည်",
    "一样。没拣够的会记为": "နှင့် တူစရာမလိုပါ။ မပြည့်လျှင် မှတ်မည် — ",
    "按实际拣到的数量记录": "တကယ်ထုတ်ရသော အရေအတွက်အတိုင်း မှတ်မည်",
    "数量不对，请重新输入": "အရေအတွက် မမှန်ပါ၊ ပြန်ထည့်ပါ",
    "条码不在本次拣货单里": "ဤဘားကုဒ်သည် ဤထုတ်စာရင်းတွင် မပါပါ",
    "正确的累计数量是多少": "မှန်ကန်သော စုစုပေါင်း အရေအတွက် ဘယ်လောက်လဲ",
    "确定把这一笔的数量从": "ဤမှတ်တမ်း၏ အရေအတွက်ကို ပြောင်းမလား — ",
    "还有拣货记录没上传完": "မတင်ရသေးသော ထုတ်မှတ်တမ်းများ ရှိသေးသည်",
    "不会自动加进清单。": "စာရင်းထဲ အလိုအလျောက် မထည့်ပါ။",
    "完成后不能再修改。": "ပြီးဆုံးပြီးနောက် ပြင်၍ မရပါ။",
    "库位格式不对，例如": "စင်နေရာ ပုံစံ မမှန်ပါ၊ ဥပမာ",
    "有一笔拣货被退回：": "ထုတ်မှတ်တမ်း တစ်ခု ပြန်ပယ်ခံရသည်: ",
    "保存到手机失败（": "ဖုန်းထဲ သိမ်းမရပါ (",
    "后会出现在这里。": " တင်ပြီးနောက် ဤနေရာတွင် ပေါ်လာမည်။",
    "完成提交被退回：": "ပြီးဆုံးကြောင်း တင်ပို့ချက် ပြန်ပယ်ခံရသည်: ",
    "已确认拣完（短少": "ထုတ်ပြီးကြောင်း အတည်ပြုပြီး (လိုနေ",
    "确认拣完（短少）": "ထုတ်ပြီးကြောင်း အတည်ပြု (လိုနေ)",
    "请先输入本次数量": "ယခု အရေအတွက်ကို အရင်ထည့်ပါ",
    "请输入正确的数量": "မှန်ကန်သော အရေအတွက် ထည့်ပါ",
    "这里只能输入数量": "ဤနေရာတွင် အရေအတွက်သာ ထည့်နိုင်သည်",
    "（系统没有库位）": " (စနစ်တွင် စင်နေရာ မရှိ)",
    "），原记录保留。": ")၊ မူလမှတ်တမ်း ကျန်ရှိမည်။",
    "），请再点一次。": ")၊ ထပ်နှိပ်ပါ။",
    "），请再试一次。": ")၊ ထပ်ကြိုးစားပါ။",
    "，请输入本次数量": "၊ ယခု အရေအတွက် ထည့်ပါ",
    "”拣完了？已拣": "” ထုတ်ပြီးပြီလား? ထုတ်ပြီး",
    "和系统库位一致": "စနစ်စင်နေရာနှင့် တူသည်",
    "已下载，可离线": "ဒေါင်းပြီး၊ အော့ဖ်လိုင်းသုံးနိုင်",
    "已取消确认拣完": "ထုတ်ပြီးကြောင်း အတည်ပြုချက် ပယ်ပြီး",
    "点一行可以修改": "တစ်ကြောင်းနှိပ်၍ ပြင်နိုင်သည်",
    "确认完成拣货？": "ပစ္စည်းထုတ်ခြင်း ပြီးဆုံးကြောင်း အတည်ပြုမလား?",
    "输入正确的数量": "မှန်ကန်သော အရေအတွက် ထည့်ပါ",
    "还没有拣货记录": "ထုတ်မှတ်တမ်း မရှိသေးပါ",
    "项（所有状态）": " မျိုး (အခြေအနေအားလုံး)",
    "（没有批次号）": "(အသုတ်နံပါတ် မရှိ)",
    "个可能的商品": " ခု ဖြစ်နိုင်သော ပစ္စည်း",
    "修改后累计：": "ပြင်ပြီးနောက် စုစုပေါင်း: ",
    "修改被退回：": "ပြင်ဆင်ချက် ပြန်ပယ်ခံရသည်: ",
    "和系统不一样": "စနစ်နှင့် မတူ",
    "回到任务列表": "လုပ်ငန်းစာရင်းသို့ ပြန်",
    "实际取货库位": "တကယ့်စင်နေရာ",
    "尚未记录 · 扫描货架码即可自动记录": "မမှတ်ရသေး · စင်ကုဒ် စကင်ဖတ်လျှင် အလိုအလျောက် မှတ်မည်",
    "已记录实际取货位置": "တကယ်ထုတ်သော နေရာ မှတ်ပြီး",
    "已经记录过了（没有变化）": "မှတ်ပြီးသား (မပြောင်းလဲ)",
    "把实际取货库位从": "တကယ့်စင်နေရာကို ပြောင်းမလား —",
    "（不是商品条码，也不是库位码）": " (ပစ္စည်းဘားကုဒ် မဟုတ်၊ စင်နေရာကုဒ် မဟုတ်)",
    "无法识别：": "မသိနိုင်ပါ: ",
    "商品条码 / 货架库位码": "ပစ္စည်းဘားကုဒ် / စင်နေရာကုဒ်",
    "（选填）": " (မဖြစ်မနေ မဟုတ်)",
    "扫箱码 / 扫库位码 / 搜索商品": "သေတ္တာကုဒ် / စင်ကုဒ် စကင်ဖတ် / ပစ္စည်းရှာ",
    "有新版本，点这里更新": "ဗားရှင်းအသစ် ရှိသည် — အပ်ဒိတ်လုပ်ရန် ဤနေရာနှိပ်ပါ",
    "这个拣货任务已改派给别人（或取消了分配），不能再在这台 PDA 上拣": "ဤပစ္စည်းထုတ်လုပ်ငန်းကို အခြားသူထံ လွှဲပြီး (သို့မဟုတ် ခွဲဝေမှု ပယ်ပြီး)၊ ဤ PDA တွင် ဆက်ထုတ်၍ မရပါ",
    "这个拣货任务已分配给": "ဤပစ္စည်းထုတ်လုပ်ငန်းကို ခွဲဝေထားသူ:",
    "，不是你的任务": " — သင့်လုပ်ငန်း မဟုတ်ပါ",
    "这个拣货任务还没有分配给你": "ဤပစ္စည်းထုတ်လုပ်ငန်းကို သင့်ထံ မခွဲဝေရသေးပါ",
    "客户": "ဖောက်သည်",
    "没有分配给你的拣货任务。办公室在上传电脑分配后会出现在这里。": "သင့်ထံ ခွဲဝေထားသော ပစ္စည်းထုတ်လုပ်ငန်း မရှိပါ။ ရုံးခန်းမှ ခွဲဝေပြီးလျှင် ဤနေရာတွင် ပေါ်လာမည်။",
    "系统库位（AutoCount 没有库位）": "စနစ်စင်နေရာ (AutoCount တွင် မရှိ)",
    "系统库位（AutoCount 是": "စနစ်စင်နေရာ (AutoCount:",
    "另有库位": "အခြားစင်နေရာ",
    "确认缺货并完成": "ပစ္စည်းပြတ်ကြောင်း အတည်ပြုပြီး ပြီးဆုံး",
    "剩余短少：": "ကျန်လိုနေ: ",
    "清除": "ရှင်း",
    "已调整累计：": "စုစုပေါင်း ညှိပြီး: ",
    "或条码后几位": "သို့မဟုတ် ဘားကုဒ်နောက်ဂဏန်း",
    "撤销这一笔）": "ဤမှတ်တမ်းကို ပယ်ဖျက်)",
    "最近拣货记录": "နောက်ဆုံး ထုတ်မှတ်တမ်းများ",
    "没拣（未拣）": "မထုတ်ရ (မထုတ်ရသေး)",
    "确定把累计从": "စုစုပေါင်းကို ပြောင်းမလား — ",
    "确认后累计：": "အတည်ပြုပြီးနောက် စုစုပေါင်း: ",
    "确认完成拣货": "ပစ္စည်းထုတ်ပြီးကြောင်း အတည်ပြု",
    "确认本次数量": "ယခု အရေအတွက် အတည်ပြု",
    "系统没有库位": "စနစ်တွင် စင်နေရာမရှိ",
    "这个条码对应": "ဤဘားကုဒ်နှင့် ကိုက်ညီသည် — ",
    "这次拣了多少": "ယခု ဘယ်လောက် ထုတ်ခဲ့သလဲ",
    "修改这一笔": "ဤမှတ်တမ်းကို ပြင်",
    "全部拣完了": "အားလုံး ထုတ်ပြီးပြီ",
    "全部拣齐了": "အားလုံး ပြည့်စုံစွာ ထုတ်ပြီးပြီ",
    "和系统库位": "စနစ်စင်နေရာ",
    "已撤销一笔": "မှတ်တမ်းတစ်ခု ပယ်ဖျက်ပြီး",
    "已确认短少": "လိုနေကြောင်း အတည်ပြုပြီး",
    "扫码识别：": "စကင်ဖတ် ရှာတွေ့သည်: ",
    "拣货记录（": "ထုတ်မှတ်တမ်း (",
    "撤销这一笔": "ဤမှတ်တမ်းကို ပယ်ဖျက်",
    "数量：已拣": "အရေအတွက်: ထုတ်ပြီး",
    "时可以带上": "တွင် ထည့်နိုင်သည်",
    "条码后几位": "ဘားကုဒ်နောက်ဂဏန်း",
    "行，请选择": " ကြောင်း၊ ရွေးပါ",
    "（已拣齐）": " (ပြည့်စုံစွာ ထုတ်ပြီး)",
    "（待上传）": " (တင်ပို့ရန် စောင့်နေ)",
    "（超出需求": " (လိုအပ်ချက်ထက် ပို",
    "，下次上传": "၊ နောက်တစ်ကြိမ် တင်ပို့",
    "下次上传": "နောက်တစ်ကြိမ် တင်ပို့",
    "之前未拣": "ယခင် မထုတ်ရသေး",
    "仓库拣货": "ဂိုဒေါင် ပစ္စည်းထုတ်",
    "保存修改": "ပြင်ဆင်ချက် သိမ်း",
    "保存失败": "သိမ်းမရပါ",
    "全部商品": "ပစ္စည်းအားလုံး",
    "全部拣完": "အားလုံး ထုတ်ပြီး",
    "加载中…": "ဖွင့်နေသည်…",
    "取消确认": "အတည်ပြုချက် ပယ်",
    "商品条码": "ပစ္စည်းဘားကုဒ်",
    "完成拣货": "ပစ္စည်းထုတ်ပြီး",
    "实际库位": "တကယ့်စင်နေရာ",
    "已修改：": "ပြင်ပြီး: ",
    "已撤销（": "ပယ်ဖျက်ပြီး (",
    "库位转移": "စင်နေရာ ရွှေ့ပြောင်း",
    "手动搜索": "ကိုယ်တိုင်ရှာ",
    "拣货记录": "ထုတ်မှတ်တမ်း",
    "搜索商品": "ပစ္စည်းရှာ",
    "改成多少": "ဘယ်လောက်သို့ ပြင်မလဲ",
    "本机还有": "ဖုန်းထဲတွင် ကျန်သေးသည် ",
    "本次数量": "ယခု အရေအတွက်",
    "查看结果": "ရလဒ်ကြည့်",
    "没有变化": "မပြောင်းလဲပါ",
    "现在累计": "ယခု စုစုပေါင်း",
    "确定修改": "ပြင်မည်",
    "确定撤销": "ပယ်ဖျက်မည်",
    "确定调整": "ညှိမည်",
    "确认保存": "အတည်ပြု သိမ်း",
    "确认完成": "ပြီးဆုံးကြောင်း အတည်ပြု",
    "确认拣完": "ထုတ်ပြီးကြောင်း အတည်ပြု",
    "确认累加": "ပေါင်းထည့်ရန် အတည်ပြု",
    "笔待上传": " ခု တင်ပို့ရန် စောင့်နေ",
    "笔没上传": " ခု မတင်ရသေး",
    "笔，合计": " ခု၊ စုစုပေါင်း",
    "累加后：": "ပေါင်းပြီးနောက်: ",
    "累计已拣": "စုစုပေါင်း ထုတ်ပြီး",
    "继续拣货": "ဆက်ထုတ်",
    "调整数量": "အရေအတွက် ညှိ",
    "调整累计": "စုစုပေါင်း ညှိ",
    "返回列表": "စာရင်းသို့ ပြန်",
    "还没确认": "အတည်မပြုရသေး",
    "（拣齐）": " (ပြည့်စုံ)",
    "？（累计": "? (စုစုပေါင်း",
    "下一个": "နောက်တစ်ခု",
    "下一步": "ရှေ့ဆက်",
    "不一样": "မတူ",
    "再看看": "ပြန်ကြည့်မည်",
    "原因：": "အကြောင်းရင်း: ",
    "员工：": "ဝန်ထမ်း: ",
    "品名）": "ပစ္စည်းအမည်)",
    "已保存": "သိမ်းပြီး",
    "已修改": "ပြင်ပြီး",
    "已删除": "ဖျက်ပြီး",
    "已完成": "ပြီးဆုံး",
    "已拣完": "ထုတ်ပြီး",
    "已拣齐": "ပြည့်စုံစွာ ထုတ်ပြီး",
    "已撤销": "ပယ်ဖျက်ပြီး",
    "已超出": "ပိုနေပြီ",
    "待上传": "တင်ပို့ရန် စောင့်နေ",
    "待拣货": "မထုတ်ရသေး",
    "批次号": "အသုတ်နံပါတ်",
    "拣货中": "ထုတ်နေဆဲ",
    "搜索“": "ရှာ “",
    "无库位": "စင်နေရာမရှိ",
    "未上传": "မတင်ရသေး",
    "未拣完": "မထုတ်ရသေး",
    "没拣够": "မပြည့်သေး",
    "现在共": "ယခု စုစုပေါင်း",
    "知道了": "သိပြီ",
    "确认“": "အတည်ပြု “",
    "筛选“": "စစ်ထုတ် “",
    "选商品": "ပစ္စည်းရွေး",
    "（改成": " (ပြင်ရန်",
    "（空）": " (ဗလာ)",
    "（超出": " (ပို",
    "，短少": "၊ လိုနေ",
    "一致": "တူသည်",
    "之前": "ယခင်",
    "任务": "လုပ်ငန်း",
    "修改": "ပြင်",
    "入库": "ပစ္စည်းဝင်",
    "全部": "အားလုံး",
    "关闭": "ပိတ်",
    "再点": "ထပ်ထုတ်",
    "刷新": "ပြန်ဖွင့်",
    "原来": "မူလ",
    "取消": "မလုပ်တော့",
    "品名": "ပစ္စည်းအမည်",
    "商品": "ပစ္စည်း",
    "在线": "အွန်လိုင်း",
    "复核": "ပြန်စစ်",
    "大约": "ခန့်",
    "差异": "ကွာခြား",
    "差额": "ကွာခြားချက်",
    "已拣": "ထုတ်ပြီး",
    "库位": "စင်နေရာ",
    "应拣": "ထုတ်ရမည်",
    "手输": "ရိုက်ထည့်",
    "扫描": "စကင်ဖတ်",
    "扫码": "စကင်ဖတ်",
    "批次": "အသုတ်",
    "找到": "တွေ့သည်",
    "拣完": "ထုတ်ပြီး",
    "拣齐": "ပြည့်စုံ",
    "搜索": "ရှာ",
    "撤销": "ပယ်ဖျက်",
    "改成": "ပြင်ရန်",
    "放弃": "စွန့်",
    "数量": "အရေအတွက်",
    "日期": "ရက်စွဲ",
    "未拣": "မထုတ်ရသေး",
    "本机": "ဖုန်းထဲ",
    "条码": "ဘားကုဒ်",
    "没有": "မရှိ",
    "现在": "ယခု",
    "短少": "လိုနေ",
    "确定": "အတည်ပြု",
    "离线": "အော့ဖ်လိုင်း",
    "笔）": " ခု)",
    "累计": "စုစုပေါင်း",
    "调整": "ညှိ",
    "超出": "ပိုနေ",
    "还差": "လိုသေး",
    "还有": "ကျန်သေး",
    "退格": "နောက်ပြန်ဖျက်",
    "需求": "လိုအပ်",
    "个": "ခု",
    "件": "ခု",
    "共": "စုစုပေါင်း",
    "包": "ထုပ်",
    "单": "တစ်ခုချင်း",
    "卷": "လိပ်",
    "号": "နံပါတ်",
    "张": "စောင်",
    "把": "စည်း",
    "排": "တန်း",
    "支": "ချောင်း",
    "改": "ပြင်",
    "斤": "ကျင်",
    "条": "ချောင်း",
    "板": "ကတ်",
    "桶": "ပုံး",
    "片": "ချပ်",
    "瓶": "ပုလင်း",
    "盒": "ဗူး",
    "码": "ကုဒ်",
    "第": "အမှတ်",
    "箱": "သေတ္တာ",
    "粒": "လုံး",
    "组": "အစုံ",
    "罐": "ဘူး",
    "袋": "အိတ်",
    "项": "မျိုး"
  };
  function myOn() { return LANG === 'my' && !!cfg && !cfg.r && /^#\/pk(\/|$)/.test(location.hash || ''); }
  function myText(v) {
    if (!/[\u3400-\u9fff\uff08-\uff1f\u3001-\u3011]/.test(v)) return v;
    if (!MY_KEYS) MY_KEYS = Object.keys(MY_DICT).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < MY_KEYS.length; i++) { var k = MY_KEYS[i]; if (v.indexOf(k) >= 0) v = v.split(k).join(MY_DICT[k]); }
    return v;
  }
  function myNt(n) { for (var e = n.nodeType === 1 ? n : n.parentNode; e && e !== document.body; e = e.parentNode) if (e.nodeType === 1 && (e.hasAttribute('data-nt') || /^(SCRIPT|STYLE|TEXTAREA)$/.test(e.tagName))) return true; return false; }
  function myFix(n) {
    if (n.nodeType === 3) { if (!myNt(n)) { var v = myText(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; } return; }
    if (n.nodeType !== 1 || myNt(n)) return;
    if (n.tagName === 'INPUT' && n.placeholder) { var p = myText(n.placeholder); if (p !== n.placeholder) n.placeholder = p; }
    var w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT), x;
    while ((x = w.nextNode())) {
      if (x.nodeType === 3) { if (!myNt(x)) { var t = myText(x.nodeValue); if (t !== x.nodeValue) x.nodeValue = t; } }
      else if (x.tagName === 'INPUT' && x.placeholder) { var q = myText(x.placeholder); if (q !== x.placeholder) x.placeholder = q; }
    }
  }
  if (window.MutationObserver) new MutationObserver(function (ms) {
    if (!myOn()) return;
    ms.forEach(function (m) { if (m.type === 'characterData') myFix(m.target); else Array.prototype.forEach.call(m.addedNodes, myFix); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  function langApply() {
    var on = myOn(); document.body.classList.toggle('lang-my', on);
    document.documentElement.lang = on ? 'my' : 'zh-CN';   // v1.6.3 配合 translate=no：浏览器自动翻译不再插手（APP 自己翻缅甸语）
    var b = $('#langBtn'); if (b) { b.hidden = !(cfg && !cfg.r && sess && /^#\/pk(\/|$)/.test(location.hash || '')); b.textContent = LANG === 'my' ? '中文' : 'မြန်မာ'; }
    if (on) { myFix(document.body); }
  }
  (function () {
    var mb = $('#menuBtn'); if (!mb || $('#langBtn')) return;
    var b = document.createElement('button'); b.id = 'langBtn'; b.className = 'icon langbtn'; b.hidden = true; b.setAttribute('data-nt', '');
    b.onclick = function () { LANG = LANG === 'my' ? 'zh' : 'my'; LS.set('pkLang', LANG); route(); renderNet(); langApply(); };
    mb.parentNode.insertBefore(b, mb);
  })();
  function goBack() {
    var h = location.hash;
    var m = h.match(/^#\/p\/([^/]+)\//);
    if (m) return guardLeave(function () { location.hash = '#/job/' + m[1]; });
    var l = h.match(/^#\/(ld|pk)\/([^/]+)\/(review|i\/\d+)$/);
    if (l) { location.hash = '#/' + l[1] + '/' + l[2]; return; }
    if ((l = h.match(/^#\/(ld|pk)\//))) { location.hash = '#/' + l[1]; return; }
    location.hash = '#/';
  }

  function modal(html, onReady) {
    var m = $('#modal'); m.innerHTML = '<div class="sheet">' + html + '</div>'; m.hidden = false;
    m.onclick = function (e) { if (e.target === m) closeModal(); };
    if (onReady) onReady(m);
  }
  function closeModal() { var m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
  function confirmBox(msg, okText, cb) {
    modal('<h3>' + esc(msg) + '</h3><div class="row"><button class="btn ghost" id="cNo">取消</button><button class="btn save" id="cYes">' + esc(okText) + '</button></div>', function (m) {
      $('#cNo', m).onclick = closeModal; $('#cYes', m).onclick = function () { closeModal(); cb(); };
    });
  }

  function openMenu() {
    modal('<div class="menu">' +
      '<div class="hint">员工：<b>' + esc(operator || '未登录') + '</b> · 设备 ' + esc((sess && sess.dev) || device) + ' · v' + VERSION + '</div>' +
      '<div class="hint">本机长期保存：' + (persisted === true ? '<b style="color:#1a7f37">已批准</b>（清理缓存不会掉线）' : persisted === false ? '<b style="color:#b45309">未批准</b>（建议把 APP 添加到主屏幕）' : '不支持') + '</div>' +
      '<button id="mSync">立即上传（待上传 ' + (outbox.length + tqCount + ldPendN) + '）</button>' +
      othersNote() +
      '<button id="mOp">退出 / 切换员工</button>' +
      '<button id="mPda">PDA 扫描头模式：' + (prefs.pda ? '开（不弹出键盘）' : '关（手机键盘输入）') + '</button>' +
      '<button id="mNext">扫完箱码后自动跳到 SAVE：' + (prefs.autoNext ? '开' : '关') + '</button>' +
      '<button id="mTest">扫描头测试</button>' +
      '<button id="mCfg">服务器设置</button>' +
      '<button id="mClear">清除商品缓存（不会删除待上传资料）</button>' +
      (lastSyncError ? '<div class="err hint">上次上传失败：' + esc(lastSyncError) + '</div>' : '') +
      failedNote() +
      '</div>', function (m) {
        $('#mSync', m).onclick = function () { closeModal(); toast('上传中…'); flushTransfers(); ldFlush(); flush().then(function () { toast(outbox.length ? '还有 ' + outbox.length + ' 条未上传（网络不可用）' : '全部已上传 ✓'); }); };
        $('#mOp', m).onclick = function () { closeModal(); guardLeave(function () { if (sess && cfg) api({ action: 'logout' }).catch(function () { }); setSession(null); route(); }); };
        $('#mPda', m).onclick = function () { prefs.pda = !prefs.pda; LS.set('prefs', prefs); closeModal(); route(); };
        $('#mNext', m).onclick = function () { prefs.autoNext = !prefs.autoNext; LS.set('prefs', prefs); closeModal(); };
        $('#mTest', m).onclick = function () { closeModal(); scannerTest(); };
        $('#mCfg', m).onclick = function () { closeModal(); viewSetup(true); };
        $('#mClear', m).onclick = function () {
          Object.keys(localStorage).forEach(function (k) { if (k.indexOf('p_') === 0) LS.del(k); });
          memCache = {}; closeModal(); toast('已清除'); route();
        };
      });
  }

  function othersNote() {
    var o = {}; outbox.forEach(function (s) { if (s.operator !== operator) o[s.operator] = (o[s.operator] || 0) + 1; });
    var k = Object.keys(o);
    return k.length ? '<div class="hint err">' + k.map(function (n) { return esc(n || '?') + ' 的 ' + o[n] + ' 条'; }).join('、') + ' 还没上传：需要本人在这台设备登录后才会上传。</div>' : '';
  }
  function failedNote() {
    var f = LS.get('failed', []);
    if (!f.length) return '';
    var last = f[f.length - 1];
    return '<div class="hint err">被服务器拒绝的保存共 ' + f.length + ' 条（资料保存在本机）。最近一条：' + esc((last.r && last.r.message) || '') + '</div>';
  }

  function scannerTest() {
    modal('<h3>扫描头测试</h3><p class="hint">用 PDA 扫描头扫任意条码，结果显示在下面。如果没反应，请在 PDA 扫描设置里把输出方式设为“键盘输入/模拟键盘”，并开启“回车(Enter)后缀”。</p>' +
      '<input id="tIn" class="search" inputmode="none" autocomplete="off"><div id="tOut" class="hint" style="margin-top:8px"></div>' +
      '<div class="row"><button class="btn ghost" id="tClose">关闭</button></div>', function (m) {
        var i = $('#tIn', m); i.focus();
        i.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); $('#tOut', m).innerHTML = '✓ 收到：<b>' + esc(i.value) + '</b>（' + i.value.length + ' 位，含回车）'; i.select(); }
        });
        $('#tClose', m).onclick = closeModal;
      });
  }

  // ---------------- 路由 ----------------
  var leaveGuard = null;   // 采集页有未保存修改时设置
  function guardLeave(go) {
    if (leaveGuard && leaveGuard()) confirmBox('有未保存的修改，确定离开？', '离开不保存', function () { leaveGuard = null; go(); });
    else go();
  }
  // Android 返回键 / 浏览器后退时也检查未保存修改
  var curHash = location.hash, ignoreHash = false;
  window.addEventListener('hashchange', function () {
    if (ignoreHash) { ignoreHash = false; return; }
    if (readSetupLink()) { leaveGuard = null; route(); return; }   // APP 已打开时再点设置链接
    if (leaveGuard && leaveGuard()) {
      var target = location.hash;
      ignoreHash = true; location.hash = curHash;
      confirmBox('有未保存的修改，确定离开？', '离开不保存', function () { leaveGuard = null; location.hash = target; });
      return;
    }
    route();
  });
  document.addEventListener('synced', function () { if (currentRedraw) currentRedraw(); });
  var currentRedraw = null;
  function route() {
    stopCamera();
    kpPage = null; kpModal = null;
    setTimeout(langApply, 0);
    leaveGuard = null;
    currentRedraw = null;
    app.onclick = null;
    curHash = location.hash;
    if (!cfg || cfgHold) return viewSetup(false);
    if (cfg.r === 'up') return viewUpload();          // 装车点货：办公室上传电脑，不用员工登录
    document.body.classList.remove('wcon');
    if (cfg.r === 'rc') return location.hash === '#/wc' ? viewConsole() : viewRecords();         // v1.6 库位记录后台电脑；v1.9 #/wc 平板中控台
    if (cfg.r === 'wc') {                             // v1.9.1 库位中控台平板：员工登录（和 PDA 一样），只有中控台
      if (!sess) return viewLogin();
      if (myMods().indexOf('wc') < 0) {
        setBar('库位中控台', false);
        app.innerHTML = '<div class="empty">员工 ' + esc(operator) + ' 没有【库位中控台】的权限。<br>请找办公室在【员工 / PIN 管理】勾选“中控台（平板）”。<br><br><button class="btn ghost" id="wcNoOut">退出登录</button></div>';
        $('#wcNoOut').onclick = function () { api({ action: 'logout' }).catch(function () { }); setSession(null); route(); };
        return;
      }
      if (location.hash !== '#/wc') { history.replaceState(null, '', '#/wc'); }
      return viewConsole();
    }
    if (!sess) return viewLogin();
    var h = location.hash || '#/';
    var m;
    if (myMods().indexOf(hashMod(h)) < 0) {          // 没有这个模块的权限 → 去第一个能用的模块
      var home = modHome();
      if (home) { location.hash = home; return; }
      else {
        setBar('没有可用的模块', false);
        app.innerHTML = '<div class="empty">员工 ' + esc(operator) + ' 目前没有可用的模块。<br>请找办公室在【员工 / PIN 管理】里打勾开通。<br><br><button class="btn ghost" id="noModOut">退出登录</button></div>';
        $('#noModOut').onclick = function () { api({ action: 'logout' }).catch(function () { }); setSession(null); route(); };
        return;
      }
    }
    if ((m = h.match(/^#\/job\/([^/]+)$/))) return viewProducts(decodeURIComponent(m[1]));
    if ((m = h.match(/^#\/p\/([^/]+)\/([^/]+)$/))) return viewCollect(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if (h === '#/t') return viewTransfer();
    if ((m = h.match(/^#\/lm(?:\/(l|i|todo|noloc|tasks|a|empty|exp)(?:\/([^?]+))?)?(?:\?.*)?$/))) return viewLm(m[1] || '', m[2] ? decodeURIComponent(m[2]) : '');   // v1.8 库位管理（仓管）
    if (h === '#/ld' || h === '#/pk') return viewLdList(h.slice(2));
    if ((m = h.match(/^#\/(ld|pk)\/([^/]+?)(\/review|\/i\/(\d+))?$/))) return viewLdTask(decodeURIComponent(m[2]), m[3] === '/review', m[1] === 'pk' && m[4] != null ? Number(m[4]) : null);
    return viewJobs();
  }

  // ---------------- 设置 & 登录 ----------------
  function viewSetup(editing) {
    setBar('服务器设置', editing);
    app.innerHTML = '<div class="card">' + (authMsg ? '<p class="err">' + esc(authMsg) + '</p>' : '') +
      '<p>请用办公室发来的<b>本设备专用设置链接</b>打开本页面（会自动完成设置）。每台设备的链接不同，不要转发给别人。也可以手动填写：</p>' +
      '<div class="field"><label>服务器网址 (Web App URL)</label><input id="sU" value="' + esc(cfg ? cfg.u : '') + '"></div>' +
      '<div class="field"><label>设备凭据</label><input id="sK" type="password" autocomplete="off" value="' + esc(cfg ? cfg.d : '') + '"></div>' +
      (cfgHold ? '<button class="btn save" id="sRetry" style="width:100%;margin-bottom:8px">↻ 重试连接</button>' : '') +
      (inAppBrowser() ? '<p class="err">现在是在聊天软件里打开的，设置会只保存在这里。请点右上角 ⋮ →「在 Chrome 中打开」。</p>' : '') +
      '<button class="btn save" id="sSave" style="width:100%">保存并测试连接</button><p id="sMsg" class="hint"></p></div>';
    var rt = $('#sRetry'); if (rt) rt.onclick = function () {
      $('#sMsg').textContent = '连接中…'; cfgHold = false;
      api({ action: 'ping' }).then(function () { authMsg = ''; toast('连接成功'); location.hash = '#/'; route(); },
        function (e) { cfgHold = cfgHold || e.code === 'DEVICE'; if (e.code === 'DEVICE') return; cfgHold = true; $('#sMsg').innerHTML = '<span class="err">连接失败：' + esc(e.message) + '</span>'; });
    };
    $('#sSave').onclick = function () {
      var u = $('#sU').value.trim(), k = $('#sK').value.trim();
      if (!/^https:\/\//.test(u) || !TOKEN_RE.test(k)) { $('#sMsg').textContent = '网址必须以 https:// 开头，设备凭据格式不对'; return; }
      cfg = { u: u, d: k }; CFGK.save(cfg); setSession(null); authMsg = ''; cfgHold = false;
      $('#sMsg').textContent = '测试中…';
      api({ action: 'ping' }).then(function () { toast('连接成功'); location.hash = '#/'; route(); },
        function (e) { if (e.code === 'DEVICE') return; $('#sMsg').innerHTML = '<span class="err">连接失败：' + esc(e.message) + '</span>（已保存，可稍后再试）'; });
    };
  }

  function viewLogin() {
    setBar('选择员工', false);
    var cached = LS.get('staff', []);
    var chosen = null;
    function draw(list, msg) {
      app.innerHTML = '<div class="card">' + (authMsg ? '<p class="err">' + esc(authMsg) + '</p>' : '') + '<h3 style="margin-top:0">请选择你的名字</h3><div class="staff">' +
        list.map(function (s, i) { return '<button data-i="' + i + '"' + (s.ready === false ? ' disabled title="办公室还没设置 PIN"' : '') + '>' + esc(s.name) + (s.ready === false ? '（未设 PIN）' : '') + '</button>'; }).join('') +
        '</div><div id="pinBox" hidden class="field" style="margin-top:12px"><label>PIN（4–8 位数字）</label><input id="pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>' +
        '<button class="btn save" id="lgo" style="width:100%;margin-top:12px" disabled>进入</button>' +
        '<p class="hint" id="lmsg">' + esc(msg || '') + '</p></div>';
      Array.prototype.forEach.call(app.querySelectorAll('.staff button'), function (b) {
        b.onclick = function () {
          Array.prototype.forEach.call(app.querySelectorAll('.staff button'), function (x) { x.classList.remove('on'); });
          b.classList.add('on'); chosen = list[+b.dataset.i];
          $('#pinBox').hidden = false; $('#lgo').disabled = false; $('#pin').value = ''; $('#pin').focus();
        };
      });
      $('#pin').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); $('#lgo').click(); } };
      $('#lgo').onclick = function () {
        if (!chosen) return;
        var pin = $('#pin').value.trim();
        if (!/^\d{4,8}$/.test(pin)) { $('#lmsg').innerHTML = '<span class="err">请输入 4–8 位数字 PIN</span>'; $('#pin').focus(); return; }
        $('#lgo').disabled = true;
        api({ action: 'login', name: chosen.name, pin: pin }).then(function (d) {
          if (!d.login) { $('#lmsg').innerHTML = '<span class="err">' + esc(d.message) + '</span>'; $('#lgo').disabled = false; $('#pin').value = ''; return; }
          authMsg = ''; setSession({ t: d.session, name: d.name, dev: d.device, mods: Array.isArray(d.mods) ? d.mods : null });
          location.hash = '#/'; route(); flush();
        }, function (e) {
          if (e.code === 'DEVICE') return;
          $('#lmsg').innerHTML = '<span class="err">' + esc(e.network ? '需要联网才能登录' : e.message) + '</span>'; $('#lgo').disabled = false;
        });
      };
    }
    draw(cached, cached.length ? '' : '加载员工名单…');
    api({ action: 'staff' }).then(function (d) { LS.set('staff', d.staff); draw(d.staff); },
      function (e) { if (e.code !== 'DEVICE' && !cached.length) draw([], '无法加载员工名单：' + e.message); });
  }

  // ---------------- 页面 1：入库任务列表 ----------------
  function viewJobs() {
    setBar('入库任务', false);
    var cached = LS.get('jobs', null);
    function draw(jobs, note) {
      if (!jobs) { app.innerHTML = '<div class="empty">加载中…</div>'; return; }
      app.innerHTML = modTabs('in') + '<div class="topline"><span>员工：' + esc(operator) + '</span><button class="link" id="jr">刷新</button></div>' +
        (note ? '<p class="hint">' + esc(note) + '</p>' : '') +
        (jobs.length ? '' : '<div class="empty">没有进行中的入库任务</div>') +
        jobs.map(function (j) {
          var c = cacheGet(j.id);
          var k = c ? counts(c.list) : { done: j.done, partial: j.partial, todo: j.todo };
          var total = j.total || 1;
          return '<button class="card job" data-id="' + esc(j.id) + '"><div class="id">' + esc(j.id) + '</div>' +
            '<div class="meta"><span>PO No.</span><b>' + esc(j.poCount > 1 ? j.poCount + ' 个：' + j.pos : j.pos) + '</b>' +
            '<span>Supplier</span><b>' + esc(j.supplier) + '</b><span>Arrival</span><b>' + esc(j.arrival) + '</b></div>' +
            '<div class="progress"><i class="d" style="width:' + (k.done / total * 100) + '%"></i><i class="p" style="width:' + (k.partial / total * 100) + '%"></i></div>' +
            '<div class="ptext">已采集 ' + k.done + ' / ' + j.total + ' · 部分 ' + k.partial + ' · 未采集 ' + k.todo + '</div></button>';
        }).join('');
      Array.prototype.forEach.call(app.querySelectorAll('.job'), function (b) {
        b.onclick = function () { location.hash = '#/job/' + encodeURIComponent(b.dataset.id); };
      });
      $('#jr').onclick = load;
      bindModTabs();
    }
    function load() {
      api({ action: 'jobs' }).then(function (d) { LS.set('jobs', d.jobs); if (location.hash === '#/' || !location.hash) draw(d.jobs); },
        function (e) { if (location.hash === '#/' || !location.hash) draw(cached || [], e.network ? '离线：显示上次的任务列表' : e.message); });
    }
    draw(cached);
    load();
    if (outbox.length) flush();
  }

  // ---------------- 页面 2：商品清单 ----------------
  var listState = LS.get('listState', {});   // 每个任务记住搜索词/筛选/滚动位置
  function viewProducts(jobId) {
    setBar(jobId, true);
    var st = listState[jobId] || { q: '', f: 'all', y: 0 };
    var c = cacheGet(jobId);
    app.innerHTML = '<div class="searchbox"><input id="q" class="search" type="search" placeholder="搜索商品名 / 系统商品名 / 规格 / PO" autocomplete="off" value="' + esc(st.q) + '">' +
      '<div class="chips">' + [['all', '全部'], ['todo', '未采集'], ['part', '部分采集'], ['done', '已采集']].map(function (x) {
        return '<button class="chip' + (st.f === x[0] ? ' on' : '') + '" data-f="' + x[0] + '">' + x[1] + ' <span data-n="' + x[0] + '"></span></button>';
      }).join('') + '</div></div><div id="plist"><div class="empty">加载中…</div></div>';
    var q = $('#q');
    var timer;
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { st.q = q.value; st.y = 0; draw(); }, 120); });
    Array.prototype.forEach.call(app.querySelectorAll('.chip'), function (b) {
      b.onclick = function () { st.f = b.dataset.f; st.y = 0; Array.prototype.forEach.call(app.querySelectorAll('.chip'), function (x) { x.classList.toggle('on', x === b); }); draw(); window.scrollTo(0, 0); };
    });
    function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }
    function filtered() {
      if (!c) return [];
      var words = norm(st.q) ? String(st.q).toLowerCase().split(/\s+/).filter(Boolean) : [];
      return c.list.filter(function (p) {
        if (st.f === 'todo' && p.status !== '未采集') return false;
        if (st.f === 'part' && p.status !== '部分采集') return false;
        if (st.f === 'done' && p.status !== '已采集') return false;
        if (!words.length) return true;
        var hay = p._h || (p._h = norm(p.name + ' ' + p.spec + ' ' + (p.sysName || '') + ' ' + (p.itemCode || '') + ' ' + p.po + ' ' + p.seq));
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
    }
    function draw() {
      listState[jobId] = st; LS.set('listState', listState);
      if (!c) return;
      var k = counts(c.list);
      var nums = { all: c.list.length, todo: k.todo, part: k.partial, done: k.done };
      Object.keys(nums).forEach(function (f) { var el = app.querySelector('[data-n="' + f + '"]'); if (el) el.textContent = nums[f]; });
      setBar(jobId + '  ' + k.done + '/' + c.list.length, true);
      var list = filtered();
      var cls = { '已采集': 'b-done', '部分采集': 'b-part', '未采集': 'b-todo' };
      $('#plist').innerHTML = list.length ? '<div class="list">' + list.map(function (p) {
        return '<button class="prod" data-id="' + esc(p.id) + '"><span class="no">' + p.seq + '</span><span class="nm"><div>' + esc(p.name) + '</div>' +
          ((p.spec || p.sysSpec) ? '<div class="sp">' + esc(p.spec) + (p.sysSpec ? ' · 系统 ' + esc(p.sysSpec) : '') + '</div>' : '') +
          ((p.expQty || p.qty) ? (function () {
            var c = pickCmp(p.expQty, p.qty);
            return '<div class="sp pick">应收 <b>' + esc(p.expQty || '—') + '</b> · 实收 <b class="got ' + c.cls + '">' + esc(p.qty === '' || p.qty == null ? '—' : p.qty) + '</b> ' + esc(p.unit || '件') +
              (c.diff ? ' <span class="pdiff ' + c.cls + '">' + esc(c.diff) + '</span>' : '') + '</div>';
          })() : '') +
          (p.specBad === 'Y' ? '<span class="tag-bad">规格不符</span>' : '') + '</span>' +
          '<span class="badge ' + (cls[p.status] || 'b-todo') + '">' + esc(p.status) + (p.pendingId ? '<span class="pend" title="待上传">⇡</span>' : '') + '</span></button>';
      }).join('') + '</div>' : '<div class="empty">没有符合条件的商品</div>';
    }
    $('#plist').addEventListener('click', function (e) {
      var b = e.target.closest('.prod'); if (!b) return;
      st.y = window.scrollY; listState[jobId] = st; LS.set('listState', listState);
      LS.set('nav_' + jobId, filtered().map(function (p) { return p.id; }));   // NEXT PRODUCT 按当前筛选顺序
      location.hash = '#/p/' + encodeURIComponent(jobId) + '/' + encodeURIComponent(b.dataset.id);
    });
    currentRedraw = function () { var y = window.scrollY; c = cacheGet(jobId); draw(); window.scrollTo(0, y); };
    var hadCache = !!c;
    if (c) { draw(); window.scrollTo(0, st.y || 0); }
    var myHash = location.hash;
    loadProducts(jobId).then(function (fresh) {
      if (location.hash !== myHash) return;
      var y = hadCache ? window.scrollY : (st.y || 0); c = fresh; draw(); window.scrollTo(0, y);
    }, function (e) {
      if (!c) $('#plist').innerHTML = '<div class="empty">' + (e.network ? '离线，且本机没有这个任务的缓存。请联网后再打开。' : esc(e.message)) + '</div>';
      else toast(e.network ? '离线：显示本机缓存' : e.message);
    });
  }

  // ---------------- 页面 3：条码采集 ----------------
  var BC = [['pcs', 'Single Item Barcode', '单品条码 PCS'], ['pack', 'Middle Package Barcode', '中包装条码 PACK'], ['ctn', 'Carton Barcode', '箱码 CTN']];
  var REASONS = ['货本来就没条码', '货没收到不知道实际码', '自包装产品'];
  // 与后台相同的输入检查（后台为准；这里先提示，免得白跑一趟）
  var BARCODE_RE = /^[0-9A-Za-z][0-9A-Za-z\-.\/]*$/;
  function checkInput(v) {
    var errs = [];
    BC.forEach(function (b) { var x = v[b[0]]; if (x && (x.length > 64 || !BARCODE_RE.test(x))) errs.push(b[2] + '：只能是字母、数字和 - . /，最多 64 位（现在是 ' + x + '）'); });
    if (v.qty && !(/^\d{1,7}(\.\d{1,3})?$/.test(v.qty) && +v.qty <= 1000000)) errs.push('实收数量：只能填数字');
    if (v.shelf && !(/^\d{1,3}$/.test(v.shelf) && +v.shelf <= 600)) errs.push('保质期（月）：0–600 的整数');
    [['specActual', '实际规格', 60], ['remark', '备注', 200]].forEach(function (x) {
      var t = v[x[0]] || '';
      if (t.length > x[2]) errs.push(x[1] + '：最多 ' + x[2] + ' 个字');
      if (t.charAt(0) === '=') errs.push(x[1] + '：不能以 = 开头');
    });
    if (v.reason && REASONS.indexOf(v.reason) < 0) errs.push('无条码原因：请从选项里选');
    return errs;
  }

  function viewCollect(jobId, pid) {
    var c = cacheGet(jobId);
    if (!c || !c.map[pid]) {
      app.innerHTML = '<div class="empty">加载中…</div>';
      loadProducts(jobId).then(function () { if (location.hash.indexOf('#/p/') === 0) viewCollect(jobId, pid); },
        function () { app.innerHTML = '<div class="empty">找不到商品（离线且无缓存）</div>'; });
      return;
    }
    var p = c.map[pid];
    var nav = LS.get('nav_' + jobId, null) || c.list.map(function (x) { return x.id; });
    var idx = nav.indexOf(pid);
    var orig = { pcs: p.pcs || '', pack: p.pack || '', ctn: p.ctn || '', reason: p.reason || '', qty: p.qty || '', mfg: p.mfg || '', shelf: p.shelf || '', exp: p.exp || '',
      specBad: p.specBad === 'Y', specActual: p.specActual || '', remark: p.remark || '' };
    var scanTimes = {};
    var moreOpen = LS.get('moreOpen', false) || !!(orig.reason || orig.mfg || orig.shelf || orig.exp);
    var unit = p.unit || '件';
    setBar('条码采集', true);
    var im = prefs.pda ? 'none' : 'text';
    app.innerHTML =
      '<div class="pos"><span>' + (idx >= 0 ? (idx + 1) + ' / ' + nav.length : '#' + p.seq) + ' · ' + esc(p.po) + '</span><span id="pst"></span></div>' +
      '<div class="card"><div class="pname">' + esc(p.name) + '</div>' +
      (p.sysName && p.sysName !== p.name ? '<div class="hint">系统商品：' + esc(p.sysName) + '</div>' : '') +
      '<div class="specs"><div><span>供应商规格</span><b>' + esc(p.spec || '—') + '</b></div><div><span>系统规格</span><b>' + esc(p.sysSpec || '—') + '</b></div></div>' +
      '<div class="expq"><div><span>应收数量</span><b>' + esc(p.expQty || '—') + '</b> ' + esc(unit) + '</div>' +
      '<div><span>实收数量</span><b id="pickGot">—</b> ' + esc(unit) + ' <span class="pdiff" id="pickDiff"></span></div>' +
      (p.expText && p.expQty && p.expText !== p.expQty + ' ' + unit ? '<small>供应商原文：' + esc(p.expText) + '</small>' : '') + '</div>' +
      (p.op ? '<div class="hint" style="margin-top:4px">上次：' + esc(p.op) + ' ' + esc(p.time) + '</div>' : '') + '</div>' +
      BC.map(function (b, i) {
        return '<div class="bc" id="w_' + b[0] + '"><label><span>' + (i + 1) + '. ' + b[2] + ' <small id="t_' + b[0] + '">' + b[1] + '</small></span>' +
          '<span class="tools"><button class="tbtn" data-clr="' + b[0] + '">✕ 清除</button></span></label>' +
          '<div class="bcrow"><input id="f_' + b[0] + '" data-k="' + b[0] + '" inputmode="' + im + '" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" value="' + esc(orig[b[0]]) + '" placeholder="扫描，或点这里手输">' +
          '<button class="btn cam" data-cam="' + b[0] + '">📷 扫描</button></div></div>';
      }).join('') +
      '<div class="bc" id="w_qty"><label><span>4. 实收数量 <small>按供应商单位（' + esc(unit) + '）清点' + (p.expQty ? ' · 应收 ' + esc(p.expQty) : '') + '</small></span></label>' +
      '<div class="bcrow qtyrow"><button class="btn clr" data-step="-1" aria-label="减1">−</button>' +
      '<input id="f_qty" inputmode="decimal" maxlength="11" enterkeyhint="done" autocomplete="off" value="' + esc(orig.qty) + '" placeholder="数量">' +
      '<span class="unit">' + esc(unit) + '</span><button class="btn clr" data-step="1" aria-label="加1">+</button></div></div>' +
      '<div class="bc" id="w_spec"><label class="chk"><input type="checkbox" id="f_specBad"' + (orig.specBad ? ' checked' : '') + '><span>5. 规格不符</span><small>（与上面规格不一致时勾选）</small></label>' +
      '<div id="specBox"' + (orig.specBad ? '' : ' hidden') + '><input id="f_specActual" class="search" maxlength="60" autocomplete="off" placeholder="实际规格（选填），如 1箱=24包" value="' + esc(orig.specActual) + '"></div></div>' +
      '<div class="bc" id="w_remark"><label><span>6. 备注（选填）</span></label><textarea id="f_remark" class="remark" rows="2" maxlength="200" placeholder="例：外箱破损2箱 / 少1件 / 条码模糊">' + esc(orig.remark) + '</textarea></div>' +
      '<details class="more"' + (moreOpen ? ' open' : '') + '><summary>更多资料（选填）：无条码原因 / 日期 / 保质期</summary><div class="grid2">' +
      '<div class="full"><label>无条码原因</label><select id="f_reason"><option value=""></option>' + REASONS.map(function (r) { return '<option' + (orig.reason === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') +
      (orig.reason && REASONS.indexOf(orig.reason) < 0 ? '<option selected>' + esc(orig.reason) + '</option>' : '') + '</select></div>' +
      '<div class="full hint">生产日期 / 保质期 / 有效期：填任意 2 个，第 3 个自动算出</div>' +
      '<div class="full"><label>保质期（月）<small class="autotag" id="a_shelf" hidden>自动</small></label><input id="f_shelf" inputmode="numeric" maxlength="3" value="' + esc(orig.shelf) + '"></div>' +
      '<div><label>生产日期（日/月/年）<small class="autotag" id="a_mfg" hidden>自动</small></label><input id="f_mfg" class="dt" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="例 22092026" value="' + esc(isoToDmy(orig.mfg)) + '"></div>' +
      '<div><label>有效期（日/月/年）<small class="autotag" id="a_exp" hidden>自动</small></label><input id="f_exp" class="dt" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="例 21032028" value="' + esc(isoToDmy(orig.exp)) + '"></div>' +
      '</div></details><div id="dock" class="dock"></div>';

    var F = {}; ['pcs', 'pack', 'ctn', 'reason', 'qty', 'shelf', 'mfg', 'exp', 'specBad', 'specActual', 'remark'].forEach(function (k) { F[k] = $('#f_' + k); });
    F.specBad.addEventListener('change', function () { $('#specBox').hidden = !F.specBad.checked; if (F.specBad.checked) F.specActual.focus(); });
    $('details.more').addEventListener('toggle', function (e) { LS.set('moreOpen', e.target.open); });
    function values() {
      var o = {}; Object.keys(F).forEach(function (k) { o[k] = k === 'specBad' ? F[k].checked : String(F[k].value || '').replace(/[\r\n\t]/g, '').trim(); });
      if (!o.specBad) o.specActual = '';
      ['mfg', 'exp'].forEach(function (k) { var iso = dmyToIso(o[k]); if (iso !== null) o[k] = iso; });   // 日/月/年 → yyyy-mm-dd
      return o;
    }
    function dirty() { var v = values(); return Object.keys(v).some(function (k) { return k === 'specBad' ? v[k] !== !!orig[k] : v[k] !== String(orig[k] || ''); }); }
    function markHas() {
      var q = F.qty.value.trim(), c = pickCmp(p.expQty, q), g = $('#pickGot'), dd = $('#pickDiff');
      if (g) { g.textContent = q || '—'; g.className = c.cls; dd.textContent = c.diff; dd.className = 'pdiff ' + c.cls; }
      BC.concat([['qty']]).forEach(function (b) { F[b[0]].classList.toggle('has', !!F[b[0]].value.trim()); }); var s = statusOf(values()); $('#pst').innerHTML = '<span class="badge ' + ({ '已采集': 'b-done', '部分采集': 'b-part', '未采集': 'b-todo' })[s] + '">' + s + '</span>'; }
    leaveGuard = dirty;

    // —— 底部按钮：SAVE ⇄ NEXT PRODUCT / 返回清单
    var saving = false;
    function dockSave() {
      $('#dock').innerHTML = '<button class="btn ghost" id="bList" style="flex:0 0 30%">清单</button><button class="btn save" id="bSave">SAVE 保存</button>';
      $('#bSave').onclick = function () { doSave(); };
      $('#bList').onclick = function () { guardLeave(function () { location.hash = '#/job/' + encodeURIComponent(jobId); }); };
    }
    function dockSaved(pending) {
      var nextId = idx >= 0 && idx < nav.length - 1 ? nav[idx + 1] : null;
      $('#dock').innerHTML = '<div class="savedmsg' + (pending ? ' pending' : '') + '" id="smsg">' + (pending ? '✓ 已保存到手机，正在上传…' : '✓ 已保存并同步到云端') + '</div>' +
        '<button class="btn ghost" id="bList" style="flex:0 0 35%">返回清单</button>' +
        (nextId ? '<button class="btn next" id="bNext">NEXT PRODUCT ▶</button>' : '<button class="btn next" id="bNext">已是最后一个 · 返回</button>');
      $('#bList').onclick = function () { location.hash = '#/job/' + encodeURIComponent(jobId); };
      $('#bNext').onclick = function () { location.hash = nextId ? '#/p/' + encodeURIComponent(jobId) + '/' + encodeURIComponent(nextId) : '#/job/' + encodeURIComponent(jobId); };
      setTimeout(function () { var n = $('#bNext'); if (n) n.focus(); }, 30);
    }
    dockSave();

    function doSave(force) {
      var btn = $('#bSave');
      if (saving || !btn) return;        // 防止连按造成重复提交
      var cur = values();
      var badDates = [['mfg', '生产日期'], ['exp', '有效期']].filter(function (x) { return F[x[0]].value.trim() && dmyToIso(F[x[0]].value) === null; });
      if (badDates.length) {
        modal('<h3>日期看不懂</h3><p class="hint">' + badDates.map(function (x) { return x[1] + '：' + esc(F[x[0]].value); }).join('<br>') + '<br><br>请按 日/月/年 输入数字，例如 22092026 或 220926；不知道就清空。</p><div class="row"><button class="btn save" id="dGo">去修改</button></div>', function (m) {
          $('#dGo', m).onclick = function () { closeModal(); var d = $('details.more'); if (d) d.open = true; F[badDates[0][0]].focus(); };
          setTimeout(function () { var x = $('#dGo', m); if (x) x.focus(); }, 30);
        });
        return;
      }
      var errs = checkInput(cur);
      if (errs.length) {
        modal('<h3>这些资料需要修改</h3><p class="hint">' + errs.map(esc).join('<br>') + '</p><div class="row"><button class="btn save" id="eGo">去修改</button></div>', function (m) {
          $('#eGo', m).onclick = closeModal; setTimeout(function () { var x = $('#eGo', m); if (x) x.focus(); }, 30);
        });
        return;
      }
      if (force !== true && !cur.qty && cur.reason !== '货没收到不知道实际码') {
        modal('<h3>实收数量还没填</h3><p class="hint">这个商品会显示为“部分采集”。</p><div class="row"><button class="btn ghost" id="qGo">去填写</button><button class="btn save" id="qSave">仍然保存</button></div>', function (m) {
          $('#qGo', m).onclick = function () { closeModal(); F.qty.focus(); };
          $('#qSave', m).onclick = function () { closeModal(); doSave(true); };
          setTimeout(function () { var x = $('#qGo', m); if (x) x.focus(); }, 30);
        });
        return;
      }
      saving = true;
      btn.disabled = true;
      var v = values();
      var s = { saveId: uuid(), jobId: jobId, productId: pid, operator: operator, device: device,
        clientTime: new Date().toISOString(), fields: v, scanTimes: scanTimes };
      outbox = LS.get('outbox', []); outbox.push(s);
      if (!LS.set('outbox', outbox)) { saving = false; $('#bSave').disabled = false; toast('手机存储空间不足，保存失败！请联网上传后重试', 4000); return; }
      applyLocal(p, s); delete p._h; cachePut(jobId, c);
      orig = Object.assign({}, v); scanTimes = {};
      renderNet(); markHas();
      dockSaved(true);
      toast('✓ 已保存');
      flush().then(function () {
        var still = outbox.some(function (x) { return x.saveId === s.saveId; });
        var m = $('#smsg');
        if (m) {
          m.className = 'savedmsg' + (still ? ' pending' : '');
          m.textContent = still ? '✓ 已保存到手机（离线），联网后自动上传' : '✓ 已保存并同步到云端';
        }
      });
      saving = false;
    }

    // —— 输入：PDA 扫描头（键盘模拟）+ 手动输入
    function onEdit() { if (!$('#bSave') && dirty()) dockSave(); markHas(); }
    Object.keys(F).forEach(function (k) { F[k].addEventListener('input', onEdit); F[k].addEventListener('change', onEdit); });
    BC.forEach(function (b, i) {
      var inp = F[b[0]];
      // 已有内容的框：重新扫描时整个替换（不会接在旧条码后面），且不丢第一个字符
      inp.addEventListener('focus', function () { $('#w_' + b[0]).classList.add('focus'); inp._fresh = !!inp.value; if (inp._fresh) { try { inp.select(); } catch (e) { } } });
      inp.addEventListener('blur', function () { $('#w_' + b[0]).classList.remove('focus'); });
      // 有些 PDA 扫描头用“直接填充”模式：整串条码一次写入、没有回车 → 检测到整串写入后自动跳到下一项
      inp.addEventListener('input', function (e) {
        var prev = inp._len || 0, now = inp.value.length; inp._len = now;
        clearTimeout(inp._burst);
        if (now - prev >= 4) {
          inp._burst = setTimeout(function () {
            inp.value = inp.value.replace(/[\r\n\t]/g, '').trim(); onEdit();
            if (document.activeElement === inp) { if (i < BC.length - 1) F[BC[i + 1][0]].focus(); else F.qty.focus(); }
          }, 250);
        }
      });
      inp.addEventListener('focus', function () { inp._len = inp.value.length; });
      inp.addEventListener('input', function () { inp._fresh = false; scanTimes[b[0]] = new Date().toISOString(); $('#t_' + b[0]).textContent = inp.value ? '录入 ' + hhmm(scanTimes[b[0]]) : b[1]; });
      inp.addEventListener('keydown', function (e) {
        if (inp._fresh && e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { inp.value = ''; inp._fresh = false; }
        if (e.key === 'Enter' || e.keyCode === 13 || e.key === 'Tab') {
          e.preventDefault();
          inp.value = inp.value.replace(/[\r\n\t]/g, '').trim(); onEdit();
          if (i < BC.length - 1) F[BC[i + 1][0]].focus();
          else F.qty.focus();                       // 箱码扫完 → 实收数量
        }
      });
    });
    ['mfg', 'exp'].forEach(function (k) {
      F[k].addEventListener('input', function () { var v = dmyFormat(F[k].value); if (v !== F[k].value) F[k].value = v; F[k].classList.toggle('bad', !!v && v.replace(/\D/g, '').length >= 6 && dmyToIso(v) === null); });
    });
    // —— 日期联动：填任意 2 个 → 自动算第 3 个；改了来源字段会重新计算；手动改自动值后就不再覆盖
    var autoKey = null;
    function dateVal(k) {
      var v = F[k].value.trim(); if (!v) return null;
      if (k === 'shelf') return /^\d{1,3}$/.test(v) && +v > 0 && +v <= 600 ? +v : null;
      return dmyToIso(v) || null;
    }
    function paintAuto() { ['mfg', 'shelf', 'exp'].forEach(function (x) { F[x].classList.toggle('auto', x === autoKey); $('#a_' + x).hidden = x !== autoKey; }); }
    function setAuto(k, v) {
      autoKey = v === '' ? null : k;
      F[k].value = v;
      if (k !== 'shelf') F[k].classList.remove('bad');
      paintAuto();
    }
    function linkDates(changed) {
      if (changed === autoKey) { autoKey = null; paintAuto(); }    // 员工手动改了自动算出的值 → 以手动为准，不再自动
      var keys = ['mfg', 'shelf', 'exp'];
      var src = keys.filter(function (k) { return k !== autoKey && dateVal(k) !== null; });
      var target = keys.filter(function (k) { return src.indexOf(k) < 0; })[0];
      if (src.length === 2 && target && target !== changed && (target === autoKey || !F[target].value.trim())) {   // 正在输入的那一格不自动填
        var mfg = dateVal('mfg'), sh = dateVal('shelf'), exp = dateVal('exp'), out = null;
        if (target === 'exp') out = isoToDmy(addMonths(mfg, sh));
        else if (target === 'mfg') out = isoToDmy(addMonths(exp, -sh));
        else { var n = monthsBetween(mfg, exp); out = n > 0 && n <= 600 ? String(n) : null; }
        if (out) setAuto(target, out); else if (target === autoKey) setAuto(target, '');
      } else if (autoKey && src.length < 2) setAuto(autoKey, '');      // 来源不完整了 → 清掉自动值
      onEdit();
    }
    ['mfg', 'shelf', 'exp'].forEach(function (k) { F[k].addEventListener('input', function () { linkDates(k); }); });
    F.qty.addEventListener('focus', function () { $('#w_qty').classList.add('focus'); try { F.qty.select(); } catch (e) { } });
    F.qty.addEventListener('blur', function () { $('#w_qty').classList.remove('focus'); });
    F.qty.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault(); onEdit();
        if (prefs.autoNext) { var sv = $('#bSave'); if (sv) sv.focus(); else F.qty.blur(); } else F.qty.blur();
      }
    });
    app.onclick = function (e) {
      var t = e.target;
      if (t.dataset.step) { var n = Number(F.qty.value) || 0; n = Math.max(0, n + Number(t.dataset.step)); F.qty.value = String(n); onEdit(); return; }
      if (t.dataset.clr) { F[t.dataset.clr].value = ''; scanTimes[t.dataset.clr] = new Date().toISOString(); $('#t_' + t.dataset.clr).textContent = '已清除'; onEdit(); F[t.dataset.clr].focus(); }
      if (t.dataset.cam) openCamera(t.dataset.cam, function (code) {
        var k = t.dataset.cam; F[k].value = code; scanTimes[k] = new Date().toISOString();
        $('#t_' + k).textContent = '📷 扫描 ' + hhmm(scanTimes[k]); onEdit();
        var bi = BC.findIndex ? BC.findIndex(function (x) { return x[0] === k; }) : 0;
        if (prefs.pda && bi < BC.length - 1) F[BC[bi + 1][0]].focus();
      });
    };
    markHas();
    // 进入页面：PDA 模式自动聚焦第一个空的条码框（不弹键盘），扫描头可直接扫
    if (prefs.pda) {
      var first = BC.map(function (b) { return F[b[0]]; }).filter(function (x) { return !x.value; })[0] || F.pcs;
      setTimeout(function () { first.focus(); }, 50);
    }
    window.scrollTo(0, 0);
  }

  // 焦点不在输入框时，扫描头输入自动送到第一个空条码框（防止扫码丢失）
  document.addEventListener('keydown', function (e) {
    if (!/^#\/p\//.test(location.hash) || !$('#modal').hidden || camOpen) return;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      var ins = ['pcs', 'pack', 'ctn'].map(function (k) { return $('#f_' + k); }).filter(Boolean);
      var t = ins.filter(function (x) { return !x.value; })[0];
      if (!t) return;
      t.focus();
    }
  }, true);

  // =====================================================================
  // 库位转移（v1.3）：扫来源库位 → 扫箱码（自动识别 Item Code）→ 扫目的库位 → 拍照 → 提交
  // 商品条码主档下载到本机（IndexedDB），离线也能识别；提交先存本机队列（含照片），联网自动上传
  // =====================================================================
  function modTabs(active) {
    var my = myMods(), tabs = [['in', '📦 入库'], ['t', '🔁 库位转移'], ['ld', '🚚 装车点货'], ['pk', '📋 仓库拣货'], ['lm', '📍 库位']].filter(function (x) { return my.indexOf(x[0]) >= 0; });
    if (tabs.length < 2) return '';                 // 只有一个模块就不显示切换标签
    if (tabs.length > 4) { var sh = { in: '📦 入库', t: '🔁 移库', ld: '🚚 装车', pk: '📋 拣货', lm: '📍 库位' }; tabs = tabs.map(function (x) { return [x[0], sh[x[0]]]; }); }   // 5 个模块：短名字
    return '<div class="mods' + (tabs.length > 4 ? ' m4 m5' : tabs.length > 3 ? ' m4' : '') + '">' + tabs.map(function (x) { return '<button class="mod' + (active === x[0] ? ' on' : '') + '" data-mod="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
  }
  function bindModTabs() {
    Array.prototype.forEach.call(app.querySelectorAll('[data-mod]'), function (b) {
      b.onclick = function () {
        var to = b.dataset.mod === 't' ? '#/t' : b.dataset.mod === 'ld' ? '#/ld' : b.dataset.mod === 'pk' ? '#/pk' : b.dataset.mod === 'lm' ? '#/lm' : '#/';
        if (location.hash === to || (to === '#/' && !location.hash)) return;
        guardLeave(function () { leaveGuard = null; location.hash = to; });
      };
    });
  }

  // —— IndexedDB（照片太大，不能放 localStorage）
  var IDB = (function () {
    var dbp = null;
    function db() {
      if (!dbp) dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) { rej(new Error('这个浏览器不支持本机数据库')); return; }
        var r = indexedDB.open('inbound-scan', 1);
        r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); if (!d.objectStoreNames.contains('tq')) d.createObjectStore('tq', { keyPath: 'transferId' }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    function tx(store, mode, fn) {
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(store, mode), q = fn(t.objectStore(store)), out;
          if (q) q.onsuccess = function () { out = q.result; };
          t.oncomplete = function () { res(out); };
          t.onerror = function () { rej(t.error); };
          t.onabort = function () { rej(t.error || new Error('存储失败（空间不足？）')); };
        });
      });
    }
    return {
      get: function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); },
      set: function (k, v) { return tx('kv', 'readwrite', function (s) { return s.put(v, k); }); },
      all: function () { return tx('tq', 'readonly', function (s) { return s.getAll(); }); },
      put: function (r) { return tx('tq', 'readwrite', function (s) { return s.put(r); }); },
      del: function (id) { return tx('tq', 'readwrite', function (s) { return s.delete(id); }); },
      kdel: function (k) { return tx('kv', 'readwrite', function (s) { return s.delete(k); }); }
    };
  })();

  // —— 商品条码主档（本机）
  var masters = null;      // { version, byBarcode, byItem, locRe, count }
  var LOC_DEFAULT = '^\\d{2}-[A-Z]-\\d{2}$';   // 库位标签如 15-O-02（后台可改）
  function locRe() { return masters ? masters.locRe : new RegExp(LOC_DEFAULT); }
  function buildMasters(m) {
    var byB = {}, byI = {};
    (m.barcodes || []).forEach(function (x) { byB[x[0]] = x; var z = String(x[0]).replace(/^0+/, ''); if (!byB[z]) byB[z] = x; if (!byI[x[1]]) byI[x[1]] = x; });
    (m.items || []).forEach(function (x) { if (!byI[x[0]]) byI[x[0]] = [x[0], x[0], x[1]]; });     // v1.9.2 商品名称表：扫 Item Code / 搜品名
    var re; try { re = new RegExp(m.locPattern || LOC_DEFAULT); } catch (e) { re = new RegExp(LOC_DEFAULT); }
    return { version: m.version, byBarcode: byB, byItem: byI, locRe: re, count: (m.barcodes || []).length, batches: m.batches || {}, raw: m };
  }
  function loadMasters() {
    var local = masters ? Promise.resolve(masters) : IDB.get('masters').then(function (m) { if (m) masters = buildMasters(m); return masters; }, function () { return null; });
    return local.then(function () {
      return api({ action: 'masters', version: masters ? masters.version : '' }, true).then(function (d) {
        if (d.same) { if (masters && masters.raw.locPattern !== d.locPattern) { masters.raw.locPattern = d.locPattern; masters = buildMasters(masters.raw); IDB.set('masters', masters.raw).catch(function () { }); } return masters; }
        var m = { version: d.version, barcodes: d.barcodes, batches: d.batches || {}, locPattern: d.locPattern, at: new Date().toISOString() };
        masters = buildMasters(m);
        IDB.set('masters', m).catch(function () { });
        return masters;
      }, function (e) { if (masters) return masters; throw e; });
    });
  }
  // 货架标签扫出来是 04-C01 / 04C01，系统格式是 04-C-01：自动补上缺的杠
  // （只在原样不符合库位格式时才转换，办公室改了格式也不受影响）
  function normLoc(v) {
    var s = String(v || '').replace(/[\r\n\t]/g, '').trim().toUpperCase();
    if (!s || locRe().test(s)) return s;
    return s.replace(/^(\d{2})-?([A-Z])-?(\d{2})$/, '$1-$2-$3');
  }
  function normCode(v) { return String(v || '').replace(/[\r\n\t]/g, '').trim(); }
  function lookupItem(code) {
    if (!masters) return null;
    var x = masters.byBarcode[code] || masters.byBarcode[String(code).replace(/^0+/, '')];
    if (x) return { itemCode: x[1], desc: x[2], match: '箱码' };
    x = masters.byItem[code];
    if (x) return { itemCode: x[1], desc: x[2], match: 'Item Code' };
    return null;
  }
  /** v1.9.3 各库位上记着的货（手机里存一份，扫码 / 提交不用等后台）：{ at, locs: [[库位, Item Code, 品名, 批次, 状态]] } */
  var trSnap = null, trSnapTimer = null;
  function trSnapLoad(fresh) {
    var local = trSnap ? Promise.resolve(trSnap) : IDB.get('trsnap').then(function (d) { if (d && !trSnap) trSnap = d; return trSnap; }, function () { return null; });
    if (!fresh) return local;
    return local.then(function () {
      if (!cfg || !sess || navigator.onLine === false) return trSnap;
      return api({ action: 'trSnap' }, true).then(function (d) { if (d && Array.isArray(d.locs)) { trSnap = d; IDB.set('trsnap', d).catch(function () { }); } return trSnap; }, function () { return trSnap; });
    });
  }
  function trSnapAt(loc) { return trSnap ? trSnap.locs.filter(function (x) { return x[0] === loc; }) : null; }
  /** 提交后手机自己先改（后台稍后会给最新的） */
  function trSnapApply(src, dst, item, desc, base, over, seenItems) {
    if (!trSnap || !item) return;
    var L = trSnap.locs, b = base == null ? null : base;
    if (over === true) {                 // v1.9.13 只移走勾选的（seenItems = 记录 ID）；没给就全部
      var sg = {}; (seenItems || []).forEach(function (k) { sg[k] = 1; });
      L = L.filter(function (x) { return !(x[0] === dst && !(x[1] === item && (b == null || x[3] === b)) && (!seenItems || sg[x[5]])); });
    }
    var mv = src ? L.filter(function (x) { return x[0] === src && x[1] === item && (b == null || x[3] === b); })[0] : null;
    if (mv) { mv[0] = dst; mv[4] = '已核实'; }
    else if (!L.some(function (x) { return x[0] === dst && x[1] === item && (b == null || x[3] === b); })) L.push([dst, item, desc || '', b || '', '已核实', '']);
    else L.forEach(function (x) { if (x[0] === dst && x[1] === item && (b == null || x[3] === b)) x[4] = '已核实'; });
    trSnap.locs = L; IDB.set('trsnap', trSnap).catch(function () { });
  }
  /** v1.8.2 移库选批次：这个商品有库存的批次。先用本机资料（离线也能选），联网时再读最新的（库位是最新的）。
   *  cb(list, fresh, item, desc)：list = [{ base, mfg, exp, qty, uom, locs: [] }]，到期早的在前 */
  function trBatches(code, item, cb) {
    var loc = item && masters && masters.batches && masters.batches[item];
    var local = (loc || []).map(function (x) { return { base: x[0], mfg: x[1], exp: x[2], qty: x[3], uom: x[4], locs: x[5] ? String(x[5]).split(' ') : [] }; });
    if (loc) cb(local, false, item);
    if (!cfg || !sess || navigator.onLine === false) { if (!loc) cb(local, false, item); return; }
    api({ action: 'trBatches', code: code, item: item || '' }, true).then(function (d) {
      if (d && d.item) cb(d.batches || [], true, d.match === '库位主档' ? d.item : '', d.desc); else if (!loc) cb(local, true, item);
    }, function () { if (!loc) cb(local, false, item); });
  }

  // —— 上传队列
  var tqCount = 0, tqFlushing = null, tqRejected = [], tqAgain = false;
  function refreshTq() {
    return IDB.all().then(function (list) {
      list = list || [];
      tqCount = list.filter(function (r) { return !r.rejected; }).length;
      tqRejected = list.filter(function (r) { return r.rejected; });
      renderNet();
      return list;
    }, function () { return []; });
  }
  function flushTransfers() {
    if (tqFlushing) { tqAgain = true; return tqFlushing; }   // 正在上传时又提交了新的：这轮结束后马上再传一轮
    if (!cfg || !sess) return Promise.resolve();
    tqFlushing = refreshTq().then(function (list) {
      var mine = list.filter(function (r) { return !r.rejected && r.operator === operator; })
        .sort(function (a, b) { return String(a.clientTime).localeCompare(String(b.clientTime)); });
      var done = 0;
      function next(i) {
        if (i >= mine.length) return Promise.resolve();
        var r = mine[i];
        var body = { transferId: r.transferId, source: r.source, dest: r.dest, barcode: r.barcode, qty: r.qty || '', photo: r.photo, clientTime: r.clientTime };
        if (r.batch != null) body.batch = r.batch;
        if (r.learnItem) body.learnItem = r.learnItem; else if (r.newName) body.newName = r.newName;     // v1.9.2 当场认出的箱码
        if (r.over === true || r.over === false) { body.over = r.over; body.seen = r.seen || []; if (r.kept) body.kept = r.kept; }
        return api({ action: 'transfer', transfer: body }, true).then(function (d) {
          if (d.status === 'saved' || d.status === 'duplicate') { done++; return IDB.del(r.transferId); }
          r.rejected = d.message || '被服务器退回'; toast('有一笔库位转移被退回：' + r.rejected, 4000);
          return IDB.put(r);
        }).then(function () { return next(i + 1); });
      }
      return next(0).then(function () { return done; });
    }).then(function (n) { tqFlushing = null; refreshTq().then(function () { if (currentRedraw) currentRedraw(); if (n && refreshRecentNow && location.hash === '#/t') refreshRecentNow(); }); if (tqAgain) { tqAgain = false; flushTransfers(); } return n; },
      function (e) { tqFlushing = null; tqAgain = false; lastSyncError = e.message; refreshTq(); });
    return tqFlushing;
  }
  refreshTq();

  // —— 照片压缩：长边 1600 像素、JPEG，一般 200–400 KB
  // （v1.3.8）高像素手机照片用 <img> 解码失败时，改用 createImageBitmap；生成的图片太小视为失败
  function compressPhoto(file) {
    function toJpeg(src, w, h) {
      var k = Math.min(1, 1600 / Math.max(w, h));
      var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      var g = c.getContext('2d'); if (!g) throw new Error('照片处理失败，请重拍');
      g.drawImage(src, 0, 0, c.width, c.height);
      var q = 0.72, d = c.toDataURL('image/jpeg', q);
      while (d.length > 700000 && q > 0.35) { q -= 0.12; d = c.toDataURL('image/jpeg', q); }
      if (!/^data:image\/jpeg;base64,/.test(d) || d.length < 2000) throw new Error('照片处理失败（手机内存不足？），请重拍或用“从相册选”');
      return d;
    }
    function viaBitmap() {
      if (!window.createImageBitmap) return Promise.reject(new Error('照片读取失败，请重拍或用“从相册选”'));
      return createImageBitmap(file).then(function (b) { try { return toJpeg(b, b.width, b.height); } finally { try { b.close(); } catch (e) { } } },
        function () { throw new Error('照片读取失败，请重拍或用“从相册选”'); });
    }
    if (!file || (file.type && !/^image\//.test(file.type))) return Promise.reject(new Error('选的不是照片，请重拍'));
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        try { var d = toJpeg(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); res(d); }
        catch (e) { URL.revokeObjectURL(url); viaBitmap().then(res, rej); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); viaBitmap().then(res, rej); };
      img.src = url;
    });
  }
  function errBeep() {
    try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) { }
    try {
      var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      var ctx = beep.ctx || (beep.ctx = new A()); var o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 320; g.gain.value = 0.2; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.35);
    } catch (e) { }
  }

  // —— 页面
  var tState = null;       // 当前这一笔（离开页面后保留，回来继续）
  function viewTransfer() {
    setBar('库位转移', false);
    // 草稿存手机（v1.3.8）：有些手机打开相机后内存不足会把网页重新载入，回来后已扫的资料不丢
    var st = tState || (tState = Object.assign({ src: '', srcSkip: false, bc: '', item: '', desc: '', match: '', dst: '', qty: '', photo: '', edit: '', bst: '', bopts: [], batch: '', bexp: '', bok: false, bnew: false, learn: false, newName: '' }, LS.get('tdraft', {})));
    var pend = LS.get('tphotoPending', 0);
    LS.del('tphotoPending');
    var msg = (pend && Date.now() - pend < 15 * 60e3 && !st.photo) ? { cls: 'bad', text: '刚才拍照后网页被手机重新打开了（手机内存不足时会这样）。已扫的资料都还在，请再拍一次；如果还是这样，请用“🖼 从相册选”。' } : { cls: '', text: '' }, recent = LS.get('trecent', []).filter(function (r) { return r.id; }), busy = false;
    var TST = { '待上传': 't0', '待处理': 't1', '有问题': 't2', '已完成': 't3' };
    // v1.4.7 我的移库记录：全部记录（每次 20 笔，“显示更多”继续），每笔显示完整资料；可按状态筛选。
    // 以后台为准：办公室删除的在这里也消失，状态同步；还没上传的留在最上面
    var RL = { status: '', shown: 20, total: null, counts: null, loading: false, err: '' };
    function refreshRecent(more) {
      if (!cfg || !sess) return Promise.resolve();
      if (more === true) RL.shown += 20;
      RL.loading = true; paintRecent();
      return Promise.all([api({ action: 'transfers', offset: 0, limit: RL.shown, status: RL.status }, true), IDB.all().catch(function () { return []; })]).then(function (x) {
        var server = (x[0] && x[0].list) || [], pend = {};
        RL.total = x[0].total != null ? x[0].total : server.length; RL.counts = x[0].counts || null; RL.err = ''; RL.loading = false;
        (x[1] || []).forEach(function (q) { if (!q.rejected) pend[q.transferId] = 1; });
        var local = recent.filter(function (r) { return pend[r.id]; });
        recent = (RL.status ? [] : local).concat(server.filter(function (r) { return !pend[r.id]; }));
        if (!RL.status) LS.set('trecent', recent.slice(0, 20));
        paintRecent();
      }, function (e) { RL.loading = false; RL.err = e.network ? '离线：显示的是上次的记录' : e.message; paintRecent(); });
    }
    function paintRecent() {
      var box = document.getElementById('tRecent');                 // 只更新列表，不重画整页（不打断正在扫描的输入）
      if (box && location.hash === '#/t') box.innerHTML = recentHtml();
    }
    refreshRecentNow = refreshRecent;
    // v1.8.2 商品有 2 个以上批次时多一步“选批次”（整批搬，选了就直接更新系统库位）
    var STEPS;
    function needBatch() { return st.bst === 'need'; }
    function mkSteps() {
      var a = [['src', '来源库位', '扫描原来的库位条码'], ['bc', '商品箱码', '扫描箱子上的条码']];
      if (needBatch()) a.push(['batch', '选批次', '看箱子上的到期日，在下面点对应的批次']);
      a.push(['dst', '目的库位', '扫描新的库位条码'], ['photo', '拍照（选填）', '想留证据可以拍一张，不拍也能提交']);
      STEPS = a.map(function (x, i) { return [x[0], (i + 1) + '. ' + x[1], x[2]]; });
      return STEPS;
    }
    mkSteps();
    // 提交前检查（v1.3.9）：必须有 商品箱码、目的库位、照片；来源库位选填
    var NEED = { bc: ['商品箱码', '还没扫', '扫描箱子上的条码'], batch: ['批次', '还没选', '看箱子上的到期日，选对应的批次'], dst: ['目的库位', '还没扫', '扫描新库位（放货的货架）上的库位条码'], photo: ['拍照确认', '还没拍', '拍一张货物放在新库位的照片'] };
    var photoBusy = false, showNeed = false;
    function has(k) { return k === 'batch' ? st.bok : k === 'bc' ? !!st.bc && !!(st.item || st.newName) : !!st[k]; }
    function unknownBc() { return !!st.bc && !st.item && !st.newName && st.bst !== 'load'; }
    function missing() { return (needBatch() ? ['bc', 'batch', 'dst'] : ['bc', 'dst']).filter(function (k) { return !has(k); }); }     // v1.9.3 照片选填
    /** 扫了箱码 → 读这个商品的批次：1 个自动选；2 个以上要选；没有批次（新商品）就不用选 */
    function loadBatches(keepBatch) {
      var code = st.bc, item = st.item, kb = keepBatch ? { b: st.batch, e: st.bexp } : null;
      st.bst = st.bc ? (item ? 'load' : 'none') : ''; st.bopts = []; st.batch = ''; st.bexp = ''; st.bok = false; st.bnew = false;      // v1.9.3 手机里不认识：马上问，不等后台
      if (!code) return;
      trBatches(code, item, function (list, fresh, it, desc) {
        if (st.bc !== code) return;                                 // 已经换了别的箱码
        if (it && !st.item && !st.newName) {                         // 后台认得（别的手机刚记住的）：补上，关掉“不认识”的弹窗
          st.item = it; st.desc = desc || st.desc; st.match = '库位主档'; st.learn = false;
          if ($('.tunkm')) { closeModal(); toast('后台认出：' + it + ' ' + (desc || ''), 2500); }
        }
        if (kb && !st.bok && list.some(function (b) { return b.base === kb.b; })) { st.batch = kb.b; st.bexp = kb.e; st.bok = true; }
        var keep = (st.bst === 'need' || kb) && st.bok && list.some(function (b) { return b.base === st.batch; });
        st.bopts = list;
        if (list.length === 1) { st.bst = 'one'; st.batch = list[0].base; st.bexp = list[0].exp; st.bok = true; }
        else if (list.length > 1) { st.bst = 'need'; if (!keep) { st.batch = ''; st.bexp = ''; st.bok = false; } }
        else st.bst = fresh || !cfg ? 'none' : 'load';
        if (!fresh && st.bst === 'load') st.bst = 'none';
        if (st.bnew) { st.batch = ''; st.bexp = ''; st.bok = true; }        // v1.9.16 仓管已经选了“新批次”：后台批次读回来也不改
        mkSteps(); if (location.hash === '#/t') { draw(); if (unknownBc() && $('#modal').hidden) askUnknown(); }      // v1.9.2 不认识：当场选商品
      });
    }
    /** v1.9.3 扫了来源库位：手机里马上列出这个货架上记着的货，点一下就是要搬的这一托（不用再扫箱码） */
    function shelfHtml() {
      if (step() !== 'bc' || !st.src || st.bc) return '';
      var rows = trSnapAt(st.src);
      if (!rows) return '<div class="tshelf"><p class="hint">正在读取库位资料…（也可以直接扫箱码）</p></div>';
      if (!rows.length) return '<div class="tshelf"><p class="hint">系统里 ' + esc(st.src) + ' 没有记录：请扫箱码</p></div>';
      return '<div class="tshelf"><p class="hint">系统里 <b>' + esc(st.src) + '</b> 放的货：点要搬的那托，或直接扫箱码</p>' + rows.map(function (x, i) {
        var bb = masters && masters.batches && (masters.batches[x[1]] || []).filter(function (b) { return b[0] === x[3]; })[0];
        return '<button class="tshelfb" data-sh="' + i + '"><b data-nt>' + esc(x[2] || x[1]) + '</b><span data-nt>' + esc(x[1]) + (x[3] ? ' · 批次 ' + esc(x[3]) : '') + (bb && bb[2] ? ' · 到期 <b>' + esc(bb[2]) + '</b>' : '') + (x[4] !== '已核实' ? ' · 待核实' : '') + '</span></button>';
      }).join('') + '</div>';
    }
    function pickShelf(i) {
      var x = (trSnapAt(st.src) || [])[i]; if (!x) return;
      st.bc = x[1]; st.item = x[1]; st.desc = x[2]; st.match = '库位记录'; st.learn = false; st.newName = ''; st.edit = '';
      st.batch = x[3]; st.bexp = ''; st.bok = true; st.bnew = false;
      beep(); msg = { cls: 'good', text: '✓ ' + x[1] + ' ' + (x[2] || '') + (x[3] ? '（批次 ' + x[3] + '）' : '') };
      loadBatches(true); st.batch = x[3]; st.bok = true;
      var bb = masters && masters.batches && (masters.batches[x[1]] || []).filter(function (b) { return b[0] === x[3]; })[0]; if (bb) st.bexp = bb[2];
      mkSteps(); draw();
    }
    function batchHtml() {
      return '<div class="tbat">' + st.bopts.map(function (b, i) {
        return '<button class="tbatb' + (st.bok && st.batch === b.base ? ' on' : '') + '" data-bi="' + i + '"><span class="tbx">到期 <b>' + esc(b.exp || '—') + '</b></span>' +
          '<span class="tbm">生产 ' + esc(b.mfg || '—') + ' · 库存 <b>' + esc(b.qty) + '</b> ' + esc(b.uom || '') + '</span>' +
          '<span class="tbm">批次 ' + esc(b.base || '（不分批次）') + ' · 系统库位 <b>' + esc((b.locs || []).join(' ') || '没有') + '</b>' + (st.src && (b.locs || []).indexOf(st.src) >= 0 ? ' <i class="tbsrc">= 来源库位</i>' : '') + '</span></button>';
      }).join('') + '<button class="tbatb tbnew' + (st.bok && st.bnew ? ' on' : '') + '" data-bnew="1"><span class="tbx">🆕 <b>新批次</b>（系统里还没有）</span><span class="tbm">箱子上的到期日上面都没有：新到的货、入库单还没上传。记成「不分批次」，旧批次的库位不动</span></button></div>';
    }
    function goFix(k) {
      closeModal();
      if (k === 'unk' || (k === 'bc' && unknownBc())) return askUnknown();
      st.edit = k; showNeed = true;
      msg = { cls: 'bad', text: '👉 请' + (k === 'photo' ? '拍照（或从相册选）' : '扫描' + NEED[k][0]) };
      draw();
    }
    function showMissing(miss) {
      errBeep();
      var li = function (cls, mk, title, sub, go) {
        return '<li class="' + cls + '"' + (go ? ' data-go="' + go + '"' : '') + '><span class="mk">' + mk + '</span><span class="t"><b>' + title + '</b><span>' + sub + '</span></span>' + (go ? '<span class="go">去补 ›</span>' : '') + '</li>';
      };
      var items = li(st.src ? 'ok' : 'opt', st.src ? '✓' : '–', '来源库位', st.src ? esc(st.src) : '不填（选填，可以不扫）') +
        li(st.qty ? 'ok' : 'opt', st.qty ? '✓' : '–', '数量', st.qty ? esc(st.qty) : '不填（选填）') +
        li(st.photo ? 'ok' : 'opt', st.photo ? '✓' : '–', '拍照', st.photo ? '已拍好' : '不拍（选填）') +
        (needBatch() ? ['bc', 'batch', 'dst'] : ['bc', 'dst']).map(function (k) {
          if (has(k)) return li('ok', '✓', NEED[k][0], k === 'photo' ? '已拍好' : k === 'batch' ? '到期 ' + esc(st.bexp || '—') + ' · ' + esc(st.batch || '不分批次') : esc(k === 'bc' ? (st.item ? st.item + ' · ' + st.bc : st.bc) : st[k]));
          if (k === 'bc' && st.bc) return li('bad', '✗', '商品箱码 · 系统不认识', '箱码 ' + esc(st.bc) + '：先选是哪个商品', 'unk');
          return li('bad', '✗', NEED[k][0] + ' · ' + NEED[k][1], NEED[k][2], k);
        }).join('');
      modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>还不能提交</h3>' +
        '<div class="hint">还差 <b>' + miss.length + '</b> 项，补齐后再点“提交”</div></div></div>' +
        '<ul class="tmiss-list">' + items + '</ul>' +
        '<div class="row"><button class="btn ghost" id="mxOk">知道了</button><button class="btn save" id="mxGo">' + (miss[0] === 'bc' && st.bc ? '选是哪个商品' : '去补：' + NEED[miss[0]][0]) + '</button></div></div>', function (m) {
          $('#mxOk', m).onclick = function () { closeModal(); showNeed = true; draw(); };
          $('#mxGo', m).onclick = function () { goFix(miss[0] === 'bc' && st.bc ? 'unk' : miss[0]); };
          Array.prototype.forEach.call(m.querySelectorAll('[data-go]'), function (x) { x.onclick = function () { goFix(x.getAttribute('data-go')); }; });
        });
    }
    function infoBox(title, text) {
      errBeep();
      modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>' + esc(title) + '</h3></div></div>' +
        '<p style="font-size:16px;margin:10px 0">' + esc(text) + '</p><div class="row"><button class="btn save" id="mxOk">知道了</button></div></div>', function (m) { $('#mxOk', m).onclick = closeModal; });
    }
    // 来源库位可以不填（v1.3.7）：一开始停在来源库位；点“跳过”或直接扫/点别的栏后就不再要求
    function srcOptional() { return st.srcSkip || st.bc || st.dst || st.photo; }
    function step() {
      if (st.edit) return st.edit;
      if (!st.src && !srcOptional()) return 'src';
      mkSteps();
      for (var i = 1; i < STEPS.length; i++) if (!has(STEPS[i][0]) && !(STEPS[i][0] === 'bc' && st.bc)) return STEPS[i][0];   // v1.9.2 箱码扫了但不认识：先往下扫，提交前再选商品
      return 'submit';
    }
    function recentHtml() {
      var c = RL.counts || {};
      var chips = [['', '全部', c.all], ['待处理', '待处理', c['待处理']], ['有问题', '有问题', c['有问题']], ['已完成', '已完成', c['已完成']]].map(function (f) {
        return '<button class="tchip' + (RL.status === f[0] ? ' on' : '') + '" data-rf="' + f[0] + '">' + f[1] + (f[2] != null ? ' ' + f[2] : '') + '</button>';
      }).join('');
      var rows = recent.map(function (r) {
        var can = r.status !== '已完成', bc = r.bc || (r.item && !r.desc ? r.item : '');
        return '<div class="trec' + (can ? ' tedit' : '') + '" data-rid="' + esc(r.id || '') + '">' +
          '<div class="trec-h"><span class="tst ' + (TST[r.status] || '') + '">' + esc(r.status || '') + '</span><span class="hint">' + esc(r.date || r.t || '') + '</span>' +
            (can ? '<span class="tedit-l">✎ 修改</span>' : '<span class="hint">🔒 已处理</span>') + '</div>' +
          '<div class="trec-loc"><span>' + esc(r.src || '—') + '</span><i>→</i><span>' + esc(r.dst || '') + '</span>' + (r.qty !== '' && r.qty != null ? '<b class="trec-q">数量 ' + esc(r.qty) + '</b>' : '') + '</div>' +
          '<div class="trec-it">' + (r.item && r.item !== bc ? '<b>' + esc(r.item) + '</b> ' + esc(r.desc || '') + ' · ' : '') + '箱码 ' + esc(bc || '—') + (r.match === '未识别' ? ' <span class="hint">（主档没有）</span>' : '') + '</div>' +
          (r.batch ? '<div class="trec-b">批次 <b>' + esc(r.batch) + '</b>' + (r.bexp ? ' · 到期 <b>' + esc(r.bexp) + '</b>' : '') + '</div>' : '') +
          (r.locResult ? '<div class="trec-l' + (/^已更新/.test(r.locResult) ? '' : ' bad') + '">' + (/^已更新/.test(r.locResult) ? '✓ 系统库位' : '⚠ ') + esc(r.locResult.replace(/^已更新：/, '已更新 ')) + '</div>' : '') +
          ((r.note || r.by) ? '<div class="trec-n' + (r.status === '有问题' ? ' bad' : '') + '">' + (r.status === '有问题' ? '办公室：' : '备注：') + esc(r.note || '') + (r.by ? ' <span class="hint">（' + esc(r.by) + ' ' + esc(r.at || '') + '）</span>' : '') + '</div>' : '') +
          (r.edits ? '<div class="hint">已修改 ' + r.edits + ' 次' + (r.editedAt ? '（最后 ' + esc(r.editedAt) + '）' : '') + '</div>' : '') + '</div>';
      }).join('');
      var more = RL.total != null && RL.total > recent.filter(function (r) { return r.status !== '待上传'; }).length;
      return '<div class="card"><div class="trec-top"><b>我的移库记录</b>' + (RL.total != null ? '<span class="hint">共 ' + (RL.status ? RL.total : (c.all != null ? c.all : RL.total)) + ' 笔</span>' : '') + '</div>' +
        '<div class="tchips">' + chips + '</div>' + (RL.err ? '<p class="hint err">' + esc(RL.err) + '</p>' : '') +
        (rows || '<p class="hint">' + (RL.loading ? '读取中…' : '没有记录') + '</p>') +
        (more ? '<button class="btn ghost tmore" data-rmore="1"' + (RL.loading ? ' disabled' : '') + '>' + (RL.loading ? '读取中…' : '显示更多（还有 ' + (RL.total - recent.filter(function (r) { return r.status !== '待上传'; }).length) + ' 笔）') + '</button>' : '') +
        (rows ? '<p class="hint" style="margin:6px 0 0">点一笔可以修改（办公室已完成的不能改；记录不能删除）</p>' : '') + '</div>';
    }
    // 这一笔的资料在切换页面时会保留（tState），所以不需要“未保存离开”提示
    function saveDraft() { LS.set('tdraft', { src: st.src, srcSkip: !!st.srcSkip, bc: st.bc, item: st.item, desc: st.desc, match: st.match, dst: st.dst, qty: st.qty || '', bst: st.bst === 'load' ? '' : st.bst, bopts: st.bopts || [], batch: st.batch, bexp: st.bexp, bok: !!st.bok, bnew: !!st.bnew, learn: !!st.learn, newName: st.newName || '' }); }
    function draw() {
      saveDraft();
      var keepIn = $('#tIn'), keepVal = keepIn ? keepIn.value : '', keepStep = keepIn ? keepIn.getAttribute('data-step') : '';
      var qOld = $('#tQty'), qFocus = !!qOld && document.activeElement === qOld, qVal = qOld ? qOld.value : null;   // 重画时数量框正在输入：保留内容和光标
      var cur = step(), im = prefs.pda ? 'none' : 'text';
      var rows = STEPS.map(function (s) {
        var k = s[0], v = k === 'batch' ? st.bok : st[k], val;
        if (k === 'batch') val = st.bok ? (st.bnew ? '<b class="tv">🆕 新批次</b><div class="hint">系统里还没有，记成不分批次</div>' : '<b class="tv">到期 ' + esc(st.bexp || '—') + '</b><div class="hint">批次 ' + esc(st.batch || '不分批次') + '</div>') : '';
        else if (k === 'bc') val = !v ? '' : st.item ? '<b class="tv">' + esc(st.item) + '</b><div class="td">' + esc(st.desc || '') + '</div><div class="hint">箱码 ' + esc(v) + (st.match === 'Item Code' ? '（按 Item Code 识别）' : '') + (st.learn ? '（刚认出，提交时系统记住这个箱码）' : '') + '</div>'
          : st.newName ? '<b class="tv">新商品</b><div class="td">' + esc(st.newName) + '</div><div class="hint">箱码 ' + esc(v) + '（提交时系统建新商品并记住箱码）</div>'
          : '<b class="tv loc">' + esc(v) + '</b>' + (st.bst === 'load' ? '<div class="hint">查找商品…</div>' : '<div class="tunk">⚠ 系统不认识这个箱码</div>');
        else if (k === 'photo') val = v ? '<img class="tphoto" src="' + v + '" alt="照片">' : '';
        else if (k === 'src' && !v && srcOptional() && cur !== 'src') val = '<span class="tp" style="color:var(--mute)">不填（选填）</span>';
        else val = v ? '<b class="tv loc">' + esc(v) + '</b>' : '';
        if (k === 'bc' && v) val += st.bst === 'load' ? '<div class="hint">读取批次…</div>' : st.bst === 'one' ? (st.bnew ? '<div class="tb1 tb1new">🆕 新批次（系统里还没有，记成不分批次） <span class="tbnl" data-bold1="1">改回 到期 ' + esc((st.bopts[0] || {}).exp || '—') + '</span></div>'
          : '<div class="tb1">只有 1 个批次：到期 <b>' + esc(st.bexp || '—') + '</b>' + (st.batch ? ' · ' + esc(st.batch) : '') + '（自动选好）</div><div class="tbnl" data-bnew1="1">到期日不一样？点这里选「新批次」</div>') : '';     // v1.9.16
        return '<button class="tstep' + (cur === k ? ' cur' : '') + (showNeed && k !== 'src' && k !== 'photo' && !v ? ' need' : '') + (v ? ' ok' : '') + '" data-edit="' + k + '"><span class="tl">' + s[1] + '</span>' +
          (val || '<span class="tp">' + (cur === k ? '👉 ' + s[2] : '—') + '</span>') + '</button>' +
          (k === 'batch' && cur === 'batch' ? '<div class="tbatc">' + batchHtml() + (st.edit ? '<div class="row tsub"><button class="tbtn" id="tCancelEdit">取消修改</button></div>' : '') + '</div>' : '');
      }).join('');
      var scanning = cur === 'src' || cur === 'bc' || cur === 'dst';
      var batchPick = '';
      app.innerHTML = modTabs('t') +
        '<div class="topline"><span>员工：' + esc(operator) + '</span><span class="hint">' + (masters && masters.count ? '商品主档 ' + masters.count + ' 个条码' : '') + '</span></div>' +
        '<div class="card tcard">' + rows +
        '<div class="tqty"><label for="tQty"><span class="tl">数量 <small>（选填：新货入库核对用；托盘转移不用填）</small></span></label>' +
        '<input id="tQty" class="tqtyin" inputmode="decimal" autocomplete="off" maxlength="64" enterkeyhint="done" placeholder="不填" value="' + esc(st.qty || '') + '"></div></div>' +
        (msg.text ? '<div class="tmsg ' + msg.cls + '">' + esc(msg.text) + '</div>' : '') + batchPick +
        shelfHtml() +
        (unknownBc() ? '<div class="tunkc"><b>箱码 ' + esc(st.bc) + ' 系统不认识</b><span>选出是哪个商品才能提交（系统会记住这个箱码）</span><button class="btn save" id="tUnk">选是哪个商品</button></div>' : '') +
        (scanning ? '<div class="bcrow tscan"><input id="tIn" data-step="' + cur + '" inputmode="' + im + '" maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="' +
          esc(STEPS.filter(function (s) { return s[0] === cur; })[0][2]) + '，或点这里手输"><button class="btn cam" id="tCam">📷 扫描</button></div>' +
          ((cur === 'src' && !st.src) || st.edit ? '<div class="row tsub">' + (cur === 'src' && !st.src ? '<button class="tbtn" id="tSkipSrc">跳过来源库位 →</button>' : '') +
          (st.edit ? '<button class="tbtn" id="tCancelEdit">取消修改</button>' : '') + '</div>' : '') : '') +
        // 拍照按钮（v1.3.8）：用真正的按钮 + 不用 display:none 的文件框（部分安卓浏览器点 label 打不开隐藏的文件框）；另给“从相册选”备用
        (cur === 'photo' ? '<div class="tphotos"><button class="btn save tphotobtn" id="tPhotoBtn">📸 拍照</button><button class="btn ghost tphotoalt" id="tPhotoAltBtn">🖼 从相册选</button></div>' +
          '<input id="tPhoto" class="vh" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true">' +
          '<input id="tPhotoAlt" class="vh" type="file" accept="image/*" tabindex="-1" aria-hidden="true">' : '') +
        (tqCount ? '<p class="hint">待上传 ' + tqCount + ' 笔（联网后自动上传）</p>' : '') +
        (tqRejected.length ? '<div class="card"><b class="err">被退回 ' + tqRejected.length + ' 笔（请检查后删除）</b>' + tqRejected.map(function (r) {
          return '<div class="trow"><div>' + esc(r.source || '—') + ' → ' + esc(r.dest) + ' · ' + esc(r.itemCode || r.barcode) + '<div class="err hint">' + esc(r.rejected) + '</div></div><button class="tbtn" data-tdel="' + esc(r.transferId) + '">删除</button></div>';
        }).join('') + '</div>' : '') +
        '<div id="tRecent">' + recentHtml() + '</div>' +
        '<div id="dock" class="dock"><button class="btn ghost" id="tReset" style="flex:0 0 32%">重新开始</button><button class="btn save' + (missing().length ? ' notready' : '') + '" id="tSubmit"' + (busy ? ' disabled' : '') + '>' + (missing().length ? '提交 <small>（还差 ' + missing().length + ' 项）</small>' : '提交') + '</button></div>';
      bindModTabs();
      var qNew = $('#tQty');
      if (qNew && qFocus && qVal !== null) qNew.value = qVal;
      bindQty(qNew, function (v) { st.qty = v; saveDraft(); }, function () { var x = $('#tIn'); if (x) x.focus(); });
      if (qNew && qFocus) { qNew.focus(); try { qNew.setSelectionRange(qNew.value.length, qNew.value.length); } catch (e) { } }
      var inp = $('#tIn');
      if (inp && keepVal && keepStep === cur) inp.value = keepVal;   // 重画时保留正在输入/扫描的内容
      if (inp) {
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.keyCode === 13 || e.key === 'Tab') { e.preventDefault(); accept(inp.value); }
        });
        var prev = 0, t;
        inp.addEventListener('input', function () {      // PDA“直接填充”模式（没有回车）
          var now = inp.value.length; clearTimeout(t);
          if (now - prev >= 4) t = setTimeout(function () { if (document.activeElement === inp && inp.value) accept(inp.value); }, 250);
          prev = now;
        });
        setTimeout(function () { var x = $('#tIn'); if (x && !(document.activeElement && document.activeElement.id === 'tQty')) x.focus(); }, 30);
        $('#tCam').onclick = function () {
          var k = step();
          openCamera(k, function (code) { accept(code); }, { label: STEPS.filter(function (s) { return s[0] === k; })[0][1], qr: k !== 'bc' });
        };
        var ce = $('#tCancelEdit'); if (ce) ce.onclick = function () { st.edit = ''; msg = { cls: '', text: '' }; draw(); };
        var sk = $('#tSkipSrc'); if (sk) sk.onclick = function () { st.srcSkip = true; st.src = ''; st.edit = ''; msg = { cls: '', text: '来源库位不填，直接扫商品箱码' }; draw(); };
      }
      if (cur === 'batch') {
        setTimeout(function () { var bx = $('.tbatc'); if (bx && bx.scrollIntoView) bx.scrollIntoView({ block: 'nearest' }); }, 30);
        var cb = $('#tCancelEdit'); if (cb) cb.onclick = function () { st.edit = ''; msg = { cls: '', text: '' }; draw(); };
        Array.prototype.forEach.call(app.querySelectorAll('[data-bi]'), function (b) {
          b.onclick = function () { var x = st.bopts[+b.dataset.bi]; if (!x) return; st.batch = x.base; st.bexp = x.exp; st.bok = true; st.bnew = false; st.edit = ''; beep(); msg = { cls: 'good', text: '✓ 批次：到期 ' + (x.exp || '—') + ' · ' + (x.base || '不分批次') }; draw(); };
        });
      }
      // v1.9.16 新批次（系统里还没有）：记成不分批次，旧批次的库位不动
      var setNew = function (on, e) { if (e) { e.preventDefault(); e.stopPropagation(); } var x = st.bopts[0] || {};
        if (on) { st.batch = ''; st.bexp = ''; st.bnew = true; } else { st.batch = x.base || ''; st.bexp = x.exp || ''; st.bnew = false; }
        st.bok = true; if (st.edit === 'batch') st.edit = ''; beep(); msg = { cls: 'good', text: on ? '✓ 新批次：记成不分批次（旧批次的库位不动）' : '✓ 批次：到期 ' + (x.exp || '—') }; saveDraft(); draw(); };
      Array.prototype.forEach.call(app.querySelectorAll('[data-bnew]'), function (b) { b.onclick = function (e) { setNew(true, e); }; });
      Array.prototype.forEach.call(app.querySelectorAll('[data-bnew1]'), function (b) { b.onclick = function (e) { setNew(true, e); }; });
      Array.prototype.forEach.call(app.querySelectorAll('[data-bold1]'), function (b) { b.onclick = function (e) { setNew(false, e); }; });
      [['#tPhotoBtn', '#tPhoto'], ['#tPhotoAltBtn', '#tPhotoAlt']].forEach(function (p) {
        var b = $(p[0]), fi = $(p[1]); if (!b || !fi) return;
        b.onclick = function () {
          if (camOpen) stopCamera();                       // 扫码相机还开着时，系统相机会打不开
          LS.set('tphotoPending', Date.now());
          // 从相机回来时网页还在（没被重新载入）→ 清掉标记；只有真的被重新载入时才会看到提示
          var back = function () { if (!document.hidden) { document.removeEventListener('visibilitychange', back); setTimeout(function () { LS.del('tphotoPending'); }, 1500); } };
          document.addEventListener('visibilitychange', back);
          try { fi.value = ''; } catch (e) { }
          fi.click();
        };
        fi.onchange = function () {
          LS.del('tphotoPending');
          var f = fi.files && fi.files[0]; if (!f) return;
          msg = { cls: '', text: '处理照片中…' }; photoBusy = true; draw();
          compressPhoto(f).then(function (d) { photoBusy = false; st.photo = d; st.edit = ''; msg = { cls: 'good', text: missing().length ? '照片已拍好' : '照片已拍好，确认无误后点“提交”' }; draw(); },
            function (e) { photoBusy = false; msg = { cls: 'bad', text: e.message }; errBeep(); draw(); });
        };
      });
      $('#tReset').onclick = function () { confirmBox('清空这一笔，重新开始？', '重新开始', function () { reset(false); }); };
      $('#tSubmit').onclick = submit;
      var ub = $('#tUnk'); if (ub) ub.onclick = askUnknown;
      Array.prototype.forEach.call(app.querySelectorAll('[data-sh]'), function (b) { b.onclick = function () { pickShelf(+b.dataset.sh); }; });
      Array.prototype.forEach.call(app.querySelectorAll('[data-edit]'), function (b) {
        b.onclick = function () {          // 任何一栏随时可点：先扫哪个都行，点了已填的就是重扫
          var k = b.dataset.edit; if (step() === k) return;
          st.edit = k; msg = { cls: '', text: k === 'batch' ? '重新选批次' : (st[k] ? '重新' : '') + (k === 'photo' ? '拍照' : '扫描') + '：' + STEPS.filter(function (s) { return s[0] === k; })[0][1] }; draw();
        };
      });
      var tr = $('#tRecent'); if (tr) tr.onclick = function (e) {
        var f = e.target.closest && e.target.closest('[data-rf]');
        if (f) { RL.status = f.getAttribute('data-rf'); RL.shown = 20; recent = RL.status ? [] : recent; return refreshRecent(); }
        if (e.target.closest && e.target.closest('[data-rmore]')) return refreshRecent(true);
        var row = e.target.closest && e.target.closest('.tedit'); if (!row) return;
        var r = recent.filter(function (x) { return x.id === row.getAttribute('data-rid'); })[0]; if (r) editRecent(r);
      };
      Array.prototype.forEach.call(app.querySelectorAll('[data-tdel]'), function (b) {
        b.onclick = function () { confirmBox('删除这笔被退回的记录？', '删除', function () { IDB.del(b.dataset.tdel).then(refreshTq).then(draw); }); };
      });
    }
    /** 数量框：只收数字；如果扫描枪把条码打进了数量框（7 位以上数字 / 有字母或横线），当成扫描处理，数量框保持原样 */
    function bindQty(q, onVal, onDone) {
      if (!q) return;
      var before = q.value, tm;
      var looksScan = function (v) { return /^\d{7,}$/.test(v) || /[A-Za-z\-]/.test(v); };
      var check = function (fromEnter, fromBlur) {
        var v = q.value.trim();
        if (looksScan(v)) { if (fromBlur) return false; q.value = before; onVal(before); accept(v); return true; }
        if (v && !/^\d{1,7}(\.\d{1,3})?$/.test(v)) { q.classList.add('bad'); return false; }
        q.classList.remove('bad'); before = v; onVal(v); if (fromEnter && onDone) onDone();
        return true;
      };
      q.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); check(true); } });
      q.addEventListener('input', function () { clearTimeout(tm); tm = setTimeout(function () { check(false); }, 600); });
      q.addEventListener('blur', function () { clearTimeout(tm); check(false, true); });
    }
    function fail(text) { msg = { cls: 'bad', text: text }; errBeep(); draw(); }
    function accept(raw) {
      var box = $('#tIn'); if (box) box.value = '';                 // 已处理的扫描内容不要在重画时保留
      var k = step();
      if (k === 'src' || k === 'dst') {
        var loc = normLoc(raw);
        if (!loc) return;
        if (!locRe().test(loc)) return fail(lookupItem(normCode(raw)) ? '这是商品条码，请扫描库位条码' : '库位条码格式不对：' + loc);
        if (k === 'dst' && loc === st.src) return fail('目的库位和来源库位相同：' + loc);
        if (k === 'src' && st.dst && loc === st.dst) return fail('来源库位和目的库位相同：' + loc);
        st[k] = loc;
      } else if (k === 'bc') {
        var code = normCode(raw);
        if (!code) return;
        if (locRe().test(normLoc(raw))) return fail('这是库位条码，请扫描商品箱码');
        var it = lookupItem(code) || { itemCode: '', desc: '', match: '未识别' };   // 主档没有也照样记录
        var same = code === st.bc;
        st.bc = code; st.item = it.itemCode; st.desc = it.desc; st.match = it.match; if (!same) { st.learn = false; st.newName = ''; }
        if (!same || !st.bst) loadBatches();
      } else return;
      beep(); st.edit = ''; msg = { cls: 'good', text: '✓ ' + (k === 'bc' ? (st.item ? st.item + ' ' + (st.desc || '') : st.bc) : normLoc(raw)) };
      draw();
    }
    /** v1.4.6 修改已提交的记录（不能删除）：来源 / 箱码 / 目的 / 数量。还没上传的直接改手机里的；已上传的要联网，后台记录修改前后 */
    function editRecent(r) {
      var pendRec = null;
      IDB.all().catch(function () { return []; }).then(function (all) {
        pendRec = (all || []).filter(function (q) { return q.transferId === r.id && !q.rejected; })[0] || null;
        var cur = pendRec ? { src: pendRec.source, bc: pendRec.barcode, dst: pendRec.dest, qty: pendRec.qty || '', batch: pendRec.batch } : { src: r.src || '', bc: r.bc || '', dst: r.dst || '', qty: r.qty === '' || r.qty == null ? '' : String(r.qty), batch: r.batch };
        if (!cur.bc && !pendRec) cur.bc = r.bc || r.item || '';
        var f = function (id, label, val, im, ph) { return '<label class="tef"><span>' + label + '</span><input id="' + id + '" inputmode="' + im + '" autocomplete="off" autocapitalize="characters" spellcheck="false" value="' + esc(val) + '" placeholder="' + ph + '"></label>'; };
        modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic" style="background:#e6eefb;color:#1f3864">✎</span><div><h3>修改这笔移库位</h3><div class="hint">' + esc(r.t || '') + ' · ' + esc(r.status || '') + (pendRec ? ' · 还没上传' : '') + '</div></div></div>' +
          f('teSrc', '来源库位（选填）', cur.src, 'text', '不填') + f('teBc', '商品箱码', cur.bc, 'text', '扫描或输入') +
          '<label class="tef"><span>批次（看到期日）</span><select id="teB" disabled><option>读取批次…</option></select></label>' +
          f('teDst', '目的库位', cur.dst, 'text', '扫描或输入') + f('teQty', '数量（选填）', cur.qty, 'decimal', '不填') +
          '<p class="hint">照片不变。修改会记录修改前后，记录不能删除。</p><div id="teMsg" class="err"></div>' +
          '<div class="row"><button class="btn ghost" id="teNo">取消</button><button class="btn save" id="teOk">保存修改</button></div></div>', function (m) {
            var ids = ['teSrc', 'teBc', 'teDst', 'teQty'], BL = null, blFor = '';
            // v1.8.2 改批次：列出这个箱码的商品的批次（2 个以上才要选；改了箱码就重新读）
            var loadB = function () {
              var code = normCode($('#teBc', m).value), sel = $('#teB', m); if (!sel || !code || code === blFor) return;
              blFor = code; BL = null; sel.disabled = true; sel.innerHTML = '<option>读取批次…</option>';
              var li = lookupItem(code);
              trBatches(code, li ? li.itemCode : '', function (list) {
                if (blFor !== code || !$('#teB', m)) return;
                BL = list; var want = code === normCode(cur.bc) ? cur.batch : null;
                if (!list.length) { sel.innerHTML = '<option value="">没有批次（不用选）</option>'; return; }
                if (list.length === 1) { sel.innerHTML = '<option value="' + esc(list[0].base) + '">到期 ' + esc(list[0].exp || '—') + ' · ' + esc(list[0].base) + '（只有 1 个）</option>'; return; }
                sel.innerHTML = (list.some(function (b) { return b.base === want; }) ? '' : '<option value="" disabled selected>— 请选批次 —</option>') + list.map(function (b) {
                  return '<option value="' + esc(b.base) + '"' + (b.base === want ? ' selected' : '') + '>到期 ' + esc(b.exp || '—') + ' · 库存 ' + esc(b.qty) + ' · ' + esc(b.base) + ((b.locs || []).length ? ' · ' + esc(b.locs.join(' ')) : '') + '</option>';
                }).join('');
                sel.disabled = false;
              });
            };
            loadB(); $('#teBc', m).addEventListener('change', loadB); $('#teBc', m).addEventListener('blur', loadB);
            ids.forEach(function (k, i) { $('#' + k, m).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var nx = ids[i + 1]; if (nx) $('#' + nx, m).focus(); else $('#teOk', m).click(); } }); });
            $('#teNo', m).onclick = closeModal;
            $('#teOk', m).onclick = function () {
              var src = normLoc($('#teSrc', m).value), bc = normCode($('#teBc', m).value), dst = normLoc($('#teDst', m).value), qty = $('#teQty', m).value.trim(), out = $('#teMsg', m);
              var e = [];
              if (src && !locRe().test(src)) e.push('来源库位格式不对：' + src);
              if (!dst || !locRe().test(dst)) e.push('目的库位格式不对：' + (dst || '空'));
              if (src && src === dst) e.push('来源和目的库位相同');
              if (!bc) e.push('请填商品箱码'); else if (locRe().test(bc)) e.push('箱码栏填的是库位条码');
              if (qty && !(/^\d{1,7}(\.\d{1,3})?$/.test(qty) && Number(qty) > 0)) e.push('数量只能填大于 0 的数字，或留空');
              loadB();
              var bsel = $('#teB', m), batch;
              if (BL && blFor === bc) {
                if (BL.length > 1) { batch = bsel.value || undefined; if (!batch && (src !== cur.src || bc !== normCode(cur.bc) || dst !== cur.dst)) e.push('请选批次（看箱子上的到期日）'); }
                else batch = BL.length ? BL[0].base : '';
              } else if (bc !== normCode(cur.bc)) e.push('批次还在读取，请等一下再保存');
              if (e.length) { out.textContent = e.join('；'); errBeep(); return; }
              var bInfo = BL && BL.filter(function (b) { return b.base === batch; })[0];
              if (src === cur.src && bc === normCode(cur.bc) && dst === cur.dst && qty === String(cur.qty) && (batch == null || batch === (cur.batch || ''))) { closeModal(); return; }
              var btn = $('#teOk', m); btn.disabled = true;
              var it = lookupItem(bc) || { itemCode: '', desc: '' };
              var after = function (item, desc, status, d) {
                r.src = src; r.dst = dst; r.bc = bc; r.item = item || bc; r.desc = item ? desc : ''; r.qty = qty === '' ? '' : Number(qty); if (status) r.status = status; if (!pendRec) r.edits = (r.edits || 0) + 1;
                if (batch != null) { r.batch = batch; r.bexp = bInfo ? bInfo.exp : ''; } if (d && d.locResult) r.locResult = d.locResult;
                LS.set('trecent', recent.slice(0, 20)); closeModal(); beep();
                msg = { cls: 'good', text: '✓ 已修改：' + (r.item || bc) + '  ' + (src || '（无来源）') + ' → ' + dst + (qty ? ' · 数量 ' + qty : '') }; draw();
              };
              if (pendRec && tqFlushing) { btn.disabled = false; out.textContent = '这笔正在上传，请等几秒再改'; return; }
              if (pendRec) {          // 还没上传：直接改手机里的这笔，上传时就是新资料
                Object.assign(pendRec, { source: src, barcode: bc, dest: dst, qty: qty, itemCode: it.itemCode, desc: it.desc });
                if (batch != null) { pendRec.batch = batch; pendRec.bexp = bInfo ? bInfo.exp : ''; } else if (bc !== normCode(cur.bc)) { delete pendRec.batch; delete pendRec.bexp; }
                return IDB.put(pendRec).then(function () { after(it.itemCode, it.desc); }, function (x) { btn.disabled = false; out.textContent = '保存失败：' + x.message; });
              }
              var tb = { transferId: r.id, source: src, barcode: bc, dest: dst, qty: qty }; if (batch != null) tb.batch = batch;
              api({ action: 'transferEdit', transfer: tb }, true).then(function (d) {
                if (d.status === 'saved') { after(d.itemCode, d.description, d.recStatus, d); return refreshRecent(); }
                if (d.status === 'same') { closeModal(); return; }
                btn.disabled = false; out.textContent = d.message || '修改失败'; errBeep();
                if (d.done || d.gone) refreshRecent();
              }, function (x) { btn.disabled = false; out.textContent = x.network ? '需要联网才能修改已上传的记录，请联网后再试' : x.message; errBeep(); });
            };
            setTimeout(function () { $('#teQty', m).focus(); }, 60);
          });
      });
    }
    function reset(keep) {
      var src = st.src, dst = st.dst;
      st = tState = { src: keep ? src : '', srcSkip: false, bc: '', item: '', desc: '', match: '', dst: keep ? dst : '', qty: '', photo: '', edit: '', bst: '', bopts: [], batch: '', bexp: '', bok: false, bnew: false };
      mkSteps();
      LS.del('tdraft'); showNeed = false;
      msg = { cls: '', text: '' }; draw();
    }
    /** v1.9.2 箱码不认识：当场选是哪个商品（来源库位上的货 / 扫另一个码 / 搜品名 / 新商品）。选了才能提交，提交时后台记住箱码 */
    function askUnknown() {
      var code = st.bc; if (!code || st.item || st.newName) return;
      var srcItems = [], found = null, finding = false;
      var nameOf = function (it) { var x = masters && masters.byItem[it]; return x ? x[2] : ''; };
      (trSnapAt(st.src) || []).forEach(function (x) { if (!srcItems.some(function (y) { return y.item === x[1]; })) srcItems.push({ item: x[1], desc: x[2] || nameOf(x[1]), exp: '' }); });
      if (st.src && masters && masters.batches) Object.keys(masters.batches).forEach(function (it) {
        (masters.batches[it] || []).forEach(function (b) { if (String(b[5] || '').split(' ').indexOf(st.src) >= 0 && !srcItems.some(function (y) { return y.item === it; })) srcItems.push({ item: it, desc: nameOf(it), exp: b[2] }); });
      });
      var choose = function (item, desc) {
        if (st.bc !== code) return closeModal();
        closeModal(); st.item = item; st.desc = desc || nameOf(item); st.match = '仓管认出'; st.learn = true; st.newName = '';
        beep(); msg = { cls: 'good', text: '✓ 箱码 ' + code + ' 是 ' + st.item + ' ' + (st.desc || '') + '（提交时系统记住）' };
        loadBatches(); draw();
      };
      var listHtml = function (arr, empty) { return arr.length ? arr.map(function (x, i) { return '<button class="lmpi" data-uk="' + i + '"><b data-nt>' + esc(x.desc || x.item) + '</b><span data-nt>' + esc(x.item) + (x.exp ? ' · 到期 ' + esc(x.exp) : '') + '</span></button>'; }).join('') : '<p class="hint">' + empty + '</p>'; };
      var paint = function (m) {
        var box = $('#ukList', m), arr = found || srcItems;
        box.innerHTML = found ? listHtml(found, '没有找到，换个词再试，或点下面“新商品”') : st.src ? '<p class="hint" style="margin:0 0 6px">系统里 <b data-nt>' + esc(st.src) + '</b> 放的货' + (finding ? '（读取中…）' : '') + '：</p>' + listHtml(srcItems, finding ? '读取中…' : '系统里这个库位没有记录，请扫另一个码或搜品名') : '<p class="hint">没有扫来源库位：请扫箱子上的另一个码，或搜品名</p>';
        Array.prototype.forEach.call(box.querySelectorAll('[data-uk]'), function (b) { b.onclick = function () { var x = arr[+b.dataset.uk]; if (x) choose(x.item, x.desc); }; });
      };
      errBeep();
      modal('<div class="ldq tunkm"><div class="ldq-h">箱码 <span data-nt>' + esc(code) + '</span> 系统不认识</div><p class="hint">选出是哪个商品才能提交。选了以后系统记住这个箱码，以后扫就认得。</p>' +
        '<div id="ukList" class="lmpick"></div>' +
        '<div class="lmrow"><input id="ukQ" class="pkq" autocomplete="off" placeholder="扫箱子上的另一个码，或输入品名 / Item Code"><button class="btn save" id="ukGo" style="flex:0 0 70px">查找</button></div><div id="ukM" class="ldq-m"></div>' +
        '<button class="tbtn lmnewb" id="ukNew">都不是：新商品（写品名）</button>' +
        '<div class="row"><button class="btn ghost" id="ukRe">扫错了，重扫箱码</button><button class="btn ghost" id="ukX">稍后再选</button></div></div>', function (m) {
          paint(m);
          if (st.src && !trSnap && cfg && sess && navigator.onLine !== false) {        // 手机里还没有库位资料：问后台
            finding = true; paint(m);
            api({ action: 'trLoc', loc: st.src, item: '' }, true).then(function (d) {
              finding = false; (d && d.others || []).forEach(function (o) { if (!srcItems.some(function (y) { return y.item === o.item; })) srcItems.push({ item: o.item, desc: o.desc || nameOf(o.item), exp: o.exp }); });
              if ($('#ukList', m)) paint(m);
            }, function () { finding = false; if ($('#ukList', m)) paint(m); });
          }
          var q = $('#ukQ', m), say = function (t, bad) { var e = $('#ukM', m); e.className = 'ldq-m' + (bad ? ' err' : ''); e.textContent = t; };
          var run = function () {
            var v = q.value.trim(); if (!v) return;
            if (/^[0-9A-Za-z\-.\/]{6,}$/.test(v) && !/\s/.test(v)) {            // 像条码 / Item Code
              var c = normCode(v), it = lookupItem(c);
              if (it && it.itemCode) return choose(it.itemCode, it.desc);
              if (cfg && sess && navigator.onLine !== false) {
                say('查找中…');
                return api({ action: 'trBatches', code: c, item: '' }, true).then(function (d) { if (d && d.item) choose(d.item, d.desc); else { say('这个码系统也不认识，试试搜品名', true); errBeep(); } }, function () { say('没有网络：请搜品名', true); });
              }
            }
            var words = v.toUpperCase().split(/\s+/).filter(Boolean), out = [];
            Object.keys((masters && masters.byItem) || {}).some(function (it) {
              var d = nameOf(it), hay = (d + ' ' + it).toUpperCase();
              if (words.every(function (w) { return hay.indexOf(w) >= 0; })) out.push({ item: it, desc: d });
              return out.length >= 40;
            });
            found = out; say(out.length ? '点一下选择' : ''); paint(m);
          };
          $('#ukGo', m).onclick = run; q.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } };
          $('#ukNew', m).onclick = function () {
            var nm = q.value.trim();
            modal('<div class="ldq"><div class="ldq-h">新商品</div><p class="hint">箱码 <b data-nt>' + esc(code) + '</b> · 写下箱子上的品名，系统先建一个新商品记住它。以后导入条码表对上了会自动合并。</p>' +
              '<input id="niN" class="pkq" maxlength="100" autocomplete="off" placeholder="品名，例如 李錦記蒸鱼豉油 410ML" value="' + esc(/^[0-9]+$/.test(nm) ? '' : nm) + '"><div id="niM" class="ldq-m"></div>' +
              '<div class="row"><button class="btn ghost" id="niX">返回</button><button class="btn save" id="niO">确定</button></div></div>', function (m2) {
                var inp = $('#niN', m2), ok = function () {
                  var v = inp.value.trim(); if (v.length < 2) { $('#niM', m2).className = 'ldq-m err'; $('#niM', m2).textContent = '请写品名'; errBeep(); return; }
                  closeModal(); st.newName = v; st.item = ''; st.desc = v; st.match = '新商品'; st.learn = false; st.bst = 'none'; st.bopts = []; st.batch = ''; st.bexp = ''; st.bok = false; st.bnew = false; mkSteps();
                  beep(); msg = { cls: 'good', text: '✓ 新商品：' + v + '（提交时系统建新商品并记住箱码）' }; draw();
                };
                inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
                $('#niO', m2).onclick = ok; $('#niX', m2).onclick = function () { closeModal(); askUnknown(); }; setTimeout(function () { inp.focus(); }, 50);
              });
          };
          $('#ukRe', m).onclick = function () { closeModal(); st.bc = ''; st.item = ''; st.desc = ''; st.bst = ''; st.edit = 'bc'; msg = { cls: '', text: '重新扫描商品箱码' }; mkSteps(); draw(); };
          $('#ukX', m).onclick = function () { closeModal(); draw(); };
          setTimeout(function () { if (!srcItems.length) q.focus(); }, 60);
        });
    }
    function submit() {
      if (busy) return;
      if (photoBusy) return infoBox('照片还在处理中', '请等一两秒，照片处理好后再点“提交”。');
      var miss = missing();
      if (miss.length) return showMissing(miss);
      var qEl = $('#tQty'); if (qEl) st.qty = qEl.value.trim();
      if (st.qty && !/^\d{1,7}(\.\d{1,3})?$/.test(st.qty)) return infoBox('数量不对', '数量只能填数字（例如 24 或 2.5），不需要可以留空。');
      if (st.qty && !(Number(st.qty) > 0)) return infoBox('数量不对', '数量要大于 0；不需要数量请留空。');
      st.edit = ''; showNeed = false;                  // 正在重扫某一栏但资料都齐了：直接用现有资料提交
      busy = true;
      // v1.8.3 库位释放系统不知道：目的库位系统里还记着别的货 → 当场确认旧货还在不在（覆盖 / 一起放）。离线问不了：后台转仓管
      if (!st.item) return save(null, []);
      if (trSnap) {                                    // v1.9.3 用手机里的库位资料，马上问（不等后台）
        var base0 = st.bok ? st.batch : null, it0 = st.item;
        var o0 = trSnapAt(st.dst).filter(function (x) { return !(x[1] === it0 && (base0 == null || x[3] === base0)); }).map(function (x) {
          var bb = masters && masters.batches && (masters.batches[x[1]] || []).filter(function (b) { return b[0] === x[3]; })[0];
          return { id: x[5] || '', item: x[1], desc: x[2], base: x[3], exp: bb ? bb[2] : '' };
        });
        return askOver(o0, true);
      }
      if (!cfg || !sess || navigator.onLine === false) return save(null, []);
      var asked = false, tm = setTimeout(function () { if (!asked) { asked = true; save(null, []); } }, 6000);
      api({ action: 'trLoc', loc: st.dst, item: st.item, base: st.bok ? st.batch : null }, true).then(function (d) {
        if (asked) return; asked = true; clearTimeout(tm);
        askOver((d && d.others) || [], false);
      }, function () { if (asked) return; asked = true; clearTimeout(tm); save(null, []); });
    }
    function askOver(o, local) {
        if (!o.length) return save(null, []);
        busy = false; errBeep();
        // v1.9.13 一条一条勾：勾了 = 已经不在（移走），没勾 = 还在（一起放）
        modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>库位 ' + esc(st.dst) + ' 系统里还有旧货</h3><div class="hint">新托盘放进去之前，请看一下：<b>已经不在的打勾</b>，没勾的当作还在</div></div></div>' +
          '<ul class="tover">' + o.map(function (x, i) { return '<li><label class="tovl"><input type="checkbox" data-ov="' + i + '"><span class="tovt"><b>' + esc(x.desc || x.item) + '</b><span>' + esc(x.item) + (x.base ? ' · 批次 ' + esc(x.base) : '') + (x.exp ? ' · 到期 <b>' + esc(x.exp) + '</b>' : '') + '</span></span><em class="tovs">还在</em></label></li>'; }).join('') + '</ul>' +
          '<div class="tovb"><div class="tovm" id="ovM"></div><button class="btn save" id="ovP">先勾选已经不在的货</button><button class="btn ghost" id="ovY">全部都不在了（全部移走）</button><button class="btn ghost" id="ovN">全部还在，一起放</button><button class="tbtn" id="ovC">取消，先不提交</button></div></div>', function (m) {
            var cbs = m.querySelectorAll('[data-ov]'), bp = $('#ovP', m);
            var ids = function (on) { var r = []; Array.prototype.forEach.call(cbs, function (c) { if (c.checked === on && o[+c.dataset.ov].id) r.push(o[+c.dataset.ov].id); }); return r; };
            var upd = function () {
              var n = 0; Array.prototype.forEach.call(cbs, function (c) { if (c.checked) n++; var li = c.closest('li'); li.classList.toggle('gone', c.checked); li.querySelector('.tovs').textContent = c.checked ? '不在了' : '还在'; });
              bp.classList.toggle('off', !n); if (n) $('#ovM', m).textContent = '';
              bp.textContent = !n ? '先勾选已经不在的货' : n === cbs.length ? '✓ 移走全部 ' + n + ' 条' : '✓ 移走勾选的 ' + n + ' 条，其余 ' + (cbs.length - n) + ' 条还在';
            };
            Array.prototype.forEach.call(cbs, function (c) { c.onchange = upd; });
            bp.onclick = function () {         // v1.9.15 没勾就点：说清楚要做什么（以前按钮是灰的，点了没反应）
              if (!ids(true).length && !Array.prototype.some.call(cbs, function (c) { return c.checked; })) { errBeep(); $('#ovM', m).textContent = '还没有勾选。请在上面勾选已经不在的货；如果全部都还在，点「全部还在，一起放」。'; return; }
              closeModal(); save(true, ids(true), ids(false));
            };
            $('#ovY', m).onclick = function () { closeModal(); save(true, o.map(function (x) { return x.id; }).filter(Boolean)); };
            $('#ovN', m).onclick = function () { closeModal(); save(false, []); };
            $('#ovC', m).onclick = function () { closeModal(); draw(); };
          });
    }
    function save(over, seen, kept) {
      busy = true;
      var r = { transferId: uuid(), source: st.src, dest: st.dst, barcode: st.bc, itemCode: st.item, desc: st.desc, photo: st.photo, qty: st.qty || '',
        clientTime: new Date().toISOString(), operator: operator };
      if (st.bok) { r.batch = st.batch; r.bexp = st.bexp; }          // 没选（没有批次 / 还没读到）：后台自己判断，判断不了转仓管
      if (st.learn && st.item) r.learnItem = st.item; else if (st.newName) r.newName = st.newName;      // v1.9.2 当场认出：后台记住箱码
      if (r.learnItem && masters) masters.byBarcode[r.barcode] = [r.barcode, r.itemCode, r.desc];       // 这台手机马上认得
      if (over === true || over === false) { r.over = over; if (seen) r.seen = seen; if (kept && kept.length) r.kept = kept; }
      trSnapApply(r.source, r.dest, r.itemCode, r.desc, r.batch != null ? r.batch : null, over, over === true ? seen || [] : null);
      IDB.put(r).then(function () {
        recent.unshift({ id: r.transferId, src: r.source, dst: r.dest, bc: r.barcode, item: r.itemCode || (r.newName ? '新商品' : r.barcode), desc: r.itemCode || r.newName ? r.desc : '', qty: r.qty, batch: r.batch || '', bexp: r.bexp || '', t: hhmm(r.clientTime), status: '待上传' });
        LS.set('trecent', recent.slice(0, 20));
        beep(); toast(navigator.onLine === false ? '✓ 已保存到手机，联网后自动上传' : '✓ 已提交');
        busy = false;
        var done = '✓ 已提交：' + (r.itemCode || (r.newName ? '新商品 ' + r.newName : r.barcode)) + (r.batch ? '（到期 ' + (r.bexp || '—') + '）' : st.bnew ? '（新批次，不分批次）' : '') + '  ' + (r.source || '（无来源）') + ' → ' + r.dest + (r.qty ? ' · 数量 ' + r.qty : '');
        reset(false);
        msg = { cls: 'good', text: done }; draw();
        return refreshTq().then(flushTransfers).then(function () { trSnapLoad(true); return refreshRecent(); });
      }, function (e) { busy = false; draw(); infoBox('提交失败', '保存到手机失败（' + e.message + '）。请再点一次“提交”；如果一直这样，请清理手机空间后再试。已扫的资料还在。'); });
    }
    currentRedraw = function () { if (location.hash === '#/t') draw(); };
    draw();
    trSnapLoad(true).then(function () { if (location.hash === '#/t' && step() === 'bc') draw(); });         // v1.9.3 库位资料（后台读，不挡操作）
    clearInterval(trSnapTimer); trSnapTimer = setInterval(function () { if (location.hash === '#/t' && !document.hidden) trSnapLoad(true); }, 60e3);   // 每分钟后台刷新
    loadMasters().then(function () { if (location.hash === '#/t') draw(); },
      function (e) { if (location.hash === '#/t') { msg = { cls: 'bad', text: (e.network ? '离线：' : '') + '设置下载失败，' + (masters ? '使用本机旧资料' : '照样可以记录') }; draw(); } });
    Promise.resolve(flushTransfers()).then(refreshRecent, refreshRecent);
  }
  var refreshRecentNow;
  // 切回 APP 时刷新“最近提交”（办公室可能刚删除/处理了记录）
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && location.hash === '#/t' && refreshRecentNow) refreshRecentNow();
  });
  // 焦点不在输入框时，扫描头的按键送到扫描框
  document.addEventListener('keydown', function (e) {
    if (location.hash !== '#/t' || !$('#modal').hidden || camOpen) return;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { var t = $('#tIn'); if (t) t.focus(); }
  }, true);

  // ---------------- 摄像头扫码 ----------------
  // ---------------- 摄像头扫码（v1.2.2 重写） ----------------
  // 1) 安卓 Chrome：直接用系统条码识别 BarcodeDetector，识别整张画面，不用对准小框，速度快
  //    其他手机（如 iPhone）：用 ZXing（html5-qrcode），扫描区改成宽的横条
  // 2) 要求 1920×1080 高分辨率 + 连续自动对焦（一维条码靠横向像素，之前默认只有 640×480）
  // 3) 只识别商品条码格式（EAN/UPC/Code128/ITF/Code39），之前连 QR/DataMatrix 一起找，慢
  // 4) 手电筒、放大按钮；8 秒还没扫到给提示
  // 5) EAN/UPC 检查校验位；没有校验位的格式要连续读到 2 次相同才接受（防误读）
  // =====================================================================
  // 装车前点货（v1.4）
  // 办公室上传电脑：选 AutoCount「Delivery Order Detail Listing」(+ 可选「送货单」补单位/规格) → 预览 → 上传建任务
  // PDA：任务列表 → 扫条码 / 搜索 → 输入本次数量 → 累加（只追加流水，离线先存手机，联网自动上传）→ 复核 → 确认完成
  // =====================================================================

  // ---------- 读取 .xlsx（浏览器自带解压，不依赖外部库，离线也能用） ----------
  function xlsxRead(buf, want) {          // want：按工作表名称挑（例如入库单的 FINAL DETAILS），没有就用第一张
    var u8 = new Uint8Array(buf), dv = new DataView(buf), eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.reject(new Error('不是 .xlsx 文件。请在 AutoCount 导出为 Excel（.xlsx）'));
    var n = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true), files = {}, td = new TextDecoder();
    for (var k = 0; k < n && dv.getUint32(off, true) === 0x02014b50; k++) {
      var nl = dv.getUint16(off + 28, true), xl = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
      files[td.decode(u8.subarray(off + 46, off + 46 + nl))] = { m: dv.getUint16(off + 10, true), size: dv.getUint32(off + 20, true), lho: dv.getUint32(off + 42, true) };
      off += 46 + nl + xl + cl;
    }
    function read(name) {
      var f = files[name]; if (!f) return Promise.resolve('');
      var st = f.lho + 30 + dv.getUint16(f.lho + 26, true) + dv.getUint16(f.lho + 28, true), data = u8.subarray(st, st + f.size);
      if (f.m === 0) return Promise.resolve(td.decode(data));
      if (f.m !== 8 || !window.DecompressionStream) return Promise.reject(new Error('浏览器版本太旧，请用最新版 Chrome 或 Edge'));
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    }
    var xml = function (s) { return new DOMParser().parseFromString(s, 'application/xml'); };
    var kids = function (el, tag) { return Array.prototype.filter.call(el.getElementsByTagName('*'), function (x) { return x.localName === tag; }); };
    return Promise.all([read('xl/workbook.xml'), read('xl/_rels/workbook.xml.rels'), read('xl/sharedStrings.xml')]).then(function (a) {
      if (!a[0]) throw new Error('读不出这个 Excel 文件');
      var sheets = kids(xml(a[0]), 'sheet'), sheet = (want && sheets.filter(function (x) { return want.test(x.getAttribute('name') || ''); })[0]) || sheets[0], rid = sheet && (sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      var target = 'worksheets/sheet1.xml';
      kids(xml(a[1] || '<x/>'), 'Relationship').forEach(function (r) { if (r.getAttribute('Id') === rid) target = r.getAttribute('Target'); });
      target = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target;
      var sst = a[2] ? kids(xml(a[2]), 'si').map(function (si) { return kids(si, 't').map(function (t) { return t.textContent; }).join(''); }) : [];
      return read(target).then(function (sx) {
        var doc = xml(sx), rows = {}, merges = [], maxRow = 0;
        kids(doc, 'c').forEach(function (c) {
          var ref = c.getAttribute('r') || '', m = ref.match(/^([A-Z]+)(\d+)$/); if (!m) return;
          var t = c.getAttribute('t'), vEl = kids(c, 'v')[0], v = vEl ? vEl.textContent : '';
          if (t === 's') v = sst[+v] || '';
          else if (t === 'inlineStr') v = kids(c, 't').map(function (x) { return x.textContent; }).join('');
          else if (t === 'b') v = v === '1';
          else if (t !== 'str' && t !== 'e' && v !== '' && !isNaN(+v)) v = +v;
          if (v === '' || v === null) return;
          var r = +m[2], col = colNum(m[1]); (rows[r] = rows[r] || {})[col] = v; maxRow = Math.max(maxRow, r);
        });
        kids(doc, 'mergeCell').forEach(function (mc) {
          var p = (mc.getAttribute('ref') || '').match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
          if (p) merges.push({ r1: +p[2], c1: colNum(p[1]), r2: +p[4], c2: colNum(p[3]) });
        });
        var spanEnd = {}; merges.forEach(function (g) { spanEnd[g.r1 + ',' + g.c1] = g.c2; });
        return { rows: rows, maxRow: maxRow, spanEnd: spanEnd };
      });
    });
  }
  function colNum(s) { var n = 0; for (var i = 0; i < s.length; i++) n = n * 26 + s.charCodeAt(i) - 64; return n; }
  function cellText(v) { return v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? v.toFixed(0) : String(v)) : String(v).replace(/\s+/g, ' ').trim(); }
  function rowCells(sh, r) {
    var row = sh.rows[r] || {};
    return Object.keys(row).map(Number).sort(function (a, b) { return a - b; }).map(function (c) { return { c1: c, c2: sh.spanEnd[r + ',' + c] || c, v: row[c] }; });
  }
  // 表头和数据因为合并单元格不在同一列：按“列范围重叠”对齐，没有重叠时取相邻一列
  function assignCols(heads, cells) {
    var ov = function (h, x) { return Math.max(0, Math.min(h.c2, x.c2) - Math.max(h.c1, x.c1) + 1); };
    var out = {}, used = [];
    cells.forEach(function (x, i) {
      var best = null, bo = 0;
      heads.forEach(function (h) { var o = ov(h, x); if (o > bo) { bo = o; best = h; } });
      if (best && out[best.f] === undefined) { out[best.f] = x.v; used[i] = 1; }
    });
    heads.forEach(function (h) {
      if (out[h.f] !== undefined) return;
      cells.forEach(function (x, i) { if (!used[i] && out[h.f] === undefined && Math.abs(x.c1 - h.c1) <= 1) { out[h.f] = x.v; used[i] = 1; } });
    });
    return out;
  }
  function xlDate(v) {
    if (typeof v === 'number' && v > 20000 && v < 80000) { var d = new Date(Math.round((v - 25569) * 864e5)); return d.toISOString().slice(0, 10); }
    var m = cellText(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    m = cellText(v).match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/); if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    return '';
  }
  function ldNorm(v) { var s = cellText(v).replace(/\s/g, '').toUpperCase(); return /^\d+$/.test(s) ? (s.replace(/^0+/, '') || '0') : s; }

  /** 合并用的键（和后台一致）：有 Item Code 用 Item Code；没有就用条码（去前导 0）；都没有用品名。再加单位 */
  function ldLineKey(l, pk) { return (l.itemCode ? l.itemCode.toUpperCase() : l.barcode ? 'BC:' + ldNorm(l.barcode) : 'N:' + l.desc.toUpperCase()) + '|' + l.uom + (pk ? '|B:' + String(l.batch || '').toUpperCase() : ''); }
  /** v1.5 拣货：从批次号结尾取库位（和后台 pkLoc_ 一样）。2701-AB-07-J01 → 07-J-01；排序：数字升序 → 字母降序 → 位号升序 */
  function pkLoc(batch) {
    var b = String(batch || '').trim();
    if (!b) return { loc: '', key: 'Z', flag: '没有批次号' };
    var m = b.match(/-(\d{1,2})-([A-Za-z])(\d{1,2})([^-]*)$/);
    if (!m) return { loc: '', key: 'Z', flag: '批次号没有库位' };
    var n = Number(m[1]), L = m[2].toUpperCase(), pos = Number(m[3]), p2 = function (x) { return ('0' + x).slice(-2); };
    if (n < 1 || n > 15) return { loc: '', key: 'Z', flag: '库位数字不对（' + m[1] + '）' };
    return { loc: p2(n) + '-' + L + '-' + p2(pos), key: 'A' + p2(n) + p2(90 - L.charCodeAt(0)) + p2(pos), flag: m[4].trim() ? '批次号格式异常（结尾多了“' + m[4].trim() + '”）' : '' };
  }
  /** 拣货模块的 PDA 用词（同一套点货画面，词换成“拣货”） */
  var LDW_MOD = 'ld';
  var LDW = [['🚚 装车点货', '📋 仓库拣货'], ['装车点货', '仓库拣货'], ['装车单', '拣货单'], ['装车', '拣货'], ['点货', '拣货'], ['已点齐', '已拣齐'], ['点齐', '拣齐'], ['已点', '已拣'], ['未点', '未拣'], ['没点', '没拣'], ['点到', '拣到'], ['点了', '拣了'], ['未装', '未拣'], ['没装', '没拣']];
  function ldW(h, m) { if ((m || LDW_MOD) !== 'pk') return h; h = String(h); LDW.forEach(function (w) { h = h.split(w[0]).join(w[1]); }); return h; }
  function ldModal(h, cb) { return modal(ldW(h), cb); }
  function ldModOf(id) { return /^PK-/i.test(String(id)) ? 'pk' : 'ld'; }
  function ldHash(id) { return '#/' + ldModOf(id) + '/' + encodeURIComponent(id); }
  /** v1.5.1 拣货：每个任务的列表筛选状态（进出 SKU 页都保留）、进 SKU 页时的识别方式、30 秒状态检查只留一个 */
  var pkUi = {}, pkEntry = null, ldStTimer = null;
  // v1.5.2 页面数字键盘：kpPage = SKU 页的键盘，kpModal = 修改弹窗的键盘。{ get, set, enter, scan }
  var kpPage = null, kpModal = null, kb = { s: '', last: 0, fast: true, base: '', timer: null };
  function kpBind(root, get, set) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-k]'), function (b) {
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });      // 不抢焦点
      b.onclick = function () {
        var k = b.dataset.k, v = get();
        if (k === 'b') v = v.slice(0, -1);
        else if (k === '.') { if (v.indexOf('.') < 0) v = (v || '0') + '.'; }
        else { if (v === '0') v = ''; if (v.replace('.', '').length < 7) v += k; }
        set(v);
      };
    });
  }
  /** 硬件按键（PDA 数字键 / 扫描枪）：慢慢按的数字进“本次数量”；一串很快的输入（扫描枪）当扫码；回车 = 确认 */
  function kpKey(e) {
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
    var K = $('#modal').hidden ? kpPage : ($('#kpMD') ? kpModal : null);
    if (!K) return false;
    var k = e.key, now = Date.now();
    if (k === 'Enter') { e.preventDefault(); kpFinish(K, true); return true; }
    if (k === 'Backspace') { e.preventDefault(); if (!kb.s) K.set(K.get().slice(0, -1)); return true; }
    if (!k || k.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return false;
    e.preventDefault();
    if (!kb.s) { kb.base = K.get(); kb.fast = true; } else if (now - kb.last > 50) kb.fast = false;
    kb.s += k; kb.last = now;
    if (/^[0-9.]+$/.test(kb.s)) { var v = kb.base + kb.s; if ((v.match(/\./g) || []).length < 2 && v.replace('.', '').length <= 7) K.set(v); }
    clearTimeout(kb.timer); kb.timer = setTimeout(function () { kpFinish(K, false); }, 120);
    return true;
  }
  function kpFinish(K, enter) {
    clearTimeout(kb.timer);
    var str = kb.s, scan = str && ((kb.fast && str.length >= 4) || /[^0-9.]/.test(str));
    kb.s = '';
    if (scan) { K.set(kb.base); K.scan(str); return; }
    if (enter) K.enter();
  }
  /** 有效（没被撤销）的“确认拣完（短少）”→ { 商品键: Txn ID } */
  function ldShortOkC(s) {
    var v = {}, o = {};
    Object.keys(s.txns).forEach(function (k) { var t = s.txns[k]; if (t.method === 'VOID' || t.method === 'REVERSAL') v[t.rev] = 1; });
    Object.keys(s.txns).forEach(function (k) { var t = s.txns[k]; if (t.method === 'SHORT_OK' && !v[t.id]) o[t.key] = t.id; });
    return o;
  }
  /** 商品编号显示：Item Code · 条码（没有 Item Code 时只显示条码） */
  function ldId(it, pfx) { var a = []; if (it.code) a.push(it.code); if (it.bc && it.bc !== it.code) a.push((it.code ? pfx : '') + it.bc); return a.join(' · ') || '（无条码）'; }
  var LIST_FIELDS = [['date', /^date$/i], ['doNo', /delivery\s*order\s*no|^do\s*no/i], ['itemCode', /^item\s*code/i], ['desc', /^desc/i],
    ['barcode', /bar\s*code/i], ['batch', /^batch(\s*no\.?)?$/i], ['qty', /^(qty|quantity)$/i], ['uom', /^(uom|unit)$/i], ['fromDoc', /from\s*doc/i], ['customer', /debtor|customer/i]];
  /** AutoCount「Delivery Order Detail Listing」：每行一条 DO 明细，带 DO 号 */
  function parseListing(sh) {
    for (var r = 1; r <= Math.min(sh.maxRow, 60); r++) {
      var cells = rowCells(sh, r), heads = [], extra = [];
      cells.forEach(function (x) {
        var t = cellText(x.v), f = LIST_FIELDS.filter(function (p) { return p[1].test(t); })[0];
        if (f) heads.push({ f: f[0], c1: x.c1, c2: x.c2, t: t }); else if (t) extra.push(t);
      });
      var has = function (f) { return heads.some(function (h) { return h.f === f; }); };
      if (!(has('doNo') && has('qty') && (has('itemCode') || has('barcode')))) continue;   // v1.4.4：没有 Item Code 列也可以（只有条码）
      var lines = [], hdrT = heads.map(function (h) { return h.t; });
      for (var rr = r + 1; rr <= sh.maxRow; rr++) {
        var cs = rowCells(sh, rr); if (!cs.length) continue;
        var texts = cs.map(function (x) { return cellText(x.v); });
        if (texts.filter(function (t) { return hdrT.indexOf(t) >= 0; }).length >= 3) continue;   // 每页重复的表头
        if (texts.some(function (t) { return /^(count:|end of report|report criteria)/i.test(t); })) continue;
        var o = assignCols(heads, cs);
        if (o.doNo === undefined && o.itemCode === undefined && o.barcode === undefined) continue;
        lines.push({ row: rr, doNo: cellText(o.doNo), doDate: xlDate(o.date), itemCode: cellText(o.itemCode), desc: cellText(o.desc), barcode: cellText(o.barcode),
          qty: typeof o.qty === 'number' ? o.qty : Number(cellText(o.qty).replace(/,/g, '')), qtyRaw: cellText(o.qty), uom: cellText(o.uom), fromDoc: cellText(o.fromDoc), batch: cellText(o.batch), customer: cellText(o.customer) });
      }
      return { kind: 'listing', lines: lines, hasUom: has('uom'), hasBatch: has('batch'), extra: extra.filter(function (t) { return !/^(page|date|user id)/i.test(t); }) };
    }
    return null;
  }
  var PRINT_FIELDS = [['seq', /^序号$/], ['batch', /^批次号$/], ['barcode', /^条码$/], ['desc', /^商品名称$/], ['qty', /^数量$/], ['spec', /^规格$/], ['uom', /^单位$/]];
  // ---------- v1.7 送货单 PDF（用「打印 → Microsoft Print to PDF」转的，文字可以选中）：pdf.js 读文字和位置 → 和 Excel 送货单一样的结构 ----------
  var PDFJS_V = '6.2.108', PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_V + '/legacy/build/';
  var PDFJS_SHA = { 'pdf.min.mjs': 'YzR7Q88uWohu1vX4vuDiPCeT46Pk8qPXuDLcDO7a/LOb6syUvYvYYcQclRT2VSPT', 'pdf.worker.min.mjs': 'xmo046yHKZIFB8fX6VJCV8nUAOARH/5lJdjB/bgsbvRwnVXay7R4ebX/EkVjhHoT' };
  var pdfLibP = null;
  /** 下载 pdf.js，核对 SHA-384（防止 CDN 文件被换掉）后再用 */
  function pdfLib() {
    if (pdfLibP) return pdfLibP;
    var get = function (f) {
      return fetch(PDFJS + f).then(function (r) { if (!r.ok) throw new Error('下载 PDF 读取组件失败（' + r.status + '）'); return r.arrayBuffer(); }).then(function (b) {
        return crypto.subtle.digest('SHA-384', b).then(function (h) {
          var x = btoa(String.fromCharCode.apply(null, new Uint8Array(h)));
          if (x !== PDFJS_SHA[f]) throw new Error('PDF 读取组件校验不通过，没有使用');
          return URL.createObjectURL(new Blob([b], { type: 'text/javascript' }));
        });
      });
    };
    pdfLibP = Promise.all([get('pdf.min.mjs'), get('pdf.worker.min.mjs')]).then(function (u) {
      return import(u[0]).then(function (lib) { lib.GlobalWorkerOptions.workerPort = new Worker(u[1], { type: 'module' }); return lib; });
    });
    pdfLibP.catch(function () { pdfLibP = null; });
    return pdfLibP;
  }
  /** 一份送货单 PDF → { kind:'printed', blocks:[{doNo, doDate, customer, lines}] }；没有中文（直接导出的那种）→ noChinese */
  function parsePdf(buf) {
    return pdfLib().then(function (lib) { return lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise; }).then(function (doc) {
      var pages = []; for (var i = 1; i <= doc.numPages; i++) pages.push(i);
      return Promise.all(pages.map(function (n) { return doc.getPage(n).then(function (pg) { return pg.getTextContent(); }); }));
    }).then(function (contents) {
      var blk = { doNo: '', doDate: '', customer: '', lines: [] }, any = '', seq = 0, blocks = [blk];
      contents.forEach(function (tc) {
        // 文字块 → 按 y 分行（同一行 y 相差 ≤ 3）
        var its = tc.items.filter(function (t) { return String(t.str).trim(); }).map(function (t) { return { s: String(t.str).trim(), x: t.transform[4], y: t.transform[5], w: t.width || 0 }; });
        its.sort(function (a, b) { return b.y - a.y || a.x - b.x; });
        var rows = [];
        its.forEach(function (t) { var r = rows[rows.length - 1]; if (r && Math.abs(r.y - t.y) <= 3) r.items.push(t); else rows.push({ y: t.y, items: [t] }); });
        rows.forEach(function (r) {
          r.items.sort(function (a, b) { return a.x - b.x; });
          // 打印转 PDF 常把一个词拆成几块（“条”“码”、“小”“龙”“坎酸辣粉”）：紧挨着的拼回去
          var m = [];
          r.items.forEach(function (t) { var p = m[m.length - 1]; if (p && t.x - (p.x + p.w) < 1.5) { p.s += t.s; p.w = t.x + t.w - p.x; } else m.push({ s: t.s, x: t.x, y: t.y, w: t.w }); });
          r.items = m; r.text = m.map(function (t) { return t.s; }).join(' '); any += r.text;
        });
        var hi = rows.findIndex(function (r) { return /序号/.test(r.text) && /条码/.test(r.text) && /商品名称/.test(r.text); });
        // 表头上面：DO 号、日期、客户（客户 = DO 号那一行左边的文字）
        // v1.9.9 一个 PDF 里可以有好几张 DO：这一页印的单号和上一张不同 → 新的一张（续页没有单号 / 单号相同就接着上一张）
        var pdn = null; rows.slice(0, hi < 0 ? rows.length : hi).some(function (r) { pdn = r.text.match(/\b[A-Z]{1,6}DO-\d{4,}\b/); return !!pdn; });
        if (pdn && blk.doNo && pdn[0] !== blk.doNo) { blk = { doNo: '', doDate: '', customer: '', lines: [] }; blocks.push(blk); seq = 0; }
        rows.slice(0, hi < 0 ? rows.length : hi).forEach(function (r) {
          var dn = r.text.match(/\b[A-Z]{1,6}DO-\d{4,}\b/);
          if (dn && !blk.doNo) {
            blk.doNo = dn[0];
            var colon = r.items.filter(function (t) { return /^[:：]/.test(t.s) || t.s.indexOf(dn[0]) >= 0; })[0];
            var left = r.items.filter(function (t) { return colon && t.x < colon.x - 20 && !/单据编号/.test(t.s); }).map(function (t) { return t.s; }).join(' ').trim();
            if (left && !blk.customer) blk.customer = left;
          }
          var dm = /日期/.test(r.text) && r.text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (dm && !blk.doDate) blk.doDate = dm[3] + '-' + ('0' + dm[2]).slice(-2) + '-' + ('0' + dm[1]).slice(-2);
        });
        if (hi < 0) return;
        // 列：用表头文字的中心点分界
        var H = [['seq', /^序号$/], ['batch', /^批次号$/], ['barcode', /^条码$/], ['desc', /^商品名称$/], ['qty', /^数量$/], ['spec', /^规格$/], ['uom', /^单位$/]];
        var cols = [];
        // v1.9.10 表头里其他列（单价 / 金额 / 折扣…）也占一列，但不读 —— 不然价格会被算进“单位”
        rows[hi].items.forEach(function (t) { var f = H.filter(function (h) { return h[1].test(t.s); })[0]; cols.push({ f: f ? f[0] : '_', c: t.x + t.w / 2 }); });
        cols.sort(function (a, b) { return a.c - b.c; });
        var colOf = function (t) {
          var c = t.x + t.w / 2, best = cols[0];
          for (var k = 1; k < cols.length; k++) if (c >= (cols[k - 1].c + cols[k].c) / 2) best = cols[k];
          return best ? best.f : '';
        };
        var cur = null, gap = 0;
        rows.slice(hi + 1).forEach(function (r) {
          var o = {}; r.items.forEach(function (t) {
            var f = colOf(t), s0 = t.s;
            // v1.9.6 品名太长（如“（英文版）”）的一截会被算到数量列：数量列里不是数字的部分还给品名
            if (f === 'qty' && !/^[\d,]+(\.\d+)?$/.test(s0)) {
              var mq = /^(.*?)\s*([\d,]+(?:\.\d+)?)$/.exec(s0);
              if (mq && mq[1]) { o.desc = (o.desc || '') + mq[1]; s0 = mq[2]; } else if (!mq) { o.desc = (o.desc || '') + s0; return; }
            }
            o[f] = (o[f] ? o[f] + ' ' : '') + s0;
          });
          if (/^\d+\.?$/.test(o.seq || '')) {
            seq++;
            cur = { row: seq, batch: o.batch || '', barcode: (o.barcode || '').replace(/\s+/g, ''), desc: o.desc || '', qtyRaw: o.qty || '', spec: o.spec || '', uom: String(o.uom || '').replace(/\s+[\d.,]+(\s.*)?$/, ''), y: r.y };
            cur.qty = Number(String(cur.qtyRaw).replace(/,/g, ''));
            blk.lines.push(cur); gap = 0; return;
          }
          // 折行：品名 / 规格 / 单位太长换到下一行（紧挨着上一行），拼回去
          // v1.9.8 批次号太长也会折行（2802-BENMART-15- / N01），一起拼回去，不然库位读不出来
          if (cur && !o.seq && !o.barcode && !o.qty && (o.batch || o.desc || o.spec || o.uom) && cur.y - r.y < 40) {
            if (o.batch) cur.batch += o.batch.replace(/\s+/g, ''); if (o.desc) cur.desc += o.desc; if (o.spec) cur.spec += o.spec; if (o.uom) cur.uom += o.uom; cur.y = r.y;
          }
        });
      });
      blocks.forEach(function (b) { b.lines.forEach(function (l) { delete l.y; }); });
      return { kind: 'printed', pdf: true, noChinese: !/[\u4e00-\u9fff]/.test(any), blocks: blocks };
    });
  }
  /** AutoCount「送货单」打印版式：用来补单位、规格、批次号 */
  function parsePrinted(sh) {
    var heads = [], hr = 0;
    for (var r = 1; r <= sh.maxRow && !hr; r++) {
      var t = rowCells(sh, r).map(function (x) { return cellText(x.v); });
      if (t.indexOf('条码') >= 0 && t.indexOf('商品名称') >= 0) hr = r;
    }
    if (!hr) return null;
    [hr, hr + 1].forEach(function (r) {
      rowCells(sh, r).forEach(function (x) {
        var t = cellText(x.v), f = PRINT_FIELDS.filter(function (p) { return p[1].test(t); })[0];
        if (f && !heads.some(function (h) { return h.f === f[0]; })) heads.push({ f: f[0], c1: x.c1, c2: x.c2 });
      });
    });
    var blocks = [], cur = null, docNo = '', docDate = '', cust = '', afterTitle = false;
    for (var rr = 1; rr <= sh.maxRow; rr++) {
      var cs = rowCells(sh, rr), texts = cs.map(function (x) { return cellText(x.v); });
      // v1.7 客户名：标题“送货单”下面第一行的文字
      if (!cur && rr < hr) { var tx = texts.filter(String); if (afterTitle && tx.length && !cust) cust = tx[0]; if (tx.length === 1 && /^送货单$/.test(tx[0])) { afterTitle = true; cust = ''; } }
      var dn = texts.join(' ').match(/\b[A-Z]{1,6}DO-\d{4,}\b/); if (dn && rr < hr || dn && !cur) docNo = dn[0];
      var di = texts.indexOf('日期');                      // v1.6 送货单日期（“日期 : 2026-11-12”）
      if (di >= 0 && !cur) { for (var k = di + 1; k < cs.length; k++) { var dv = xlDate(cs[k].v); if (dv) { docDate = dv; break; } } }
      if (texts.some(function (t) { return /拣货人签字/.test(t); })) { if (cur) blocks.push(cur); cur = null; docNo = ''; cust = ''; afterTitle = false; continue; }
      if (rr <= hr + 1) continue;
      var o = assignCols(heads, cs);
      if (!/^\d+\.?$/.test(cellText(o.seq))) continue;
      if (!cur) cur = { doNo: docNo, doDate: docDate, customer: cust, lines: [] };
      cur.lines.push({ row: rr, barcode: cellText(o.barcode), desc: cellText(o.desc), qty: typeof o.qty === 'number' ? o.qty : Number(cellText(o.qty).replace(/,/g, '')), qtyRaw: cellText(o.qty), spec: cellText(o.spec), uom: cellText(o.uom), batch: cellText(o.batch) });
    }
    if (cur) blocks.push(cur);
    return { kind: 'printed', blocks: blocks };
  }
  /** 用送货单补单位：每张 DO 找到条码+数量完全一样的一段，再逐行对应 */
  function supplement(lines, printed) {
    var byDo = {}, order = [], rep = { matched: 0, missingDo: [], blocks: printed.blocks.length };
    lines.forEach(function (l) { if (!byDo[l.doNo]) { byDo[l.doNo] = []; order.push(l.doNo); } byDo[l.doNo].push(l); });
    var sig = function (arr, bk) { return arr.map(function (x) { return (ldNorm(x[bk]) || x.desc) + '#' + Number(x.qty); }).sort().join(','); };
    var usedB = [];
    order.forEach(function (d) {
      var s = sig(byDo[d], 'barcode'), bi = -1;
      printed.blocks.forEach(function (b, i) { if (bi < 0 && !usedB[i] && (b.doNo === d || (!b.doNo && sig(b.lines, 'barcode') === s))) bi = i; });
      if (bi < 0) { rep.missingDo.push(d); return; }
      usedB[bi] = 1; rep.matched++;
      var pool = printed.blocks[bi].lines.slice();
      byDo[d].forEach(function (l) {
        var k = pool.findIndex(function (p) { return (ldNorm(p.barcode) || p.desc) === (ldNorm(l.barcode) || l.desc) && Number(p.qty) === Number(l.qty); });
        if (k < 0) return;
        var p = pool.splice(k, 1)[0];
        if (!l.uom) l.uom = p.uom; l.spec = p.spec; if (!l.batch) l.batch = p.batch;
      });
    });
    return rep;
  }

  // ---------- 上传电脑：上传 DO 页面 ----------
  function viewUpload() {
    document.body.classList.add('wide');            // 电脑屏幕：用整个宽度显示预览表
    // v1.5 两个模块：🚚 司机装车点货 / 📋 仓库拣货（各自上传、各自任务列表，资料分开）
    var UPM = LS.get('upMod', 'ld') === 'pk' ? 'pk' : 'ld', PKU = function () { return UPM === 'pk'; }, upW = function (h) { return ldW(h, UPM); };
    // v1.4.5 第二部分：任务列表（可删除）
    var TK = { list: null, err: '', busy: '', staff: [], sel: {}, who: LS.get('pkWho', ''), f: 'all' };
    function loadTasks() {
      var m = UPM;
      if (m === 'pk') return api({ action: 'pkAssignInfo' }, true).then(function (d) {      // v1.7 拣货：分配页
        if (m !== UPM) return; TK.list = d.tasks || []; TK.staff = d.staff || []; TK.err = '';
        var ok = {}; TK.list.forEach(function (t) { ok[t.id] = 1; }); Object.keys(TK.sel).forEach(function (k) { if (!ok[k]) delete TK.sel[k]; });
        draw();
      }, function (e) { if (m !== UPM) return; TK.err = e.network ? '网络不可用，任务列表没有更新' : e.message; draw(); });
      return api({ action: 'ldPortalTasks', mod: m }, true).then(function (d) { if (m !== UPM) return; TK.list = d.tasks || []; TK.err = ''; draw(); },
        function (e) { if (m !== UPM) return; TK.err = e.network ? '网络不可用，任务列表没有更新' : e.message; draw(); });
    }
    setInterval(function () { if (!document.hidden && $('#modal').hidden && !st.busy && !TK.busy) loadTasks(); }, 60000);
    /** v1.7 拣货：PDA 任务分配（每个任务 = 一张 DO；只给分配到的员工看） */
    function assignHtml() {
      var L = TK.list || [], ast = function (t) { return t.status === '已完成' ? '已完成' : !t.assignedTo ? '未分配' : t.status === '点货中' ? '拣货中' : '已分配'; };
      var ov = {}; TK.staff.forEach(function (n) { ov[n] = { a: 0, p: 0, d: 0 }; });
      var un = 0; L.forEach(function (t) { var a = ast(t); if (a === '未分配') { un++; return; } var o = ov[t.assignedTo] || (ov[t.assignedTo] = { a: 0, p: 0, d: 0 }); if (a === '已完成') o.d++; else if (a === '拣货中') o.p++; else o.a++; });
      var shown = L.filter(function (t) { return TK.f === 'all' || ast(t) === TK.f; }).sort(function (a, b) { return (ast(a) === '未分配' ? 0 : 1) - (ast(b) === '未分配' ? 0 : 1); });
      var nSel = Object.keys(TK.sel).length;
      return upW('<div class="card" id="tkCard"><div class="tkhead"><h3 style="margin:0">PDA 任务分配</h3><span class="hint">每个任务 = 一张 DO。只有分配到的员工在 PDA 上看得到；没分配的谁都看不到。</span><button class="tbtn" id="tkR">刷新</button></div>' +
        (TK.err ? '<p class="err">' + esc(TK.err) + '</p>' : '') +
        (!TK.list ? '<p class="hint">读取中…</p>' :
          '<div class="asov"><table class="uptab tktab"><thead><tr><th>员工（PDA 账户）</th><th class="n">已分配未开始</th><th class="n">拣货中</th><th class="n">已完成（14 天）</th></tr></thead><tbody>' +
          Object.keys(ov).map(function (n) { var o = ov[n]; return '<tr><td><b>' + esc(n) + '</b>' + (TK.staff.indexOf(n) < 0 ? ' <span class="hint">（已停用 / 没有拣货权限）</span>' : '') + '</td><td class="n">' + o.a + '</td><td class="n">' + o.p + '</td><td class="n">' + o.d + '</td></tr>'; }).join('') +
          '<tr class="asun"><td><b>未分配</b></td><td class="n" colspan="3"><b>' + un + '</b> 个任务</td></tr></tbody></table></div>' +
          '<div class="asbar"><span>筛选</span>' + [['all', '全部'], ['未分配', '未分配'], ['已分配', '已分配'], ['拣货中', '拣货中'], ['已完成', '已完成']].map(function (x) { return '<button class="tbtn' + (TK.f === x[0] ? ' on' : '') + '" data-af="' + x[0] + '">' + x[1] + '</button>'; }).join('') +
          '<span class="asgap"></span><span>已选 <b>' + nSel + '</b> 个</span><select id="asWho"><option value="">— 选择员工 —</option>' + TK.staff.map(function (n) { return '<option' + (n === TK.who ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select>' +
          '<button class="btn save" id="asGo"' + (!nSel || TK.busy ? ' disabled' : '') + '>分配给所选员工</button><button class="tbtn" id="asUn"' + (!nSel || TK.busy ? ' disabled' : '') + '>取消分配</button><button class="tbtn" id="asPr"' + (!nSel ? ' disabled' : '') + '>🖨 打印所选</button></div>' +
          (!shown.length ? '<p class="hint">没有任务。</p>' :
          '<div class="uptabw"><table class="uptab tktab astab"><thead><tr><th><input type="checkbox" id="asAll"' + (shown.some(function (t) { return t.status !== '已完成'; }) && shown.every(function (t) { return t.status === '已完成' || TK.sel[t.id]; }) ? ' checked' : '') + '></th><th>任务</th><th>DO</th><th>客户</th><th class="n">商品</th><th class="n">数量</th><th>状态</th><th>负责人</th><th></th></tr></thead><tbody>' +
          shown.map(function (t) {
            var a = ast(t), dis = t.status === '已完成';
            return '<tr class="' + (a === '未分配' ? 'asnone' : '') + '"><td>' + (dis ? '' : '<input type="checkbox" data-as="' + esc(t.id) + '"' + (TK.sel[t.id] ? ' checked' : '') + '>') + '</td><td><b>' + esc(t.id) + '</b><div class="hint">' + esc(t.created || t.date) + '</div></td><td>' + esc(t.dos) + '</td><td>' + esc(t.customer || '—') +
              '</td><td class="n">' + t.itemCount + '</td><td class="n">' + t.counted + ' / ' + t.required + '</td><td><span class="asst as-' + ({ '未分配': 'u', '已分配': 'a', '拣货中': 'p', '已完成': 'd' }[a]) + '">' + a + '</span></td><td>' + (t.assignedTo ? '<b>' + esc(t.assignedTo) + '</b><div class="hint">' + esc(t.assignedAt) + '</div>' : '<span class="hint">—</span>') +
              '</td><td class="tkacts"><button class="tbtn tkpr" data-pr="' + esc(t.id) + '" title="打印拣货单">🖨 打印</button>' + (dis ? '' : '<button class="tbtn tkdel" data-del="' + esc(t.id) + '"' + (TK.busy ? ' disabled' : '') + '>🗑</button>') + '</td></tr>';
          }).join('') + '</tbody></table></div>')) + '</div>');
    }
    function doAssign(who, confirm) {
      var ids = Object.keys(TK.sel); if (!ids.length) return;
      TK.busy = 'assign'; draw();
      api({ action: 'pkAssign', taskIds: ids, staff: who, confirm: !!confirm }, true).then(function (d) {
        TK.busy = '';
        if (d.status === 'confirm') {
          draw();
          return modal(upW('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>这些任务正在拣货</h3></div></div><ul class="tmiss-list">' +
            d.tasks.map(function (x) { return '<li class="bad"><span class="mk">!</span><span class="t"><b>' + esc(x.id) + '</b><span>' + esc(x.from) + ' 正在拣（已拣 ' + x.counted + ' / ' + x.required + '）</span></span></li>'; }).join('') +
            '</ul><p>' + (who ? '改派给 <b>' + esc(who) + '</b>' : '取消分配') + '后：已拣数量和记录<b>全部保留</b>，' + (who ? '新负责人接着拣' : '') + '；原来那台 PDA 不能再拣这个任务，它在改派前已经拣好、还没上传的记录照样会收下。<b>请先告诉原来的员工停下。</b></p>' +
            '<label style="display:block;margin:8px 0;font-weight:600"><input type="checkbox" id="asSure"> 我确认' + (who ? '改派' : '取消分配') + '</label><div class="row"><button class="btn ghost" id="asNo">取消</button><button class="btn save" id="asYes" disabled>确认</button></div></div>'), function (m) {
              var sure = $('#asSure', m), yes = $('#asYes', m);
              sure.onchange = function () { yes.disabled = !sure.checked; };
              $('#asNo', m).onclick = closeModal; yes.onclick = function () { closeModal(); doAssign(who, true); };
            });
        }
        if (d.status === 'ok') { TK.sel = {}; toast((who ? '已分配给 ' + who : '已取消分配') + '：' + d.changed + ' 个任务', 2500); if (d.skipped && d.skipped.length) infoBox('有些任务没有改', d.skipped.join('\n')); return loadTasks(); }
        draw(); infoBox('不能分配', d.message || '分配失败');
      }, function (e) { TK.busy = ''; draw(); infoBox('分配失败', e.network ? '网络不可用，请联网后再试' : e.message); });
    }
    function tasksHtml() {
      if (PKU()) return assignHtml();
      var L = TK.list;
      return upW('<div class="card" id="tkCard"><div class="tkhead"><h3 style="margin:0">装车任务管理</h3><span class="hint">不需要的任务可以在这里删除（删除后 PDA 不再显示）</span><button class="tbtn" id="tkR">刷新</button></div>' +
        (TK.err ? '<p class="err">' + esc(TK.err) + '</p>' : '') +
        (!L ? '<p class="hint">读取中…</p>' : !L.length ? '<p class="hint">现在没有装车任务。</p>' :
          '<div class="uptabw"><table class="uptab tktab"><thead><tr><th>任务</th><th>日期</th><th class="n">DO</th><th class="n">商品</th><th class="n">需求数量</th><th class="n">已点齐商品</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
          L.map(function (t) {
            var act = t.status === '已完成' ? '<span class="hint">已完成，只能办公室删除</span>' :
              '<button class="tbtn tkdel" data-del="' + esc(t.id) + '"' + (TK.busy ? ' disabled' : '') + '>' + (TK.busy === t.id ? '删除中…' : '🗑 删除') + '</button>';
            return '<tr><td><b>' + esc(t.id) + '</b><div class="hint">' + esc(t.created || '') + '</div></td><td>' + esc(t.date) + '</td><td class="n">' + t.doCount + (t.carry ? '<div class="hint">+之前 ' + t.carry + '</div>' : '') + '</td><td class="n">' + t.itemCount +
              '</td><td class="n">' + t.required + '</td><td class="n">' + t.okItems + ' / ' + t.itemCount + '</td><td>' + ldBadge(t.status) + (t.status === '已完成' && t.submittedBy ? '<div class="hint">' + esc(t.submittedBy) + '</div>' : '') + '</td><td>' + act + '</td></tr>';
          }).join('') + '</tbody></table></div>') + '</div>');
    }
    function askDelete(t, progress) {
      var prog = progress || t.status === '点货中';
      modal(upW('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>删除这个装车任务？</h3><div class="hint">' + esc(t.id) + ' · ' + esc(t.date) + ' · ' + esc(t.status) + '</div></div></div>' +
        '<p>删除后 <b>PDA 上不再显示这个任务</b>，也不能再点货。DO 和已有的点货记录会保留，办公室可以在看板恢复。</p>' +
        (prog ? '<div class="card upbad" style="margin:8px 0"><b>⚠ 这个任务正在点货</b>（已点 ' + t.counted + ' / ' + t.required + '）。删除后正在点货的 PDA 会停止，并显示“任务已被删除或取消”。' +
          '<label style="display:block;margin-top:8px;font-weight:600"><input type="checkbox" id="tkSure"> 我确认要删除正在点货的任务</label></div>' : '') +
        '<div class="row"><button class="btn ghost" id="tkNo">取消</button><button class="btn save" id="tkYes"' + (prog ? ' disabled' : '') + '>确认删除</button></div></div>'), function (m) {
          $('#tkNo', m).onclick = closeModal;
          var sure = $('#tkSure', m), yes = $('#tkYes', m);
          if (sure) sure.onchange = function () { yes.disabled = !sure.checked; };
          yes.onclick = function () {
            closeModal(); TK.busy = t.id; draw();
            api({ action: 'ldPortalDelete', taskId: t.id, confirmProgress: !!prog }, true).then(function (d) {
              TK.busy = '';
              if (d.status === 'confirm') { draw(); t.status = '点货中'; return askDelete(t, true); }
              if (d.status === 'deleted') { toast('已删除 ' + t.id + '（PDA 上不再显示）', 3000); return loadTasks(); }
              draw(); infoBox('不能删除', d.message || '删除失败');
            }, function (e) { TK.busy = ''; draw(); infoBox('删除失败', e.network ? '网络不可用，请联网后再试' : e.message); });
          };
        });
    }
    function infoBox(title, text) {
      modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>' + esc(title) + '</h3></div></div><p>' + esc(text) + '</p><div class="row"><button class="btn save" id="ibOk2">知道了</button></div></div>', function (m) { $('#ibOk2', m).onclick = closeModal; });
    }
    function newSt() { return { files: [], lines: null, errors: [], warns: [], infos: [], carry: null, pick: {}, busy: false, done: null, importId: uuid(), fileName: '' }; }
    var st = newSt();
    function readFiles(list) {
      st.done = null; st.lines = null; st.all = null; st.used = null; st.errors = []; st.warns = []; st.infos = []; st.importId = uuid();
      var arr = Array.prototype.slice.call(list || []);
      if (!arr.length) return draw();
      st.fileName = arr.map(function (f) { return f.name; }).join(' + ');
      draw('读取中…');
      Promise.all(arr.map(function (f) {
        if (/\.xls$/i.test(f.name)) return Promise.reject(new Error(f.name + '：是旧版 .xls，请在 AutoCount 导出为 .xlsx'));
        if (/\.pdf$/i.test(f.name)) {          // v1.7 送货单 PDF（只用于仓库拣货）
          return f.arrayBuffer().then(parsePdf).then(function (pr) { return { name: f.name, listing: null, printed: pr }; }, function (e) { throw new Error(f.name + '：读不了这个 PDF（' + e.message + '）'); });
        }
        return f.arrayBuffer().then(xlsxRead).then(function (sh) { return { name: f.name, listing: parseListing(sh), printed: parsePrinted(sh) }; });
      })).then(function (res) {
        var L = res.filter(function (x) { return x.listing; }), P = res.filter(function (x) { return !x.listing && x.printed; });
        if (PKU()) return readPicking(res, L, P);
        readLoading(res, L, P);
      }, function (e) { st.errors.push(e.message); draw(); });
    }
    /** v1.9.9 装车：DO Listing（可以多份）、送货单 PDF（一个文件可以好几张 DO）、送货单 Excel 一起选；
     *  全部 DO 先放进“待建任务”的 DO 池，勾选哪些 DO 放进这次装车任务（剩下的可以接着建下一个任务） */
    function readLoading(res, L, P) {
      var lines = [], dosSeen = {}, cust = {};
      res.forEach(function (x) { if (!x.listing && !x.printed) st.errors.push(x.name + '：认不出格式（需要 Delivery Order Detail Listing、送货单 Excel 或送货单 PDF）'); });
      var add = function (doNo, src, ls) {
        if (dosSeen[doNo] && dosSeen[doNo] !== src) { st.warns.push('DO ' + doNo + ' 在 ' + dosSeen[doNo] + ' 和 ' + src + ' 里都有：只用 ' + dosSeen[doNo] + ' 的，' + src + ' 里的这张没有算进去'); return false; }
        dosSeen[doNo] = src; ls.forEach(function (l) { lines.push(l); }); return true;
      };
      L.forEach(function (x) {
        if (x.listing.extra.length) st.infos.push(x.name + ' 没用到的列：' + x.listing.extra.join('、'));
        var g = {}, order = [];
        x.listing.lines.forEach(function (l) { l.file = x.name; if (!g[l.doNo]) { g[l.doNo] = []; order.push(l.doNo); } g[l.doNo].push(l); if (l.customer && !cust[l.doNo]) cust[l.doNo] = l.customer; });
        order.forEach(function (d) { add(d, x.name, g[d]); });
      });
      var listingLines = lines.slice();
      P.forEach(function (x) {
        if (!x.printed.pdf) {        // 送货单 Excel：只用来补单位 / 规格 / 批次号（Excel 送货单只有第一张 DO 印了单号，不能单独建任务）
          if (!L.length) { st.errors.push('需要 AutoCount 的「Delivery Order Detail Listing」（每行带 DO 号和条码 / Item Code），或送货单 PDF。只有送货单 Excel 不能建任务，因为送货单 Excel 里只有第一张 DO 有单号。'); return; }
          var rep = supplement(listingLines, x.printed);
          st.infos.push(x.name + '：送货单 ' + rep.blocks + ' 段，对上 ' + rep.matched + ' 张 DO（补上单位 / 规格 / 批次号）');
          if (rep.missingDo.length) st.warns.push('这些 DO 在送货单里没找到对应的一段，单位会是空的：' + rep.missingDo.join('、'));
          return;
        }
        if (x.printed.noChinese) { st.errors.push(x.name + '：这个 PDF 里没有中文（品名、单位都读不到）。请在 AutoCount 用「打印 → Microsoft Print to PDF」另存为 PDF 再上传。'); return; }
        var bl = x.printed.blocks.filter(function (b) { return b.lines.length; });
        if (!bl.length) { st.errors.push(x.name + '：送货单里没有商品行'); return; }
        bl.forEach(function (b, bi) {
          var doNo = b.doNo || (bi ? x.name.replace(/\.(xlsx|pdf)$/i, '') + ' 第' + (bi + 1) + '张（单号未印）' : '');
          if (!doNo) { st.errors.push(x.name + '：认不出 DO 单号（单据编号）'); return; }
          if (!b.doNo) st.warns.push(x.name + ' 第 ' + (bi + 1) + ' 张没有印单号，暂时叫“' + doNo + '”');
          if (add(doNo, x.name, b.lines.map(function (l) { return { row: l.row, file: x.name, doNo: doNo, doDate: b.doDate || '', itemCode: '', desc: l.desc, barcode: l.barcode, qty: l.qty, qtyRaw: l.qtyRaw, uom: l.uom, spec: l.spec, batch: l.batch, pdf: !!x.printed.pdf }; })) && b.customer && !cust[doNo]) cust[doNo] = b.customer;
        });
      });
      if (!L.length && !P.length && !st.errors.length) st.errors.push('需要 AutoCount 的「Delivery Order Detail Listing」，或送货单 PDF / Excel');
      if (st.errors.length) return draw();
      if (!lines.length) { st.errors.push('文件里没有商品行'); return draw(); }
      st.customers = cust; st.multi = res.length > 1; st.baseWarns = st.warns.slice(); st.all = lines; st.sel = {};
      Object.keys(dosSeen).forEach(function (d) { st.sel[d] = true; });
      ldApplySel(); draw(); loadCarry();
    }
    /** 勾选的 DO → 这次要建任务的行 */
    function ldApplySel() { st.lines = (st.all || []).filter(function (l) { return st.sel[l.doNo]; }); pkCheck(); }
    function ldPoolDos() {
      var o = [], m = {};
      (st.all || []).forEach(function (l) {
        var x = m[l.doNo]; if (!x) { x = m[l.doNo] = { doNo: l.doNo, cust: (st.customers || {})[l.doNo] || '', file: l.file || '', n: 0, q: {} }; o.push(x); }
        x.n++; var u = l.uom || ''; x.q[u] = Math.round(((x.q[u] || 0) + (+l.qty || 0)) * 1000) / 1000;
      });
      return o;
    }
    /** v1.6 仓库拣货：送货单（每张 DO 一个文件，可多选）和 / 或 DO Listing（带 Batch No.）都能建任务 */
    function readPicking(res, L, P) {
      var lines = [], names = {}, dosSeen = {};
      res.forEach(function (x) { if (!x.listing && !x.printed) st.errors.push(x.name + '：认不出格式（需要 AutoCount 送货单，或带 Batch No. 的 Delivery Order Detail Listing）'); });
      L.forEach(function (x) {
        if (!x.listing.hasBatch) { st.errors.push(x.name + '：DO Listing 没有「Batch No.」（批次号）列——库位是从批次号里读出来的。请加上 Batch No. 列再导出，或改用送货单。'); return; }
        if (x.listing.extra.length) st.infos.push(x.name + ' 没用到的列：' + x.listing.extra.join('、'));
        x.listing.lines.forEach(function (l) { l.file = x.name; lines.push(l); });
      });
      st.customers = {};
      P.forEach(function (x) {
        if (x.printed.noChinese) { st.errors.push(x.name + '：这个 PDF 里没有中文（品名、单位都读不到）。请在 AutoCount 用「打印 → Microsoft Print to PDF」另存为 PDF 再上传。'); return; }
        var bl = x.printed.blocks.filter(function (b) { return b.lines.length; });
        if (!bl.length) { st.errors.push(x.name + '：送货单里没有商品行'); return; }
        if (bl.length > 1 && bl.some(function (b) { return !b.doNo; })) st.warns.push(x.name + '：一个文件里有 ' + bl.length + ' 张 DO，有的没印单号。建议每张 DO 单独导出一个文件。');
        bl.forEach(function (b, bi) {
          var doNo = b.doNo || (bi ? x.name.replace(/\.xlsx$/i, '') + ' 第' + (bi + 1) + '张（单号未印）' : '');
          if (!b.doNo && !bi) { st.errors.push(x.name + '：认不出 DO 单号（单据编号）'); return; }
          if (dosSeen[doNo]) st.warns.push('DO ' + doNo + ' 在 ' + dosSeen[doNo] + ' 和 ' + x.name + ' 里都有，会相加，请确认不是重复的文件');
          dosSeen[doNo] = x.name;
          if (b.customer) st.customers[doNo] = b.customer;
          b.lines.forEach(function (l) { lines.push({ row: l.row, file: x.name, doNo: doNo, doDate: b.doDate || '', itemCode: '', desc: l.desc, barcode: l.barcode, qty: l.qty, qtyRaw: l.qtyRaw, uom: l.uom, spec: l.spec, batch: l.batch, pdf: !!x.printed.pdf }); });
        });
        names[x.name] = 1;
      });
      if (!L.length && !P.length && !st.errors.length) st.errors.push('需要 AutoCount 送货单（每张 DO 一个 Excel，可以一次选多个），或带 Batch No. 的 Delivery Order Detail Listing');
      if (st.errors.length) return draw();
      if (P.length) st.infos.push('送货单 ' + P.length + ' 个文件' + (P.some(function (x) { return x.printed.pdf; }) ? '（含 PDF）' : ''));
      if (!lines.length) { st.errors.push('文件里没有商品行'); return draw(); }
      st.multi = res.length > 1; st.baseWarns = st.warns.slice(); st.lines = lines; st.carry = [];
      pkCheck(); draw(); pkResolve();
    }
    /** v1.8 预览也用系统库位（仓管核实过的优先；没有才用批次号里的 AutoCount 库位） */
    function pkResolve() {
      var L0 = st.lines; if (!L0 || !L0.length) return;
      api({ action: 'lmResolve', lines: L0.map(function (l) { return { batch: l.batch, desc: l.desc, barcode: l.barcode }; }) }, true).then(function (d) {
        if (st.lines !== L0) return;
        (d.list || []).forEach(function (f, i) { if (L0[i]) L0[i].fix = f; });
        var n = L0.filter(function (l) { return l.fix && l.fix.corrected; }).length;
        if (n) st.infos.push(n + ' 行用了系统里更正过的库位（和 AutoCount 批次号里的不一样）');
        draw();
      }, function () { });
    }
    /** v1.7 拣货：逐行检查（上传前可以在“需要确认 / 修正的行”里改，改完重新检查） */
    function pkCheck() {
      var lines = st.lines || [], warns = (st.baseWarns || []).slice(), errs = [];
      var at = function (l) { return (st.multi ? l.file + ' ' : (l.pdf ? 'PDF ' : 'Excel ')) + '第 ' + l.row + ' 行'; };
      var noUom = lines.filter(function (l) { return !l.uom; }).length;
      if (noUom) warns.push(noUom + ' 行没有单位（UOM）');
      var seen = {};
      lines.forEach(function (l) {
        var e = [], w = [];
        if (!l.doNo) e.push('缺 DO 号'); if (!l.barcode && !l.desc && !l.itemCode) e.push('缺条码 / 品名');
        if (!(l.qty > 0)) e.push('数量不对（' + (l.qtyRaw || '空') + '）');
        if (l.barcode && !/^\d{6,14}$/.test(l.barcode)) w.push('条码不是 6–14 位数字');
        if (!l.barcode && !l.itemCode && l.desc) w.push('没有条码，PDA 上只能按品名搜索');
        if (!l.uom) w.push('没有单位');
        var k = [l.doNo, l.itemCode, l.barcode, l.desc, l.batch, l.qty, l.uom].join('|');
        if (seen[k]) w.push('和第 ' + seen[k] + ' 行完全一样，会相加'); else seen[k] = l.row;
        l._e = e; l._w = w;
        if (e.length) errs.push(at(l) + '：' + e.join('，'));
        w.forEach(function (x) { if (x !== '没有单位') warns.push(at(l) + '（' + l.doNo + ' ' + l.desc + '）' + x); });
      });
      var noB = [], noL = [];
      if (PKU()) lines.forEach(function (l) { var x = pkLoc(l.batch); if (x.flag) (l.batch ? noL : noB).push((st.multi ? l.file + ' ' : '') + '第 ' + l.row + ' 行 ' + l.desc + (l.batch ? '（' + l.batch + '：' + x.flag + '）' : '')); });
      if (noB.length) warns.push(noB.length + ' 行没有批次号，PDA 上会排在最后（标黄）：' + noB.join('；'));
      if (noL.length) warns.push(noL.length + ' 行批次号读不出库位，PDA 上会标黄：' + noL.join('；'));
      st.lineErrs = errs; st.warns = warns;
    }
    /** 需要确认 / 修正的行（PDF 或 Excel）：条码、品名、数量、单位可以直接改 */
    function fixHtml() {
      var bad = (st.lines || []).map(function (l, i) { return { l: l, i: i }; }).filter(function (x) { return (x.l._e && x.l._e.length) || (x.l._w && x.l._w.length); });
      if (!bad.length) return '';
      return '<div class="card upwarn" id="fixCard"><h3 style="margin-top:0">需要确认 / 修正的行（' + bad.length + '）</h3><p class="hint">红色的必须改好才能上传；黄色的请核对。改完点别处会自动重新检查。</p>' +
        '<div class="uptabw"><table class="uptab fixtab"><thead><tr><th>行</th><th>DO</th><th>条码</th><th>品名</th><th class="n">数量</th><th>单位</th><th>问题</th></tr></thead><tbody>' +
        bad.map(function (x) {
          var l = x.l, inp = function (k, v, w) { return '<input data-fix="' + x.i + '" data-k="' + k + '" value="' + esc(v == null ? '' : v) + '" style="width:' + w + '">'; };
          return '<tr class="' + (l._e.length ? 'fixbad' : 'fixwarn') + '"><td class="hint">' + esc((st.multi ? l.file + ' ' : '') + l.row) + '</td><td>' + esc(l.doNo) + '</td><td>' + inp('barcode', l.barcode, '130px') + '</td><td>' + inp('desc', l.desc, '220px') +
            '</td><td class="n">' + inp('qty', l.qty > 0 ? l.qty : l.qtyRaw, '60px') + '</td><td>' + inp('uom', l.uom, '50px') + '</td><td class="hint">' + esc(l._e.concat(l._w).join('；')) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }
    function loadCarry() {
      if (PKU()) { st.carry = []; return draw(); }       // 拣货没有“之前未装”
      api({ action: 'ldCarry' }, true).then(function (d) { st.carry = d.items || []; st.carry.forEach(function (c) { if (st.pick[c.ref] === undefined) st.pick[c.ref] = true; }); draw(); },
        function (e) { st.carry = []; st.warns.push('读不到之前未装的商品：' + e.message); draw(); });
    }
    function merged() {
      var m = {}, order = [];
      (st.lines || []).forEach(function (l) {
        var k = (PKU() ? l.doNo + '#' : '') + ldLineKey(l, PKU());        // v1.7 拣货每张 DO 一个任务：只在同一张 DO 里合并
        if (!m[k]) { m[k] = { k: k, code: l.itemCode, desc: l.desc, uom: l.uom, spec: l.spec || '', batch: l.batch || '', bc: [], qty: 0, src: [], i: order.length, fix: l.fix }; order.push(k); }
        var it = m[k]; it.qty = Math.round((it.qty + l.qty) * 1000) / 1000; it.src.push(l.doNo + '×' + l.qty);
        if (l.desc && (' / ' + it.desc + ' / ').indexOf(' / ' + l.desc + ' / ') < 0) it.desc += ' / ' + l.desc;     // v1.9.10 同一个条码、不同口味：品名都写上
        if (l.barcode && it.bc.indexOf(l.barcode) < 0) it.bc.push(l.barcode);
      });
      var out = order.map(function (k) { return m[k]; });
      if (PKU()) out.forEach(function (it) { var x = pkLoc(it.batch), f = it.fix; if (f && f.corrected) { x = { loc: f.loc, key: f.key, flag: '' }; it.note = f.ac ? 'AutoCount 是 ' + f.ac : 'AutoCount 没有库位'; } if (f && f.others && f.others.length) it.note = (it.note ? it.note + '；' : '') + '另有 ' + f.others.join(' / '); it.loc = x.loc; it.key = x.key; it.flag = x.flag; });
      if (PKU()) out.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i; });    // 和 PDA 一样的库位顺序
      return out;
    }
    /** v1.8 打印拣货单：每张 DO 一页，内容和送货单一样（原序号、批次号、条码、品名、数量、规格、单位），只是按 PDA 的库位顺序排；样式和送货单明显不同 */
    function printPick() {
      var items = merged(), pos = {};
      items.forEach(function (it, i) { pos[it.k] = { i: i, loc: it.loc, note: it.note }; });
      var dos = {}, order = [];
      st.lines.forEach(function (l, li) { if (!dos[l.doNo]) { dos[l.doNo] = []; order.push(l.doNo); } dos[l.doNo].push({ l: l, li: li, n: dos[l.doNo].length + 1, p: pos[l.doNo + '#' + ldLineKey(l, true)] || { i: 9e9, loc: '' } }); });   // n = 这张 DO 的第几行（= 送货单序号）
      printDocs(order.map(function (d) {
        var rows = dos[d].sort(function (a, b) { return a.p.i - b.p.i || a.li - b.li; });
        return { doNo: d, customer: st.customers && st.customers[d] || '', date: String(rows[0].l.doDate || '').replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3/$2/$1'),
          rows: rows.map(function (x) { var l = x.l; return { loc: x.p.loc || '', note: x.p.note || '', row: x.n, batch: l.batch, barcode: l.barcode, desc: l.desc, qty: l.qty, spec: l.spec, uom: l.uom }; }) };
      }));
    }
    /** v1.8 任务列表里随时打印（从系统读回这几个任务的 DO） */
    function printTasks(ids) {
      if (!ids.length) return;
      toast('准备拣货单…', 1500);
      api({ action: 'pkPrint', taskIds: ids }, true).then(function (d) {
        if (!d.docs || !d.docs.length) return infoBox('没有资料', '这些任务找不到送货单明细');
        printDocs(d.docs);
      }, function (e) { infoBox('打印不了', e.network ? '没有网络' : e.message); });
    }
    /** 每张 DO 一页：内容和送货单一样（原序号、批次号、条码、品名、数量、规格、单位），只是按 PDA 的库位顺序排；样式和送货单明显不同 */
    /** v1.9.8 打印前选语言：中文 / 缅甸语（品名、库位号不翻；规格、单位、表头都翻） */
    function printDocs(docs) {
      modal('<div class="tmiss"><h3>拣货单用哪种语言？</h3><p class="hint">缅甸语版：品名和库位号保持原样，规格、单位、表头都是缅甸语。</p>' +
        '<div class="row"><button class="btn ghost" id="ppZh">中文</button><button class="btn save" id="ppMy">မြန်မာ（缅甸语）</button></div></div>', function (m) {
          $('#ppZh', m).onclick = function () { closeModal(); LS.set('ppLang', 'zh'); printDocsL(docs, false); };
          $('#ppMy', m).onclick = function () { closeModal(); LS.set('ppLang', 'my'); printDocsL(docs, true); };
        });
    }
    var PP_MY = { '拣 货 单': 'ပစ္စည်းထုတ်စာရင်း', 'PICKING LIST · 仓库内部用 · 不是送货单，不随货': 'PICKING LIST · ဂိုဒေါင်တွင်းသုံး · ပို့ဆောင်စာ မဟုတ်ပါ၊ ပစ္စည်းနှင့်အတူ မပို့ရ',
      '按库位顺序': 'စင်နေရာ အစီအစဉ်အတိုင်း', 'DO 号': 'DO နံပါတ်', '日期': 'ရက်စွဲ', '客户': 'ဖောက်သည်', '行数': 'အကြောင်းရေ', '行': 'ကြောင်း', '合计': 'စုစုပေါင်း', '打印': 'ပုံနှိပ်ချိန်',
      '库位': 'စင်နေရာ', '原序号': 'မူလ အမှတ်', '批次号': 'အသုတ်နံပါတ်', '条码': 'ဘားကုဒ်', '商品名称': 'ပစ္စည်းအမည်', '数量': 'အရေအတွက်', '规格': 'ထုပ်ပိုးပုံ', '单位': 'ယူနစ်',
      '没有库位': 'စင်နေရာ မရှိ', '拣货人': 'ထုတ်သူ', '复核人': 'ပြန်စစ်သူ', '第': 'စာမျက်နှာ', '张': '' };
    /** 规格 / 单位 → 缅甸语：1箱=12瓶 → 1 သေတ္တာ = 12 ပုလင်း（“提”另外翻；只换单位字，数字和 KG/ML 不动） */
    var PP_UNIT = { '提': 'တွဲ', '单': 'တစ်ခုချင်း' };
    function ppUnitMy(v) {
      v = String(v || ''); if (!v) return '';
      Object.keys(PP_UNIT).forEach(function (k) { v = v.split(k).join(' ' + PP_UNIT[k] + ' '); });
      v = myText(v);
      return v.replace(/\s*=\s*/g, ' = ').replace(/\s*\*\s*/g, ' × ').replace(/(\d)(?=[\u1000-\u109f])/g, '$1 ').replace(/\s+/g, ' ').trim();
    }
    function printDocsL(docs, my) {
      var L = function (k) { return my && PP_MY[k] != null ? PP_MY[k] : k; }, U = function (v) { return my ? ppUnitMy(v) : String(v || ''); };
      var now = new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16).split(' ');
      var printed = now[0].split('-').reverse().join('/') + ' ' + now[1];
      var html = docs.map(function (D, di) {
        var units = {}, prevLoc = null;
        D.rows.forEach(function (x) { units[x.uom || ''] = Math.round(((units[x.uom || ''] || 0) + (+x.qty || 0)) * 1000) / 1000; });
        return '<section class="pps">' +
          '<div class="pph"><div class="ppt">' + L('拣 货 单') + '<small>' + L('PICKING LIST · 仓库内部用 · 不是送货单，不随货') + '</small></div><div class="ppn">' + L('按库位顺序') + '</div></div>' +
          '<table class="ppi"><tr><td>' + L('DO 号') + '</td><td><b>' + esc(D.doNo) + '</b></td><td>' + L('日期') + '</td><td>' + esc(D.date || '') + '</td></tr>' +
          '<tr><td>' + L('客户') + '</td><td colspan="3"><b>' + esc(D.customer || '—') + '</b></td></tr>' +
          '<tr><td>' + L('行数') + '</td><td>' + D.rows.length + ' ' + L('行') + ' · ' + L('合计') + ' ' + Object.keys(units).map(function (u) { return units[u] + ' ' + esc(U(u)); }).join(' · ') + '</td><td>' + L('打印') + '</td><td>' + esc(printed) + (D.task ? ' · ' + esc(D.task) : '') + '</td></tr></table>' +
          '<table class="ppl' + (my ? ' ppmy' : '') + '"><thead><tr><th class="c">✓</th><th>' + L('库位') + '</th><th class="c2">' + L('原序号') + '</th><th>' + L('批次号') + '</th><th>' + L('条码') + '</th><th>' + L('商品名称') + '</th><th class="n">' + L('数量') + '</th><th>' + L('规格') + '</th><th>' + L('单位') + '</th></tr></thead><tbody>' +
          D.rows.map(function (x) {
            var loc = x.loc || '', same = loc === prevLoc; prevLoc = loc;
            return '<tr class="' + (same ? 'same' : 'newloc') + '"><td class="c"><span class="ppbox"></span></td><td class="pploc"><b>' + esc(loc || L('没有库位')) + '</b>' + (x.note ? '<div class="ppnote">' + esc(my ? myText(x.note) : x.note) + '</div>' : '') + '</td>' +
              '<td class="c2">' + esc(x.row || '') + '</td><td>' + esc(x.batch || '') + '</td><td>' + esc(x.barcode || '') + '</td><td>' + esc(x.desc || '') + '</td><td class="n"><b>' + esc(x.qty) + '</b></td><td class="ppspec">' + esc(U(x.spec)) + '</td><td class="ppuom">' + esc(U(x.uom)) + '</td></tr>';
          }).join('') + '</tbody></table>' +
          '<div class="ppf"><span>' + L('拣货人') + '：________________</span><span>' + L('复核人') + '：________________</span><span>DO ' + esc(D.doNo) + ' · ' + L('第') + ' ' + (di + 1) + ' / ' + docs.length + ' ' + L('张') + '</span></div></section>';
      }).join('');
      var box = $('#printArea'); if (!box) { box = document.createElement('div'); box.id = 'printArea'; document.body.appendChild(box); }
      box.innerHTML = html; document.body.classList.add('printing');
      var done = function () { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      setTimeout(function () { try { window.print(); } catch (e) { } setTimeout(done, 1500); }, 50);
    }
    function upload(force) {
      if (st.busy) return;
      st.busy = true; draw();
      var refs = Object.keys(st.pick).filter(function (k) { return st.pick[k] && (st.carry || []).some(function (c) { return c.ref === k; }); });
      var useDos = {}; st.lines.forEach(function (l) { useDos[l.doNo] = 1; });
      api({ action: 'ldImport', mod: UPM, importId: st.importId, fileName: st.fileName, force: !!force, carry: PKU() ? [] : refs, customers: st.customers || {},
        lines: st.lines.map(function (l) { return { doNo: l.doNo, doDate: l.doDate, itemCode: l.itemCode, desc: l.desc, barcode: l.barcode, qty: l.qty, uom: l.uom, spec: l.spec || '', batch: l.batch || '', fromDoc: l.fromDoc }; }) }, true)
        .then(function (d) {
          st.busy = false;
          if (d.status === 'created' || d.status === 'duplicate') { st.done = d; st.used = st.used || {}; Object.keys(useDos).forEach(function (k) { st.used[k] = 1; }); beep(); draw(); return loadTasks(); }
          if (d.status === 'dupDO') {
            draw();
            return modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>这些 DO 已经上传过</h3></div></div><ul class="tmiss-list">' +
              d.dos.map(function (x) { return '<li class="bad"><span class="mk">!</span><span class="t"><b>' + esc(x.doNo) + '</b><span>已在任务 ' + esc(x.task) + '</span></span></li>'; }).join('') +
              '</ul><p>确定还要再建一个任务吗？（通常是重复上传，选“取消”）</p><div class="row"><button class="btn ghost" id="dupNo">取消</button><button class="btn save" id="dupYes">仍然上传</button></div></div>', function (m) {
                $('#dupNo', m).onclick = closeModal; $('#dupYes', m).onclick = function () { closeModal(); upload(true); };
              });
          }
          st.errors = (d.errors || [d.message || '上传失败']).concat(d.errorCount > 30 ? ['…共 ' + d.errorCount + ' 个问题'] : []); draw();
        }, function (e) { st.busy = false; st.errors = ['上传失败：' + (e.network ? '网络不可用，请检查网络后再点上传' : e.message)]; draw(); });
    }
    function draw(note) {
      setBar(upW('装车点货 · 上传 DO / 任务管理'), false);
      var items = st.lines ? merged() : [], dos = {}, units = {};
      (st.lines || []).forEach(function (l) { dos[l.doNo] = 1; });
      items.forEach(function (it) { var u = it.uom || '（无单位）'; units[u] = Math.round(((units[u] || 0) + it.qty) * 1000) / 1000; });
      var picked = (st.carry || []).filter(function (c) { return st.pick[c.ref]; });
      var h = '';
      if (st.done) {
        if (PKU() && st.done.taskIds) h = '<div class="card upok"><div class="upok-ic">✓</div><h2>已建立 ' + st.done.taskIds.length + ' 个拣货任务</h2><p>' +
          (st.done.status === 'duplicate' ? '（这些文件刚才已经上传过，没有重复建立）' : 'DO ' + st.done.doCount + ' 张 · ' + st.done.lineCount + ' 行 · 每张 DO 一个任务') + '</p><p><b>' + esc(st.done.taskIds.join('、')) + '</b></p>' +
          (st.done.badLoc ? '<p class="err">其中 ' + st.done.badLoc + ' 项批次号没有库位 / 格式异常，PDA 上排在最后并标黄。</p>' : '') +
          '<p class="hint">还没分配的任务 PDA 上看不到 —— 请在下面「PDA 任务分配」里勾选、分配给员工。</p>' + (st.lines ? '<button class="tbtn" id="upPrint">🖨 打印拣货单</button> ' : '') + '<button class="btn save" id="upNew">上传下一个</button></div>';
        else h = '<div class="card upok"><div class="upok-ic">✓</div><h2>已建立装车任务 ' + esc(st.done.taskId) + '</h2><p>' +
          (st.done.status === 'duplicate' ? '（这个文件刚才已经上传过，没有重复建立）' : 'DO ' + st.done.doCount + ' 张 · ' + st.done.lineCount + ' 行 · 商品 ' + st.done.itemCount + ' 项' + (st.done.carryCount ? '（含之前未装 ' + st.done.carryCount + ' 项）' : '')) +
          '</p>' + (st.done.badLoc ? '<p class="err">其中 ' + st.done.badLoc + ' 项批次号没有库位 / 格式异常，PDA 上排在最后并标黄。</p>' : '') +
          '<p class="hint">PDA 打开「🚚 装车点货」就能看到这个任务。</p>' + (function () {
            var rest = ldPoolDos().filter(function (x) { return !(st.used || {})[x.doNo]; });
            return rest.length ? '<div class="card upwarn" style="text-align:left"><b>刚才上传的文件里还有 ' + rest.length + ' 张 DO 没建任务：</b><p class="hint">' + esc(rest.map(function (x) { return x.doNo + (x.cust ? '（' + x.cust + '）' : ''); }).join('、')) + '</p>' +
              '<button class="btn save" id="upRest">用剩下的 DO 再建一个装车任务</button></div>' : '';
          })() + '<button class="btn ' + (st.all && ldPoolDos().some(function (x) { return !(st.used || {})[x.doNo]; }) ? 'ghost' : 'save') + '" id="upNew">上传新的文件</button></div>';
      } else {
        h = '<div class="card"><h3 style="margin-top:0">' + (PKU() ? '选择 AutoCount 送货单（Excel 或 PDF）' : '选择 AutoCount 导出的文件（Excel 或 PDF，可多选）') + '</h3>' +
          '<ol class="hint upsteps">' + (PKU() ? '<li><b>送货单</b>（每张 DO 导出一个 Excel，可以一次选多个；需要有批次号、条码、数量）</li><li>或 <b>送货单 PDF</b>：在 AutoCount 用「打印 → Microsoft Print to PDF」另存（直接导出的 PDF 没有中文，不能用）</li><li>或 <b>Delivery Order Detail Listing（带 Batch No. 列）</b></li><li>批次号结尾就是库位，如 2701-AB-07-J01 → 07-J-01</li></ol>' :
            '<li><b>Delivery Order Detail Listing</b> Excel（每行有 DO 号、条码或 Item Code、数量），可以选好几份</li><li>或 <b>送货单 PDF</b>：在 AutoCount 用「打印 → Microsoft Print to PDF」另存，一个 PDF 里可以有好几张 DO，可以一次选很多个</li><li><b>送货单 Excel</b>（可选：和 Listing 一起选，自动补上单位 / 规格）</li><li>读完后在「这次装车放哪几张 DO」里勾选，剩下的 DO 可以接着建下一个任务</li></ol>') +
          '<button class="btn save upfile" id="upPick">📂 选择 Excel / PDF 文件（可多选）</button><input id="upF" class="vh" type="file" accept=".xlsx,.xls,.pdf" multiple tabindex="-1">' +
          (st.fileName ? '<p class="hint">已选：' + esc(st.fileName) + '</p>' : '') + (note ? '<p>' + esc(note) + '</p>' : '') + '</div>';
        if (st.errors.length) h += '<div class="card upbad"><b>不能上传：</b><ul>' + st.errors.slice(0, 40).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
        if (st.lines && !st.errors.length && !PKU() && st.all) {       // v1.9.9 DO 池：勾选这次装车放哪几张 DO
          var pool = ldPoolDos(), nSel = pool.filter(function (x) { return st.sel[x.doNo]; }).length;
          h += '<div class="card" id="dosCard"><h3 style="margin-top:0">这次装车放哪几张 DO？（已选 ' + nSel + ' / ' + pool.length + '）</h3>' +
            '<p><button class="tbtn" id="dosAll">全选</button> <button class="tbtn" id="dosNone">全不选</button> <span class="hint">没勾的 DO 先留着，建完这个任务后可以接着用它们建下一个</span></p>' +
            '<div class="uptabw"><table class="uptab"><thead><tr><th></th><th>DO</th><th>客户</th><th class="n">行</th><th>数量</th><th>文件</th></tr></thead><tbody>' +
            pool.map(function (x) {
              return '<tr><td><input type="checkbox" data-dos="' + esc(x.doNo) + '"' + (st.sel[x.doNo] ? ' checked' : '') + '></td><td><b>' + esc(x.doNo) + '</b></td><td>' + esc(x.cust || '—') + '</td><td class="n">' + x.n + '</td><td>' +
                esc(Object.keys(x.q).map(function (u) { return x.q[u] + ' ' + u; }).join(' · ')) + '</td><td class="hint">' + esc(x.file) + '</td></tr>';
            }).join('') + '</tbody></table></div></div>';
        }
        if (st.lines && !st.errors.length) {
          h += '<div class="card"><div class="upsum"><div><b>' + Object.keys(dos).length + '</b><span>张 DO</span></div><div><b>' + st.lines.length + '</b><span>行</span></div><div><b>' + items.length + '</b><span>个商品（合并后）</span></div>' +
            (PKU() ? '<div><b>' + items.filter(function (it) { return it.flag; }).length + '</b><span>没有库位</span></div>' : '<div><b>' + (st.carry ? picked.length : '…') + '</b><span>之前未装</span></div>') + '</div>' +
            '<p class="hint">需求合计：' + Object.keys(units).map(function (u) { return units[u] + ' ' + esc(u); }).join(' · ') + '</p>' +
            '<p class="hint">DO：' + esc(Object.keys(dos).map(function (d) { return d + (st.customers && st.customers[d] ? '（' + st.customers[d] + '）' : ''); }).join('、')) + '</p>' +
            (PKU() ? '<p><b>上传后每张 DO 生成一个拣货任务（共 ' + Object.keys(dos).length + ' 个），再在下面分配给员工。</b></p>' +
              '<p><button class="tbtn" id="upPrint"' + (st.lineErrs && st.lineErrs.length ? ' disabled' : '') + '>🖨 打印拣货单（' + Object.keys(dos).length + ' 张，按库位顺序）</button></p>' : '') + '</div>';
          if (st.lineErrs && st.lineErrs.length) h += '<div class="card upbad"><b>还不能上传（请在下面改好）：</b><ul>' + st.lineErrs.slice(0, 40).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
          h += fixHtml();
          if (st.warns.length) h += '<div class="card upwarn"><b>请注意：</b><ul>' + st.warns.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
          if (st.infos.length) h += '<details class="card"><summary>其他提示（' + st.infos.length + '）</summary><ul class="hint">' + st.infos.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></details>';
          if (st.carry && st.carry.length) h += '<div class="card"><h3 style="margin-top:0">之前没装上车的商品（打勾的会一起加进这次任务，注明原来的日期）</h3>' +
            '<p><button class="tbtn" id="cAll">全选</button> <button class="tbtn" id="cNone">全不选</button></p><table class="uptab"><thead><tr><th></th><th>原来日期</th><th>品名</th><th>Item Code</th><th>单位</th><th class="n">未装</th><th>任务</th></tr></thead><tbody>' +
            st.carry.map(function (c) {
              return '<tr><td><input type="checkbox" data-ref="' + esc(c.ref) + '"' + (st.pick[c.ref] ? ' checked' : '') + '></td><td><span class="ldold">' + esc(c.originDate) + '</span></td><td>' + esc(c.desc) +
                '</td><td>' + esc(c.code || c.bc) + '</td><td>' + esc(c.uom) + '</td><td class="n"><b>' + c.remain + '</b></td><td class="hint">' + esc(c.task) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
          h += '<div class="card"><h3 style="margin-top:0">合并后的商品清单（PDA 上看到的就是这张' + (PKU() ? '，按库位顺序' : '') + '）</h3><div class="uptabw"><table class="uptab"><thead><tr><th>#</th>' + (PKU() ? '<th>库位</th><th>批次号</th>' : '') + '<th>Item Code</th><th>条码</th><th>品名</th><th>单位</th><th>规格</th><th class="n">需求</th><th>来自 DO</th></tr></thead><tbody>' +
            items.map(function (it, i) {
              return '<tr' + (it.flag ? ' class="pkflagrow"' : '') + '><td class="hint">' + (i + 1) + '</td>' + (PKU() ? '<td><b>' + esc(it.loc || '—') + '</b>' + (it.flag ? '<div class="hint">' + esc(it.flag) + '</div>' : '') + (it.note ? '<div class="pkfix">📍 ' + esc(it.note) + '</div>' : '') + '</td><td>' + esc(it.batch) + '</td>' : '') + '<td>' + esc(it.code || '—') + '</td><td>' + esc(it.bc.join(' / ')) + '</td><td>' + esc(it.desc) + '</td><td>' + esc(it.uom) + '</td><td class="hint">' + esc(it.spec) +
                '</td><td class="n"><b>' + it.qty + '</b></td><td class="hint">' + esc(it.src.join('; ')) + '</td></tr>';
            }).join('') + '</tbody></table></div></div>';
          h += tasksHtml();
          h += '<div id="dock" class="dock"><button class="btn save" id="upGo"' + (st.busy || !st.carry || !st.lines.length || (st.lineErrs && st.lineErrs.length) ? ' disabled' : '') + '>' + (st.busy ? '上传中…' : '⬆ 上传并建立装车任务') + '</button></div>';
        }
      }
      if (!(st.lines && !st.errors.length && !st.done)) h += tasksHtml();
      app.innerHTML = '<div class="mods upmods">' + [['ld', '🚚 司机装车点货'], ['pk', '📋 仓库拣货']].map(function (x) { return '<button class="mod' + (UPM === x[0] ? ' on' : '') + '" data-um="' + x[0] + '"' + (st.busy ? ' disabled' : '') + '>' + x[1] + '</button>'; }).join('') + '</div>' + upW(h);
      Array.prototype.forEach.call(app.querySelectorAll('[data-um]'), function (b) {
        b.onclick = function () { if (st.busy || b.dataset.um === UPM) return; UPM = b.dataset.um; LS.set('upMod', UPM); st = newSt(); TK = { list: null, err: '', busy: '', staff: [], sel: {}, who: LS.get('pkWho', ''), f: 'all' }; draw(); loadTasks(); };
      });
      var tr = $('#tkR'); if (tr) tr.onclick = function () { TK.list = TK.list || null; loadTasks(); };
      // v1.7 拣货任务分配
      Array.prototype.forEach.call(app.querySelectorAll('[data-as]'), function (c) { c.onchange = function () { if (c.checked) TK.sel[c.dataset.as] = 1; else delete TK.sel[c.dataset.as]; draw(); }; });
      var aa = $('#asAll'); if (aa) aa.onchange = function () { Array.prototype.forEach.call(app.querySelectorAll('[data-as]'), function (c) { if (aa.checked) TK.sel[c.dataset.as] = 1; else delete TK.sel[c.dataset.as]; }); draw(); };
      Array.prototype.forEach.call(app.querySelectorAll('[data-af]'), function (b) { b.onclick = function () { TK.f = b.dataset.af; TK.sel = {}; draw(); }; });
      var aw = $('#asWho'); if (aw) aw.onchange = function () { TK.who = aw.value; LS.set('pkWho', TK.who); };
      var ag = $('#asGo'); if (ag) ag.onclick = function () { if (!TK.who) return infoBox('请选择员工', '先在右边选择要分配给哪个员工'); doAssign(TK.who); };
      var au = $('#asUn'); if (au) au.onclick = function () { doAssign(''); };
      var apr = $('#asPr'); if (apr) apr.onclick = function () { printTasks(Object.keys(TK.sel)); };
      Array.prototype.forEach.call(app.querySelectorAll('[data-pr]'), function (b) { b.onclick = function () { printTasks([b.dataset.pr]); }; });
      Array.prototype.forEach.call(app.querySelectorAll('[data-fix]'), function (inp) {
        inp.onchange = function () {
          var l = st.lines[+inp.dataset.fix], k = inp.dataset.k, v = inp.value.trim();
          if (k === 'qty') { l.qtyRaw = v; l.qty = Number(v.replace(/,/g, '')); } else if (k === 'barcode') l.barcode = v.replace(/\s+/g, ''); else l[k] = v;
          pkCheck(); draw();
        };
      });
      Array.prototype.forEach.call(app.querySelectorAll('[data-del]'), function (b) {
        b.onclick = function () { var t = (TK.list || []).filter(function (x) { return x.id === b.dataset.del; })[0]; if (t) askDelete(t, false); };
      });
      var f = $('#upF'); if (f) { f.onchange = function () { readFiles(f.files); f.value = ''; }; $('#upPick').onclick = function () { f.click(); }; }
      var n = $('#upNew'); if (n) n.onclick = function () { st = newSt(); draw(); };
      Array.prototype.forEach.call(app.querySelectorAll('[data-dos]'), function (c) { c.onchange = function () { st.sel[c.dataset.dos] = c.checked; ldApplySel(); draw(); }; });
      var da = $('#dosAll'), dn0 = $('#dosNone');
      if (da) da.onclick = function () { ldPoolDos().forEach(function (x) { st.sel[x.doNo] = true; }); ldApplySel(); draw(); };
      if (dn0) dn0.onclick = function () { st.sel = {}; ldApplySel(); draw(); };
      var ur = $('#upRest'); if (ur) ur.onclick = function () {         // 剩下的 DO 接着建下一个任务（不用重新选文件）
        var used = st.used || {}, o = st, ns = newSt();
        ns.all = o.all.filter(function (l) { return !used[l.doNo]; }); ns.customers = o.customers; ns.multi = o.multi; ns.fileName = o.fileName; ns.baseWarns = []; ns.sel = {};
        st = ns; ldApplySel(); draw(); loadCarry(); window.scrollTo(0, 0);
      };
      var pp = $('#upPrint'); if (pp) pp.onclick = printPick;
      var g = $('#upGo'); if (g) g.onclick = function () { upload(false); };
      Array.prototype.forEach.call(app.querySelectorAll('[data-ref]'), function (c) { c.onchange = function () { st.pick[c.dataset.ref] = c.checked; draw(); }; });
      var ca = $('#cAll'), cn = $('#cNone');
      if (ca) ca.onclick = function () { st.carry.forEach(function (c) { st.pick[c.ref] = true; }); draw(); };
      if (cn) cn.onclick = function () { st.carry.forEach(function (c) { st.pick[c.ref] = false; }); draw(); };
    }
    draw(); loadTasks();
  }

  // =====================================================================
  // v1.6 库位记录后台（Warehouse Location Records）：RC- 电脑链接打开，不用员工登录
  //   Shelf Transfer：就是表格里的【库位转移看板】（同一张表、同一套后台函数：已完成 / 有问题 / 重新打开 / 删除）
  //   Picking Location Discrepancy：PDA 拣货时扫的实际库位（只读）
  // =====================================================================
  /** 最小的 .xlsx 生成（不压缩的 zip + inlineStr），导出 Excel 用，不依赖外部库 */
  function xlsxBlob(sheetName, rows) {
    var enc = new TextEncoder(), xe = function (v) { return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); };
    var col = function (i) { var s = ''; i++; while (i) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>' +
      rows.map(function (r, ri) {
        return '<row r="' + (ri + 1) + '">' + r.map(function (v, ci) {
          var ref = col(ci) + (ri + 1);
          if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"><v>' + v + '</v></c>';
          return '<c r="' + ref + '" t="inlineStr"' + (ri === 0 ? ' s="1"' : '') + '><is><t xml:space="preserve">' + xe(v == null ? '' : v) + '</t></is></c>';
        }).join('') + '</row>';
      }).join('') + '</sheetData></worksheet>';
    var files = [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + xe(sheetName).slice(0, 31) + '" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
      ['xl/worksheets/sheet1.xml', sheet]];
    var crcT = xlsxBlob.t || (xlsxBlob.t = (function () { var t = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })());
    var crc = function (b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    var parts = [], central = [], off = 0;
    var u16 = function (v) { return [v & 255, (v >>> 8) & 255]; }, u32 = function (v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; };
    files.forEach(function (f) {
      var name = enc.encode(f[0]), data = enc.encode(f[1]), c = crc(data);
      var head = [].concat([0x50, 0x4b, 3, 4], u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(c), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(head), name, data);
      central.push(new Uint8Array([].concat([0x50, 0x4b, 1, 2], u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(c), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off))), name);
      off += head.length + name.length + data.length;
    });
    var cl = central.reduce(function (s, x) { return s + x.length; }, 0);
    var end = new Uint8Array([].concat([0x50, 0x4b, 5, 6], u16(0), u16(0), u16(files.length), u16(files.length), u32(cl), u32(off), u16(0)));
    return new Blob(parts.concat(central, [end]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function download(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  /** 日期框（yyyy-mm-dd，马来西亚时间 UTC+8）→ 毫秒；end = 当天最后一刻 */
  function myDay(v, end) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); if (!m) return null; return Date.UTC(+m[1], m[2] - 1, +m[3]) - 8 * 3600e3 + (end ? 864e5 - 1 : 0); }
  function myToday(dd) { var d = new Date(Date.now() + 8 * 3600e3 + (dd || 0) * 864e5); return d.toISOString().slice(0, 10); }
  function viewRecords() {
    setBar('Warehouse Location Records', false);
    document.body.classList.add('wide');
    var R = { tab: LS.get('rcTab', 'tr'), tr: null, pk: null, err: '', busy: false,
      trF: { status: '待处理', q: '', src: '', dst: '', from: myToday(-30), to: myToday(0), hist: '' },
      pkF: { res: '不一致', q: '', sys: '', act: '', from: myToday(-30), to: myToday(0) }, lmF: { st: 'all', q: '', loc: '' }, lmMsg: '', lm: null };
    function load(which) {
      R.err = '';
      var a = which === 'pk' ? 'rcPickLocs' : which === 'lm' ? 'rcLmList' : 'rcTransfers';
      return api({ action: a }, true).then(function (d) { R[which] = d; draw(); }, function (e) { R.err = e.network ? '网络不可用，请检查网络后点“刷新”' : e.message; draw(); });
    }
    function inRange(ts, f) { var a = myDay(f.from), b = myDay(f.to, true); return (a == null || ts >= a) && (b == null || ts <= b); }
    function has(v, q) { return !q || String(v || '').toUpperCase().indexOf(String(q).trim().toUpperCase()) >= 0; }
    function trRows() {
      var f = R.trF, all = (R.tr && R.tr.list) || [];
      if (f.hist) return all.filter(function (x) { return x.bc === f.hist; }).slice().sort(function (a, b) { return a.ts - b.ts; });
      return all.filter(function (x) { return (f.status === 'all' || x.status === f.status) && inRange(x.ts, f) && (has(x.bc, f.q) || has(x.item, f.q)) && has(x.src, f.src) && has(x.dst, f.dst); });
    }
    function pkRows() {
      var f = R.pkF, all = (R.pk && R.pk.list) || [];
      return all.filter(function (x) { return (f.res === 'all' || x.result === f.res) && inRange(x.ts, f) && (has(x.sku, f.q) || has(x.desc, f.q)) && has(x.sys, f.sys) && has(x.act, f.act); });
    }
    var big = function (v) { return v ? '<span class="rbig" data-cp="' + esc(v) + '" title="点击复制">' + esc(v) + '</span>' : '<span class="hint">— 不填</span>'; };
    var ST = { '待处理': 's1', '有问题': 's2', '已完成': 's3' };
    // ---- v1.8 上传入库单：新箱码绑定到 Item Code；Item Code 系统里没有 = 新品（建简单产品资料）。以入库单为准。
    var INB_KIND = { bind: ['新箱码绑定', 'k1'], change: ['改绑（以入库单为准）', 'k2'], new: ['新品', 'k3'], same: ['已经一样', 'k0'] };
    function inbHtml() {
      var I = R.inb || {}, h = '<div class="inb"><div class="inb-h"><b>📥 上传入库单</b><span class="hint">箱码自动绑定到 Item Code；Item Code 系统里没有的就是新品，自动建产品资料。PDA 移库扫这些箱码就认得。</span>' +
        '<button class="btn save" id="inbB"' + (I.busy ? ' disabled' : '') + '>📂 选择入库单 Excel（可多选）</button><input id="inbF" class="vh" type="file" accept=".xlsx" multiple tabindex="-1"></div>';
      var q = (R.inbQ || []).length;
      if ((R.inbLog && R.inbLog.length) || q) h += '<div class="inb-log">' + (R.inbN > 1 ? '<b>一共 ' + R.inbN + ' 个入库单：已写入 ' + (R.inbLog || []).length + ' 个' + (q ? '，还有 ' + q + ' 个排队' : '') + (R.inbAuto ? '（自动写入中…）' : '') + '</b>' : '') +
        '<ul class="hint">' + (R.inbLog || []).map(function (m) { return '<li>✓ ' + esc(m) + '</li>'; }).join('') + '</ul></div>';
      if (I.err && q) h += '<p><button class="tbtn" id="inbSkip">跳过这个文件，读下一个</button></p>';
      if (I.msg) h += '<p class="' + (I.err ? 'err' : 'hint') + '"><b>' + esc(I.msg) + '</b></p>';
      var d = I.res;
      if (d && !d.committed) {
        var c = d.counts, L = d.list.filter(function (x) { return I.all || x.kind !== 'same'; });
        h += '<div class="inb-sum">' + ['bind', 'change', 'new', 'same'].map(function (k) { return '<span class="inbk ' + INB_KIND[k][1] + '">' + INB_KIND[k][0] + ' <b>' + c[k] + '</b></span>'; }).join('') +
          (c.newItems ? '<span class="hint">（新品 ' + c.newItems + ' 个 Item Code）</span>' : '') + '</div>' +
          (d.errors.length ? '<div class="err"><b>这些行没有导入：</b><ul>' + d.errors.slice(0, 30).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>' : '') +
          '<div class="rtw inbw"><table class="rtab-t"><thead><tr><th>箱码</th><th>Item Code</th><th>品名</th><th>单位</th><th>处理</th></tr></thead><tbody>' +
          L.slice(0, 1500).map(function (x) { return '<tr><td><b>' + esc(x.bc) + '</b></td><td>' + esc(x.item) + '</td><td>' + esc(x.desc) + '</td><td>' + esc(x.uom) + '</td><td><span class="inbk ' + INB_KIND[x.kind][1] + '">' + INB_KIND[x.kind][0] + '</span>' +
            (x.old ? '<div class="hint">原来是 ' + esc(x.old) + (x.oldDesc ? ' ' + esc(x.oldDesc) : '') + '</div>' : '') + '</td></tr>'; }).join('') +
          (L.length ? '' : '<tr><td colspan="5" class="hint">全部箱码系统里已经一样，不用改。</td></tr>') + '</tbody></table></div>' +
          inbBatchHtml(d, I) +
          '<div class="inb-act"><label class="hint"><input type="checkbox" id="inbAll"' + (I.all ? ' checked' : '') + '> 显示“已经一样”的行</label><button class="tbtn" id="inbX">' + ((R.inbQ || []).length ? '跳过这个文件' : '取消') + '</button>' +
          ((R.inbQ || []).length ? '<button class="btn" id="inbGoAll"' + (I.busy ? ' disabled' : '') + '>✓ 这个和剩下 ' + R.inbQ.length + ' 个全部写入</button>' : '') +
          '<button class="btn save" id="inbGo"' + (I.busy || !(c.bind + c.change + c.new + inbNewB(d)) ? ' disabled' : '') + '>✓ 确认写入（' + (c.bind + c.change + c.new) + ' 个箱码' + (inbNewB(d) ? ' · ' + inbNewB(d) + ' 个新批次' : '') + '）</button></div>';
      }
      return h + '</div>';
    }
    /** v1.8.5 新批次：批次号 = 到期年月 + 柜号 / 供应商编号（从文件名找，可以改） */
    function inbNewB(d) { return (d.batches || []).filter(function (b) { return b.have !== 'ac'; }).length; }
    function inbBatchHtml(d, I) {
      var B = d.batches || [];
      return '<div class="inb-bt"><div class="inb-bh"><b>新批次</b><label>柜号 / 供应商编号 <input id="inbCtn" value="' + esc(I.container || '') + '" placeholder="例如 LX26246" maxlength="20"></label>' +
        '<span class="hint">批次号 = 到期年月 + 柜号，例如 2909-LX26246。AutoCount 以后有了同一个批次，以 AutoCount 为准。</span></div>' +
        (!d.container ? '<p class="err"><b>请填柜号（或供应商编号）才会建批次</b></p>' : '') +
        (d.noExp ? '<p class="hint">' + d.noExp + ' 行没有到期日（截止日期），不建批次</p>' : '') +
        (B.length ? '<div class="rtw inbw"><table class="rtab-t"><thead><tr><th>Item Code</th><th>品名</th><th>批次号</th><th>生产</th><th>到期</th><th>数量</th><th>处理</th></tr></thead><tbody>' +
          B.map(function (b) { return '<tr><td>' + esc(b.item) + '</td><td>' + esc(b.desc) + '</td><td><b>' + esc(b.base) + '</b></td><td>' + esc(b.mfg) + '</td><td><b>' + esc(b.exp) + '</b></td><td>' + esc(b.qty) + ' ' + esc(b.uom) + '</td><td>' +
            (b.have === 'ac' ? '<span class="inbk k0">AutoCount 已有</span>' : b.have === 'in' ? '<span class="inbk k2">更新</span>' : '<span class="inbk k3">新批次</span>') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') + '</div>';
    }
    function inbDate(v) {
      if (typeof v === 'number' && v > 20000 && v < 80000) { var d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5); return d.toISOString().slice(0, 10); }
      var t = cellText(v), m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(t) || null;
      if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
      m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/.exec(t);
      return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
    }
    function inbPreview() {
      var I = R.inb; I.busy = true; draw();
      return api({ action: 'rcInbound', rows: I.rows, batches: I.batches, container: I.container, fileName: I.file }, true).then(function (d) {
        I.busy = false; I.res = d; I.msg = I.file + '：' + I.rows.length + ' 个整箱条码' + (I.skip ? '（另 ' + I.skip + ' 行没有整箱条码，不用绑定）' : '') + '，请核对后点“确认写入”。'; draw();
      }, function (e) { R.inb = { msg: I.file + ' 读取失败：' + (e.network ? '网络不可用' : e.message), err: true, file: I.file }; draw(); });
    }
    /** 读入库单：在前 30 行找表头（箱码 / 条码 / Barcode + Item Code，品名、单位可选）。拿到正式模版后按模版调整。 */
    function inbRead(file) {
      R.inb = { busy: true, msg: '读取 ' + file.name + '…', file: file.name }; draw();
      return file.arrayBuffer().then(function (b) { return xlsxRead(b, /final\s*details/i); }).then(function (sh) {
        var hr = 0, C = {}, seen = [], skip = 0;
        var pickCol = function (cs, re, not) { var x = cs.filter(function (c) { var t = cellText(c.v); return re.test(t) && !(not && not.test(t)); })[0]; return x ? x.c1 : 0; };
        for (var r = 1; r <= Math.min(sh.maxRow, 30) && !hr; r++) {
          var cs = rowCells(sh, r); if (cs.length) seen.push(cs.map(function (c) { return cellText(c.v); }).filter(Boolean).join(' | '));
          // 正式模版（FINAL DETAILS）：Item Code | BARCODE（单品）| Detail Description | … | UOM | Qty | BARCODE（整箱）| …；整箱条码才是箱码
          var bc = pickCol(cs, /整箱|箱码/i) || pickCol(cs, /条码|bar\s*code/i), it = pickCol(cs, /item\s*code|itemcode|商品编码|商品代码|货号|产品编码/i);
          if (bc && it) { hr = r; C = { bc: bc, item: it, unit: pickCol(cs, /单品|^bar\s*code$/i, /整箱/), desc: pickCol(cs, /品名|名称|description|^desc/i, /code|description\s*2/i), uom: pickCol(cs, /^(uom|单位)/i),
            qty: pickCol(cs, /收货数量|实收/) || pickCol(cs, /^qty$|数量/i), mfg: pickCol(cs, /生产日期|mfg/i), exp: pickCol(cs, /截止日期|到期|有效期至|expiry|exp\s*date/i, /保质期\s*\(?月/) }; }
        }
        if (!hr) throw new Error('认不出入库单：要有“箱码 / 条码”和“Item Code”两列。文件前几行是：' + seen.slice(0, 3).join(' ／ '));
        var rows = [], batches = [];
        for (var rr = hr + 1; rr <= sh.maxRow; rr++) {
          var o = {}; rowCells(sh, rr).forEach(function (x) { o[x.c1] = x.v; });
          var b = cellText(o[C.bc]).replace(/\s+/g, ''), i = cellText(o[C.item]), u = C.unit && C.unit !== C.bc ? cellText(o[C.unit]).replace(/\s+/g, '') : '';
          if (!i && u) i = u;                    // Item Code 空着：用单品条码（我们的 Item Code 一般就是单品条码）
          if (!b && !i) continue;
          if (i && C.exp) batches.push([i, C.desc ? cellText(o[C.desc]) : '', C.uom ? cellText(o[C.uom]) : '', C.qty ? Number(o[C.qty]) || 0 : 0, C.mfg ? inbDate(o[C.mfg]) : '', inbDate(o[C.exp])]);
          if (!b || b === i || b === u) { skip++; continue; }       // 没有整箱条码（散装 / 桶装扫单品码就认得）
          rows.push([b, i, C.desc ? cellText(o[C.desc]) : '', C.uom ? cellText(o[C.uom]) : '']);
        }
        R.inb.skip = skip;
        if (!rows.length && !batches.length) throw new Error('入库单里没有整箱条码' + (skip ? '（' + skip + ' 行没有整箱条码）' : ''));
        R.inb.rows = rows; R.inb.batches = batches;
        var cm = /([A-Z]{2,}\d{3,})/i.exec(file.name); R.inb.container = cm ? cm[1].toUpperCase() : '';      // 柜号从文件名找（例如 LX26246-297 (DSSB).xlsx）
        return inbPreview();
      }).catch(function (e) { R.inb = { msg: file.name + ' 读取失败：' + (e.network ? '网络不可用' : e.message), err: true, file: file.name }; draw(); });
    }
    function inbCommit() {
      var I = R.inb; I.busy = true; draw();
      return api({ action: 'rcInbound', rows: I.rows, batches: I.batches, container: I.container, fileName: I.file, commit: true }, true).then(function (d) {
        var c = d.counts;
        R.inb = { msg: '已写入 ' + I.file + '：新箱码绑定 ' + c.bind + ' · 改绑 ' + c.change + ' · 新品 ' + c.newItems + ' 个' + (d.batchesAdded ? ' · 新批次 ' + d.batchesAdded + ' 个（' + d.container + '）' : '') + (d.merged ? ' · 仓管建的新商品已合并 ' + d.merged + ' 个' : '') + (d.autoFixed ? ' · 待处理里 ' + d.autoFixed + ' 笔“箱码不认识”的移库现在认出来了，已自动更新库位' : '') + '。PDA 移库重新打开就认得这些箱码和批次。' };
        (R.inbLog = R.inbLog || []).push(R.inb.msg);
        draw(); inbNext();
      }, function (e) { I.busy = false; R.inbAuto = false; I.msg = '写入失败：' + (e.network ? '网络不可用' : e.message); I.err = true; draw(); });
    }
    /** v1.9.11 一次选好几个入库单：一个一个读、核对、写入；点“全部写入”后剩下的自动写入（缺柜号 / 读不出 / 有问题的停下来给你看） */
    function inbStart(files) {
      files = Array.prototype.slice.call(files || []).filter(function (f) { return /\.xlsx$/i.test(f.name); });
      if (!files.length) return;
      R.inbQ = files.slice(1); R.inbLog = []; R.inbAuto = false; R.inbN = files.length;
      inbRead(files[0]);
    }
    function inbNext() {
      if (!R.inbQ || !R.inbQ.length) { R.inbAuto = false; return; }
      var f = R.inbQ.shift();
      inbRead(f).then(function () {
        var I = R.inb, d = I && I.res;
        if (!R.inbAuto || !d || I.err) { R.inbAuto = false; return; }
        if (!d.container || (d.errors && d.errors.length)) { R.inbAuto = false; I.msg = (I.msg || '') + ' —— 自动写入停在这个文件：' + (!d.container ? '没有柜号，请填好' : '有些行导入不了，请看一下') + '，再点确认。'; draw(); return; }
        inbCommit();
      });
    }
    function trHtml() {
      var f = R.trF, d = R.tr, c = d ? d.counts : {}, rows = d ? trRows() : [];
      var h = '<div class="rbar">' + (f.hist ? '<b>箱码 ' + esc(f.hist) + ' 的移库历史（' + rows.length + ' 笔，按时间）</b> <button class="tbtn" id="trHx">‹ 返回全部记录</button>' :
        [['待处理', '待处理'], ['有问题', '有问题'], ['已完成', '已完成'], ['all', '全部']].map(function (t) { return '<button class="rtab' + (f.status === t[0] ? ' on' : '') + '" data-st="' + t[0] + '">' + t[1] + ' ' + (t[0] === 'all' ? (c.all || 0) : (c[t[0]] || 0)) + '</button>'; }).join('')) + '</div>';
      if (!f.hist) h += '<div class="rfil"><label>SKU / 箱码 <input id="trQ" value="' + esc(f.q) + '"></label><label>From Location <input id="trS" value="' + esc(f.src) + '"></label><label>To Location <input id="trD" value="' + esc(f.dst) + '"></label>' +
        '<label>日期 <input type="date" id="trF" value="' + esc(f.from) + '"></label><label>到 <input type="date" id="trT" value="' + esc(f.to) + '"></label>' +
        '<button class="tbtn" id="trR">刷新</button><button class="btn save rexp" id="trX"' + (rows.length ? '' : ' disabled') + '>⬇ 导出 Excel（' + rows.length + '）</button></div>' +
        '<p class="hint">PDA 移库会直接更新系统库位（整批：商品 + 批次）；“系统库位”一栏显示更新结果，⚠ 的已转给仓管处理。点箱码或库位即可复制。看过后点“✓ 已完成”；不对点“有问题”并写原因；录错的可“删除”。点 📜 看这个箱码的全部移库历史。时间为马来西亚时间。</p>';
      if (!f.hist) h = inbHtml() + h;
      if (!d) return h + '<p class="hint">读取中…</p>';
      if (!rows.length) return h + '<div class="empty">没有记录。</div>';
      return h + '<div class="rtw"><table class="rtab-t"><thead><tr><th>#</th><th>箱码 / SKU</th><th>From Location</th><th></th><th>To Location</th><th>批次</th><th>系统库位</th><th>照片</th><th>提交</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        rows.map(function (x, k) {
          var p = x.status === '待处理', i = x.status === '有问题';
          return '<tr><td class="hint">' + (k + 1) + '</td><td>' + big(x.bc) + ' <button class="lnk" data-hist="' + esc(x.bc) + '" title="移库历史">📜</button>' +
            (x.item ? '<div class="hint">' + esc(x.item) + ' ' + esc(x.desc) + '</div>' : '') + (x.qty !== '' ? '<div class="rqty">数量 <b>' + esc(x.qty) + '</b></div>' : '') + '</td>' +
            '<td>' + big(x.src) + '</td><td class="hint">→</td><td>' + big(x.dst) + '</td>' +
            '<td>' + (x.batch ? '<b>' + esc(x.batch) + '</b>' + (x.bexp ? '<div class="hint">到期 ' + esc(x.bexp) + '</div>' : '') : '<span class="hint">—</span>') + '</td>' +
            '<td>' + (!x.locResult ? '<span class="hint">—（旧记录）</span>' : /^已更新/.test(x.locResult) ? '<span class="rlok">✓ ' + esc(x.locResult) + '</span>' : '<span class="rlbad">⚠ ' + esc(x.locResult) + '</span>') + '</td>' +
            '<td><button class="tbtn" data-ph="' + esc(x.id) + '">📷 查看</button></td>' +
            '<td class="rmeta">' + esc(x.time) + '<br>' + esc(x.op) + (x.edits ? '<br><span class="red">已修改 ' + x.edits + ' 次（' + esc(x.editedAt) + '）</span>' : '') + '</td>' +
            '<td><span class="rst ' + (ST[x.status] || '') + '">' + esc(x.status) + '</span>' + (x.note || x.processedBy ? '<div class="rmeta">' + esc(x.note) + (x.processedBy ? '<br>' + esc(x.processedBy) + ' ' + esc(x.processedAt) : '') + '</div>' : '') + '</td>' +
            '<td class="rops">' + (p || i ? '<button class="btn save" data-done="' + esc(x.id) + '">✓ 已完成</button>' : '') + (p ? '<button class="tbtn red" data-issue="' + esc(x.id) + '">有问题</button>' : '') +
            (i ? '<button class="tbtn" data-re="' + esc(x.id) + '">重新打开</button>' : '') + '<button class="tbtn rdel" data-del="' + esc(x.id) + '">🗑 删除</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    function pkHtml() {
      var f = R.pkF, d = R.pk, all = d ? d.list.filter(function (x) { return x.status !== '已撤销' && inRange(x.ts, f); }) : [], rows = d ? pkRows() : [];
      var sk = {}; all.forEach(function (x) { sk[x.sku || x.desc] = 1; });
      var n = function (r) { return all.filter(function (x) { return x.result === r; }).length; };
      var h = '<div class="rstats"><div><b>' + all.length + '</b><span>总拣货记录</span></div><div class="g"><b>' + n('一致') + '</b><span>库位一致</span></div><div class="o"><b>' + n('不一致') + '</b><span>库位不一致</span></div>' +
        '<div><b>' + n('无系统库位') + '</b><span>无系统库位</span></div><div><b>' + Object.keys(sk).length + '</b><span>涉及 SKU</span></div></div>' +
        '<div class="rbar">' + [['不一致', '库位不一致'], ['all', '全部'], ['一致', '库位一致'], ['无系统库位', '无系统库位']].map(function (t) { return '<button class="rtab' + (f.res === t[0] ? ' on' : '') + '" data-res="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
        '<div class="rfil"><label>SKU / 箱码 / 品名 <input id="pkQ2" value="' + esc(f.q) + '"></label><label>系统库位 <input id="pkS2" value="' + esc(f.sys) + '"></label><label>实际库位 <input id="pkA2" value="' + esc(f.act) + '"></label>' +
        '<label>日期 <input type="date" id="pkF2" value="' + esc(f.from) + '"></label><label>到 <input type="date" id="pkT2" value="' + esc(f.to) + '"></label>' +
        '<button class="tbtn" id="pkR2">刷新</button><button class="btn save rexp" id="pkX2"' + (rows.length ? '' : ' disabled') + '>⬇ 导出 Excel（' + rows.length + '）</button></div>' +
        '<p class="hint">PDA 拣货时员工扫了货架库位码才会有记录（可不扫）。只记录实际取货位置，不会改商品库位。时间为马来西亚时间。点一行看明细。</p>';
      if (!d) return h + '<p class="hint">读取中…</p>';
      if (!rows.length) return h + '<div class="empty">没有记录。</div>';
      return h + '<div class="rtw"><table class="rtab-t"><thead><tr><th>时间</th><th>SKU（箱码）</th><th>商品名称</th><th>系统推荐库位</th><th>实际取货库位</th><th>数量</th><th>结果</th></tr></thead><tbody>' +
        rows.map(function (x) {
          return '<tr class="rclk' + (x.status === '已撤销' ? ' gone' : '') + '" data-pk="' + esc(x.id) + '"><td class="rmeta">' + esc(x.time) + '</td><td>' + esc(x.sku) + '</td><td>' + esc(x.desc) + '</td>' +
            '<td><b class="rloc">' + esc(x.sys || '—') + '</b></td><td><b class="rloc' + (x.result === '不一致' ? ' bad' : '') + '">' + esc(x.act) + '</b></td><td>' + x.qty + (x.status === '已撤销' ? ' <span class="hint">已撤销</span>' : '') + '</td>' +
            '<td><span class="rst ' + (x.result === '一致' ? 's3' : x.result === '不一致' ? 's2' : 's1') + '">' + esc(x.result) + '</span></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    // ---------- v1.8 库位主档（以后库位只看本系统） ----------
    function lmRows() {
      var f = R.lmF, all = (R.lm && R.lm.list) || [];
      return all.filter(function (x) { return (f.st === 'all' || x.status === f.st) && (has(x.desc, f.q) || has(x.item, f.q) || has(x.base, f.q)) && has(x.loc, f.loc); })
        .sort(function (a, b) { return a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : a.desc < b.desc ? -1 : 1; });
    }
    function lmHtml() {
      var d = R.lm, c = d ? d.counts : {}, rows = d ? lmRows() : [], f = R.lmF;
      var h = '<div class="rstats"><div class="g"><b>' + (c.ok || 0) + '</b><span>已核实</span></div><div class="o"><b>' + (c.todo || 0) + '</b><span>待核实（AutoCount）</span></div><div><b>' + (c.noloc || 0) + '</b><span>有库存没库位</span></div><div><b>' + (c.tasks || 0) + '</b><span>仓管待处理</span></div><div><b>' + (c.batches || 0) + '</b><span>AutoCount 批次行</span></div><div><b>' + (c.barcodes || 0) + '</b><span>条码' + (c.newItems ? ' · 新商品 ' + c.newItems : '') + '</span></div></div>' +
        '<div class="rfil lmimp"><label>导入 AutoCount「Stock Item with Batch」<button class="btn save" id="lmImp"' + (R.busy ? ' disabled' : '') + '>📂 选择 Excel</button><input id="lmImpF" class="vh" type="file" accept=".xlsx" tabindex="-1"></label>' +
        '<label>导入 AutoCount 条码表（Item Sales Price Listing with barcode）<button class="btn save" id="lmBc"' + (R.busy ? ' disabled' : '') + '>📂 选择 Excel</button><input id="lmBcF" class="vh" type="file" accept=".xlsx" tabindex="-1"></label>' +
        '<label>以前的移库记录更新到库位（从这天起）<span class="lmrow"><input type="date" id="lmTrD" value="' + esc(myToday(-30)) + '"><button class="tbtn" id="lmTr"' + (R.busy ? ' disabled' : '') + '>更新</button></span></label></div>' +
        (R.lmMsg ? '<p class="' + (/失败|不对|没有/.test(R.lmMsg) ? 'err' : 'hint') + '"><b>' + esc(R.lmMsg) + '</b></p>' : '') +
        '<div class="rbar">' + [['all', '全部'], ['已核实', '已核实'], ['待核实', '待核实']].map(function (t) { return '<button class="rtab' + (f.st === t[0] ? ' on' : '') + '" data-lst="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
        '<div class="rfil"><label>商品 / Item Code / 批次 <input id="lmQ" value="' + esc(f.q) + '"></label><label>库位 <input id="lmL" value="' + esc(f.loc) + '"></label><button class="tbtn" id="lmR">刷新</button><button class="btn save rexp" id="lmX"' + (rows.length ? '' : ' disabled') + '>⬇ 导出 Excel（' + rows.length + '）</button></div>' +
        '<p class="hint">库位按「商品 + 批次」记，以后库位只看这里。AutoCount 导入的是“待核实”，仓管在 PDA【📍 库位】里核实 / 改库位后变成“已核实”。拣货上传 DO 时自动用这里已核实的库位。</p>';
      if (!d) return h + '<p class="hint">读取中…</p>';
      if (!rows.length) return h + '<div class="empty">没有记录。</div>';
      return h + '<div class="rtw"><table class="rtab-t"><thead><tr><th>库位</th><th>商品</th><th>Item Code</th><th>批次</th><th>库存</th><th>状态</th><th>来源</th><th>更新</th></tr></thead><tbody>' +
        rows.slice(0, 3000).map(function (x) {
          return '<tr><td><b class="rloc">' + esc(x.loc) + '</b></td><td>' + esc(x.desc) + '</td><td>' + esc(x.item) + '</td><td>' + esc(x.base) + '</td><td>' + x.stock + (x.stock && x.uom ? ' ' + esc(x.uom) : '') + '</td><td><span class="rst ' + (x.status === '已核实' ? 's3' : 's1') + '">' + esc(x.status) + '</span></td><td class="rmeta">' + esc(x.source) + '</td><td class="rmeta">' + esc(x.by) + '<br>' + esc(x.at) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    /** 读 AutoCount「Stock Item with Batch」Excel → 分批上传 */
    function lmImport(file) {
      R.busy = true; R.lmMsg = '读取 ' + file.name + '…'; draw();
      file.arrayBuffer().then(xlsxRead).then(function (sh) {
        var hr = 0, cols = {};
        for (var r = 1; r <= Math.min(sh.maxRow, 20) && !hr; r++) {
          var cs = rowCells(sh, r), t = cs.map(function (x) { return cellText(x.v); });
          if (t.indexOf('Item Code') >= 0 && t.some(function (x) { return /^Batch No\.?$/i.test(x); })) { hr = r; cs.forEach(function (x) { cols[cellText(x.v)] = x.c1; }); }
        }
        if (!hr) throw new Error('认不出格式：需要 AutoCount「Stock Item with Batch」（有 Item Code、Batch No.、Qty 列）');
        var col = function (re) { var k = Object.keys(cols).filter(function (x) { return re.test(x); })[0]; return k ? cols[k] : 0; };
        var C = { code: col(/^Item Code$/i), desc: col(/^Description$/i), batch: col(/^Batch No\.?$/i), uom: col(/^UOM$/i), qty: col(/^Qty$/i), rate: col(/^UOM Rate$/i), group: col(/^Item Group$/i), mfg: col(/Manufactured/i), exp: col(/Expiry/i) };
        var rows = [];
        for (var rr = hr + 1; rr <= sh.maxRow; rr++) {
          var o = {}; rowCells(sh, rr).forEach(function (x) { o[x.c1] = x.v; });
          var code = cellText(o[C.code]); if (!code) continue;
          rows.push([code, cellText(o[C.desc]), cellText(o[C.batch]), cellText(o[C.uom]), Number(o[C.qty]) || 0, Number(o[C.rate]) || 0, cellText(o[C.group]), xlDate(o[C.mfg]), xlDate(o[C.exp])]);
        }
        if (!rows.length) throw new Error('文件里没有资料');
        var parts = []; for (var i = 0; i < rows.length; i += 1000) parts.push(rows.slice(i, i + 1000));
        var k = 0, last = null;
        var next = function () {
          if (k >= parts.length) return last;
          R.lmMsg = '上传中… ' + Math.min((k + 1) * 1000, rows.length) + ' / ' + rows.length; draw();
          return api({ action: 'rcLmImport', rows: parts[k], first: k === 0, last: k === parts.length - 1 }, true).then(function (d) { last = d; k++; return next(); });
        };
        return next();
      }).then(function (d) {
        R.busy = false; R.lmMsg = '已导入 ' + d.total + ' 行（' + d.items + ' 个商品）· 新增待核实库位 ' + d.newTodo + ' 条' + (d.barcodes ? ' · 新增条码 ' + d.barcodes : '') + (d.merged ? ' · ' + d.merged + ' 个新商品已对上正式商品，自动合并' : ''); load('lm');
      }, function (e) { R.busy = false; R.lmMsg = '导入失败：' + (e.network ? '网络不可用' : e.message); draw(); });
    }
    /** 读 AutoCount「Item Sales Price Listing」（带 BARCODE）→ 只取 Item Code / 品名 / 单位 / 条码，价格一律不读不传 */
    function lmBcImport(file) {
      R.busy = true; R.lmMsg = '读取 ' + file.name + '…'; draw();
      file.arrayBuffer().then(xlsxRead).then(function (sh) {
        var ci = 0, cd = 0, rows = [], cur = null, uom = '', got = 0, labels = 0;
        var flush = function () { if (cur && !got) rows.push([cur.code, cur.desc, '', '']); };
        for (var r = 1; r <= sh.maxRow; r++) {
          var cs = rowCells(sh, r), t = cs.map(function (x) { return cellText(x.v); });
          if (!ci) { var a = t.indexOf('Item Code'), b = t.indexOf('Description'); if (a >= 0 && b >= 0) { ci = cs[a].c1; cd = cs[b].c1; } continue; }
          var li = -1, lab = '';
          t.forEach(function (x, i) { if (li < 0 && /^(UOM|BAR\s*CODE)\s*[:：]?$/i.test(x)) { li = i; lab = /^UOM/i.test(x) ? 'u' : 'b'; } });
          if (li >= 0) {
            labels++;
            var val = (t.slice(li + 1).filter(Boolean)[0] || '').trim();
            if (lab === 'u') uom = val;
            else if (cur) { rows.push([cur.code, cur.desc, uom, /^\d{6,14}$/.test(val) ? val : '']); got++; }
            continue;
          }
          var o = {}; cs.forEach(function (x) { o[x.c1] = cellText(x.v); });
          if (o[ci] && o[cd] && !/^(Item Code|Date|User ID|Page)/i.test(o[ci])) { flush(); cur = { code: o[ci].trim(), desc: o[cd].trim() }; uom = ''; got = 0; }
        }
        flush();
        if (!ci || !labels || !rows.length) throw new Error('认不出格式：需要 AutoCount「Item Sales Price Listing」并勾选显示 BARCODE');
        var parts = []; for (var i = 0; i < rows.length; i += 2000) parts.push(rows.slice(i, i + 2000));
        var k = 0, last = null;
        var next = function () {
          if (k >= parts.length) return last;
          R.lmMsg = '上传中… ' + Math.min((k + 1) * 2000, rows.length) + ' / ' + rows.length; draw();
          return api({ action: 'rcLmBarcodes', rows: parts[k], first: k === 0, last: k === parts.length - 1 }, true).then(function (d) { if (d.status !== 'ok') throw new Error(d.message || '上传失败'); last = d; k++; return next(); });
        };
        return next();
      }).then(function (d) {
        R.busy = false; R.lmMsg = '条码表已导入：' + d.items + ' 个商品，' + d.barcodes + ' 个条码' + (d.merged ? ' · ' + d.merged + ' 个仓管新建的新商品已对上正式商品，自动合并' : '') + (d.conflicts ? ' · ' + d.conflicts + ' 个学来的条码和条码表不一样，以条码表为准' : '') + (d.autoFixed ? ' · 待处理里 ' + d.autoFixed + ' 笔“箱码不认识”的移库已自动认出' : ''); load('lm');
      }, function (e) { R.busy = false; R.lmMsg = '导入失败：' + (e.network ? '网络不可用' : e.message); draw(); });
    }
    function draw() {
      var y = window.scrollY;
      app.innerHTML = '<div class="mods rcmods">' + [['tr', 'Shelf Transfer · 移库记录'], ['pk', 'Picking Location Discrepancy · 拣货库位差异'], ['lm', 'Item Locations · 库位主档']].map(function (t) { return '<button class="mod' + (R.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '<a class="mod wcgo" href="#/wc">📊 库位中控台（平板）</a></div>' +
        (R.err ? '<p class="err">' + esc(R.err) + '</p>' : '') + '<div class="card rcard">' + (R.tab === 'tr' ? trHtml() : R.tab === 'lm' ? lmHtml() : pkHtml()) + '</div>';
      window.scrollTo(0, y); bind();
    }
    function bind() {
      Array.prototype.forEach.call(app.querySelectorAll('[data-tab]'), function (b) { b.onclick = function () { R.tab = b.dataset.tab; LS.set('rcTab', R.tab); draw(); if (!R[R.tab]) load(R.tab); }; });
      var inp = function (id, obj, k) { var e = $('#' + id); if (!e) return; e.oninput = e.onchange = function () { obj[k] = e.value; var pos = e.selectionStart; draw(); var n = $('#' + id); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) { } } }; };
      if (R.tab === 'lm') {
        Array.prototype.forEach.call(app.querySelectorAll('[data-lst]'), function (b) { b.onclick = function () { R.lmF.st = b.dataset.lst; draw(); }; });
        inp('lmQ', R.lmF, 'q'); inp('lmL', R.lmF, 'loc');
        $('#lmR').onclick = function () { load('lm'); };
        $('#lmImp').onclick = function () { $('#lmImpF').click(); };
        $('#lmImpF').onchange = function () { var f = this.files[0]; this.value = ''; if (f) lmImport(f); };
        $('#lmBc').onclick = function () { $('#lmBcF').click(); };
        $('#lmBcF').onchange = function () { var f = this.files[0]; this.value = ''; if (f) lmBcImport(f); };
        $('#lmTr').onclick = function () {
          var dt = $('#lmTrD').value; R.busy = true; draw();
          api({ action: 'rcLmTransfers', from: dt }, true).then(function (d) { R.busy = false; R.lmMsg = d.status === 'ok' ? dt + ' 起的移库记录 ' + d.found + ' 条：这次更新到库位 ' + d.applied + ' 条' + (d.tasks ? '，' + d.tasks + ' 条（箱码不认识 / 有多个批次）转仓管 PDA【待处理】一个一个核实' : '') + (d.done ? '，' + d.done + ' 条之前已经更新过' : '') : d.message; load('lm'); },
            function (e) { R.busy = false; R.lmMsg = '导入失败：' + e.message; draw(); });
        };
        var lx = $('#lmX'); if (lx) lx.onclick = function () {
          download(xlsxBlob('Item Locations', [['库位', '商品', 'Item Code', '批次', '库存', '状态', '来源', '更新人', '更新时间']].concat(lmRows().map(function (x) { return [x.loc, x.desc, x.item, x.base, x.stock, x.status, x.source, x.by, x.at]; }))), 'Item Locations ' + myToday(0) + '.xlsx');
        };
      } else if (R.tab === 'tr') {
        var ib = $('#inbB'); if (ib) { ib.onclick = function () { $('#inbF').click(); }; $('#inbF').onchange = function () { var fs = Array.prototype.slice.call(this.files || []); this.value = ''; inbStart(fs); }; }
        var ig = $('#inbGo'); if (ig) ig.onclick = function () { R.inbAuto = false; inbCommit(); };
        var iga = $('#inbGoAll'); if (iga) iga.onclick = function () { R.inbAuto = true; inbCommit(); };
        var ix = $('#inbX'); if (ix) ix.onclick = function () { R.inb = null; R.inbAuto = false; if ((R.inbQ || []).length) inbNext(); else draw(); };
        var isk = $('#inbSkip'); if (isk) isk.onclick = function () { R.inb = null; R.inbAuto = false; inbNext(); };
        var ia = $('#inbAll'); if (ia) ia.onchange = function () { R.inb.all = ia.checked; draw(); };
        var ic = $('#inbCtn'); if (ic) ic.onchange = function () { R.inb.container = ic.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); inbPreview(); };
        Array.prototype.forEach.call(app.querySelectorAll('[data-st]'), function (b) { b.onclick = function () { R.trF.status = b.dataset.st; draw(); }; });
        inp('trQ', R.trF, 'q'); inp('trS', R.trF, 'src'); inp('trD', R.trF, 'dst'); inp('trF', R.trF, 'from'); inp('trT', R.trF, 'to');
        var r = $('#trR'); if (r) r.onclick = function () { load('tr'); };
        var hx = $('#trHx'); if (hx) hx.onclick = function () { R.trF.hist = ''; draw(); };
        var x = $('#trX'); if (x) x.onclick = function () {
          var rows = trRows();
          download(xlsxBlob('Shelf Transfer', [['提交时间', '员工', '箱码 / SKU', 'Item Code', '品名', 'From Location', 'To Location', '批次', '到期', '系统库位', '数量', '状态', '办公室备注', '处理人', '处理时间', '修改次数', '设备', 'Transfer ID']].concat(rows.map(function (t) {
            return [t.time, t.op, t.bc, t.item, t.desc, t.src, t.dst, t.batch || '', t.bexp || '', t.locResult || '', t.qty === '' ? '' : t.qty, t.status, t.note, t.processedBy, t.processedAt, t.edits || 0, t.device, t.id];
          }))), 'Shelf Transfer ' + myToday(0) + '.xlsx');
        };
      } else {
        Array.prototype.forEach.call(app.querySelectorAll('[data-res]'), function (b) { b.onclick = function () { R.pkF.res = b.dataset.res; draw(); }; });
        inp('pkQ2', R.pkF, 'q'); inp('pkS2', R.pkF, 'sys'); inp('pkA2', R.pkF, 'act'); inp('pkF2', R.pkF, 'from'); inp('pkT2', R.pkF, 'to');
        var r2 = $('#pkR2'); if (r2) r2.onclick = function () { load('pk'); };
        var x2 = $('#pkX2'); if (x2) x2.onclick = function () {
          var rows = pkRows();
          download(xlsxBlob('Picking Location', [['时间', 'SKU（箱码）', '商品名称', '系统推荐库位', '实际取货库位', '数量', '结果', '状态', '员工', '拣货任务', 'DO', '批次号', '设备', 'Record ID']].concat(rows.map(function (t) {
            return [t.time, t.sku, t.desc, t.sys, t.act, t.qty, t.result, t.status, t.op, t.task, t.dos, t.batch, t.device, t.id];
          }))), 'Picking Location Discrepancy ' + myToday(0) + '.xlsx');
        };
      }
    }
    function busyBtn(b, p) { b.disabled = true; return p.then(function (d) { load('tr'); return d; }, function (e) { b.disabled = false; R.err = e.network ? '网络不可用，没有处理，请稍后再试' : e.message; draw(); }); }
    app.onclick = function (e) {
      var t = e.target.closest ? e.target.closest('[data-cp],[data-hist],[data-ph],[data-done],[data-issue],[data-re],[data-del],[data-pk]') : null; if (!t) return;
      var d = t.dataset;
      if (d.cp != null) {
        var ok = false; try { var ta = document.createElement('textarea'); ta.value = d.cp; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (x) { }
        if (!ok && navigator.clipboard) navigator.clipboard.writeText(d.cp).catch(function () { });
        t.classList.add('cp'); setTimeout(function () { t.classList.remove('cp'); }, 700); return toast('已复制 ' + d.cp, 1200);
      }
      if (d.hist != null) { R.trF.hist = d.hist; window.scrollTo(0, 0); return draw(); }
      if (d.ph) {
        t.disabled = true;
        return api({ action: 'rcTransferPhoto', id: d.ph }, true).then(function (u) {
          t.disabled = false;
          if (!u.src) return window.open(u.link, '_blank');
          modal('<div style="text-align:center"><img src="' + esc(u.src) + '" referrerpolicy="no-referrer" style="max-width:100%;max-height:70vh"><p><a href="' + esc(u.link) + '" target="_blank">在云端硬盘打开原图</a></p><button class="btn ghost" id="phX">关闭</button></div>', function (m) { $('#phX', m).onclick = closeModal; });
        }, function (x) { t.disabled = false; toast(x.message, 3000); });
      }
      if (d.done) return busyBtn(t, api({ action: 'rcTransferSet', id: d.done, op: 'done' }, true));
      if (d.re) return busyBtn(t, api({ action: 'rcTransferSet', id: d.re, op: 'reopen' }, true));
      if (d.issue) {
        return modal('<h3>有问题</h3><p class="hint">问题说明（例如：照片看不清 / 箱码不对 / AutoCount 找不到批次）</p><input id="isN" class="pkq" maxlength="200"><div class="row"><button class="btn ghost" id="isC">取消</button><button class="btn save" id="isO">确定</button></div>', function (m) {
          var n = $('#isN', m); setTimeout(function () { n.focus(); }, 50);
          $('#isC', m).onclick = closeModal;
          $('#isO', m).onclick = function () { if (!n.value.trim()) { n.focus(); return; } closeModal(); busyBtn(t, api({ action: 'rcTransferSet', id: d.issue, op: 'issue', note: n.value.trim() }, true)); };
        });
      }
      if (d.del) {
        var x = ((R.tr && R.tr.list) || []).filter(function (r) { return r.id === d.del; })[0] || {};
        return confirmBox('确定删除这条移位记录？ ' + (x.bc || '') + '  ' + (x.src || '') + ' → ' + (x.dst || '') + '。照片会一起删除（云端硬盘回收站 30 天内可找回）。', '确定删除', function () {
          busyBtn(t, api({ action: 'rcTransferDelete', id: d.del }, true)).then(function (r) { if (r) toast('已删除 · ' + r.photo, 2500); });
        });
      }
      if (d.pk) {
        var p = ((R.pk && R.pk.list) || []).filter(function (r) { return r.id === d.pk; })[0]; if (!p) return;
        var kv = [['时间', p.time], ['SKU（箱码）', p.sku], ['Item Code', p.code], ['商品名称', p.desc], ['批次号', p.batch], ['系统推荐库位', p.sys || '—'], ['实际取货库位', p.act], ['结果', p.result],
          ['数量', p.qty], ['状态', p.status + (p.edited ? '（' + p.edited + ' 修改过）' : '')], ['员工', p.op], ['设备', p.device], ['拣货任务', p.task], ['DO', p.dos], ['Record ID', p.id]];
        modal('<h3 style="margin-top:0">拣货库位明细</h3><table class="rkv">' + kv.map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table><div class="row"><button class="btn ghost" id="pkdX">关闭</button></div>', function (m) { $('#pkdX', m).onclick = closeModal; });
      }
    };
    draw(); load(R.tab);
  }
  // =====================================================================
  // v1.9 平板中控台（库位记录后台电脑 / 平板，#/wc）：数据从 Supabase 读（快），处理还是写回表格（正本）。样式按 AWMS 1.0（没有托盘码：库位上记“商品 + 批次”）
  // =====================================================================
  var WC = null;
  /** v1.9.4 仓库货架（按库位标签）：排 → 最后一列；每列 01–03 层 */
  var WC_RACKS = { '01': 'I', '02': 'I', '03': 'M', '04': 'M', '05': 'M', '06': 'M', '07': 'P', '08': 'Q', '09': 'Q', '10': 'Q', '11': 'Q', '12': 'Q', '13': 'Q', '14': 'Q', '15': 'Q' }, WC_LEVELS = 3;
  function viewConsole() {
    document.body.classList.add('wide', 'wcon');
    setBar('库位中控台', false);
    var PF = cfg.r === 'wc' ? 'wc' : 'rc';          // v1.9.1 平板（员工登录）用 wc*，后台电脑用 rc*
    var W = WC || (WC = { view: LS.get('wcView', 'map'), aisle: '', loc: '', q: '', found: null, item: '', days: 60, lf: '', snap: null, sb: null, err: '', busy: false, at: 0 });
    var NAV = [['map', '库位图'], ['inv', '库存查询'], ['tasks', '待处理'], ['empty', '空库位'], ['exp', '快到期'], ['log', '库位调整记录'], ['tr', '移库记录']];
    var ST = { ok: ['● 受控', 'c-ok'], todo: ['○ 未受控', 'c-neu'], task: ['◐ 待核验', 'c-warn'], empty: ['空', 'c-empty'] };
    function rpc(fn, args) {
      if (PF === 'wc') args = Object.assign({ p_sess: sess ? sess.t : '' }, args);
      var h = { 'Content-Type': 'application/json', apikey: W.sb.anon }; if (!/^sb_publishable_/.test(W.sb.anon)) h.Authorization = 'Bearer ' + W.sb.anon;
      return fetch(W.sb.url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: h, body: JSON.stringify(args) }).then(function (r) {
        if (!r.ok) throw new Error('数据库 ' + r.status); return r.json();
      }).then(function (d) { if (d && d.error === 'DEVICE') throw new Error(PF === 'wc' ? '数据库还没认得这次登录（刚登录请等 1 分钟再点重试），或登录已过期请重新登录' : '这台设备没有中控台权限（或已被撤销）'); return d; });
    }
    function load(force) {
      if (PF === 'wc' && !sess) return Promise.resolve();
      W.busy = true; paintTop();
      var cfgP = W.sb ? Promise.resolve(W.sb) : api({ action: PF + 'SbCfg' }, true).then(function (c) { if (!c.url) throw new Error('还没设置中控台数据库：请在表格菜单【中控台数据库（Supabase）设置】'); W.sb = c; return c; });
      return cfgP.then(function () { return rpc('wc_snapshot', { p_token: cfg.d }); }).then(function (s) { W.snap = build(s); W.err = ''; W.busy = false; W.at = Date.now(); draw(); },
        function (e) { W.busy = false; W.err = e.network ? '网络不可用' : e.message; draw(); });
    }
    /** 原始快照 → 好用的索引 */
    function build(s) {
      var D = { at: s.at, meta: s.meta || {}, locs: {}, items: {}, bat: {}, tasks: [], log: s.log || [], tr: s.transfers || [] };
      var cell = function (l) { return D.locs[l] || (D.locs[l] = { loc: l, recs: [], tasks: [], ac: 0 }); };
      (s.batches || []).forEach(function (r) {
        var b = { item: r[0], desc: r[1], base: r[2], bloc: r[3], uom: r[4], qty: +r[5] || 0, mfg: r[6], exp: r[7], src: r[8] };
        var k = b.item + '|' + b.base, o = D.bat[k] || (D.bat[k] = { item: b.item, desc: b.desc, base: b.base, uom: b.uom, qty: 0, mfg: b.mfg, exp: b.exp, src: b.src, acLocs: {} });
        o.qty = Math.round((o.qty + b.qty) * 1000) / 1000; String(b.bloc || '').split(/\s+/).forEach(function (l) { if (!l) return; o.acLocs[l] = 1; if (lmParts(l)) cell(l).ac++; });    // v1.9.7 一个批次一行，库位空格分开
        if (!D.items[b.item]) D.items[b.item] = b.desc;
      });
      (s.locs || []).forEach(function (r) {
        var x = { id: r[0], item: r[1], desc: r[2], base: r[3], loc: r[4], status: r[5], src: r[6], at: r[7], by: r[8] };
        if (!D.items[x.item]) D.items[x.item] = x.desc;
        if (lmParts(x.loc)) cell(x.loc).recs.push(x);
      });
      (s.tasks || []).forEach(function (r) {
        var t = { id: r[0], at: r[1], type: r[2], bc: r[3], item: r[4], desc: r[5], base: r[6], from: r[7], to: r[8], ref: r[9], note: r[10] };
        D.tasks.push(t); [t.from, t.to].forEach(function (l) { if (lmParts(l)) cell(l).tasks.push(t); });
      });
      // v1.9.4 仓库实际的全部货架（库位标签）：没放东西的也显示成空库位
      Object.keys(WC_RACKS).forEach(function (a) {
        for (var k = 65; k <= WC_RACKS[a].charCodeAt(0); k++) for (var lv = 1; lv <= WC_LEVELS; lv++) cell(a + '-' + String.fromCharCode(k) + '-0' + lv);
      });
      // v1.9.14 库位备注（wms_meta.locnotes = {库位: [备注, 谁, 时间]}）
      var NT = {}; try { NT = JSON.parse((D.meta.locnotes || [])[0] || '{}') || {}; } catch (e) { NT = {}; }
      Object.keys(NT).forEach(function (l) { if (lmParts(l) && NT[l] && NT[l][0]) cell(l).note = { text: String(NT[l][0]), by: NT[l][1] || '', at: NT[l][2] || '' }; });
      Object.keys(D.locs).forEach(function (l) { var c = D.locs[l]; c.st = c.tasks.length ? 'task' : c.recs.some(function (x) { return x.status !== '已核实'; }) ? 'todo' : c.recs.length ? 'ok' : 'empty'; });
      return D;
    }
    function lmParts(l) { var m = /^(\d{2})-([A-Z])-(\d{2})$/.exec(String(l || '')); return m ? { a: m[1], p: m[2], lv: m[3] } : null; }
    function dmy(s) { var m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || '')); return m ? new Date(Date.UTC(+m[3], m[2] - 1, +m[1])) : null; }
    function daysLeft(s) { var d = dmy(s); return d ? Math.floor((d.getTime() - Date.now()) / 864e5) : null; }
    function bInfo(item, base) { return W.snap.bat[item + '|' + base] || null; }
    function chip(st) { return '<span class="chip ' + ST[st][1] + '">' + ST[st][0] + '</span>'; }
    function act(p, okMsg) {
      if (W.busy) return; W.busy = true; paintTop(); toast('处理中…', 3000);
      return api(Object.assign({ action: PF + 'LmSave' }, p), true).then(function (r) {
        W.busy = false; if (r.status && r.status !== 'ok') { toast(r.message || '处理不了', 4000); paintTop(); return; }
        toast(okMsg, 2000); return load();
      }, function (e) { W.busy = false; paintTop(); toast(e.network ? '没有网络' : e.message, 4000); });
    }
    /** v1.9.14 库位备注：打字保存；清空 = 删除 */
    function noteEdit(l) {
      var c = W.snap.locs[l], old = c && c.note ? c.note.text : '';
      modal('<div class="tmiss"><h3>📝 库位 ' + esc(l) + ' 备注</h3><p class="hint">例如：货架坏了、不能放重货、暂时放客户的货……写了以后库位图上这个库位会用紫框标出来。</p>' +
        '<textarea id="wcNt" class="wcnta" maxlength="300" placeholder="写备注（最多 300 字）">' + esc(old) + '</textarea><div class="hint" id="wcNtN"></div>' +
        '<div class="row" style="margin-top:10px"><button class="btn ghost" id="wcNtC">取消</button>' + (old ? '<button class="btn ghost red" id="wcNtD">删除备注</button>' : '') + '<button class="btn save" id="wcNtS">保存备注</button></div></div>', function (m) {
          var ta = $('#wcNt', m), cnt = function () { $('#wcNtN', m).textContent = ta.value.length + ' / 300'; };
          var go = function (v) {
            v = String(v).trim(); if (v === old) { closeModal(); return; }
            closeModal(); if (W.busy) return; W.busy = true; paintTop(); toast('保存中…', 3000);
            if (c) { c.note = v ? { text: v, by: operator || '', at: '' } : null; draw(); }      // 先显示
            api({ action: PF + 'LocNote', loc: l, note: v }, true).then(function (r) {
              W.busy = false; if (r.status && r.status !== 'ok') { toast(r.message || '保存不了', 4000); return load(); }
              toast(v ? '备注已保存' : '备注已删除', 2000); return load();
            }, function (e) { W.busy = false; toast(e.network ? '没有网络，备注没保存' : e.message, 4000); load(); });
          };
          ta.oninput = cnt; cnt();
          $('#wcNtC', m).onclick = closeModal; $('#wcNtS', m).onclick = function () { go(ta.value); };
          var d = $('#wcNtD', m); if (d) d.onclick = function () { confirmBox('删除库位 ' + l + ' 的备注？', '删除', function () { go(''); }); };
          setTimeout(function () { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);
        });
    }
    function skip(t) {
      confirmBox('“' + (t.desc || t.bc || t.type) + '”这条待处理标为已处理 / 忽略？', '确定', function () {
        api({ action: PF + 'LmTaskSkip', id: t.id, note: '中控台处理' }, true).then(function () { toast('已处理', 1500); load(); }, function (e) { toast(e.message, 4000); });
      });
    }
    // ---------- 各页面 ----------
    function vMap() {
      var D = W.snap, A = {};
      Object.keys(D.locs).forEach(function (l) { var p = lmParts(l), c = D.locs[l]; var a = A[p.a] || (A[p.a] = { a: p.a, n: 0, ok: 0, todo: 0, task: 0, empty: 0, note: 0 }); a.n++; a[c.st]++; if (c.note) a.note++; });
      var as = Object.keys(A).sort();
      if (!W.aisle || !A[W.aisle]) W.aisle = as[0] || '';
      var pct = function (x, n) { return (n ? x * 100 / n : 0).toFixed(1) + '%'; };
      var tot = { n: 0, ok: 0, todo: 0, task: 0, empty: 0 }; as.forEach(function (k) { ['n', 'ok', 'todo', 'task', 'empty'].forEach(function (f) { tot[f] += A[k][f]; }); });
      var h = '<div class="wcstats">' + [['ok', '受控（已核实）'], ['todo', '未受控（待核实）'], ['task', '待核验（有待处理）'], ['empty', '空库位']].map(function (x) {
        return '<div class="wcstat s-' + x[0] + '"><b>' + tot[x[0]] + '</b><span>' + x[1] + '</span></div>'; }).join('') + '</div>';
      h += '<div class="wcsplit"><div class="wcais">' + as.map(function (k) { var a = A[k];
        return '<button class="wcai' + (k === W.aisle ? ' on' : '') + '" data-ai="' + k + '"><span class="wcain">' + k + ' 排</span><span class="wcpb"><i class="ok" style="width:' + pct(a.ok, a.n) + '"></i><i class="todo" style="width:' + pct(a.todo, a.n) + '"></i><i class="task" style="width:' + pct(a.task, a.n) + '"></i></span><small>' + a.ok + '/' + a.n + ' 受控 · 空 ' + a.empty + (a.task ? ' · ◐ ' + a.task : '') + (a.note ? ' · 📝 ' + a.note : '') + '</small></button>'; }).join('') + '</div>';
      var cells = Object.keys(D.locs).filter(function (l) { return lmParts(l).a === W.aisle; }), P = {}, L = {};
      cells.forEach(function (l) { var p = lmParts(l); P[p.p] = 1; L[p.lv] = 1; });
      var ps = Object.keys(P).sort(), lvs = Object.keys(L).sort().reverse();
      h += '<div class="wcgridw"><div class="wcgh"><b>第 ' + esc(W.aisle) + ' 排</b><span class="hint">最上一行 = 最高层 · 点库位看上面放了什么、写备注 · <span class="wcnotek">📝</span> 紫框 = 有备注</span></div><div class="wcgrid" style="grid-template-columns: 44px repeat(' + ps.length + ', minmax(46px, 1fr))"><span></span>' +
        ps.map(function (p) { return '<span class="wcgc">' + p + '</span>'; }).join('') +
        lvs.map(function (lv) { return '<span class="wcgc">' + lv + '层</span>' + ps.map(function (p) { var l = W.aisle + '-' + p + '-' + lv, c = D.locs[l];
          return c ? '<button class="wccell st-' + c.st + (c.note ? ' note' : '') + (W.loc === l ? ' sel' : '') + '" data-loc="' + l + '" title="' + l + (c.note ? ' 📝 ' + esc(c.note.text) : '') + '"><span>' + p + lv + '</span><small>' + (c.recs.length || '') + '</small></button>' : '<span class="wccell none"></span>'; }).join(''); }).join('') +
        '</div>' + (W.loc && D.locs[W.loc] ? locPanel(W.loc) : '<p class="hint" style="margin:12px 0">选一个库位，查看上面的商品和批次。</p>') + '</div></div>';
      return h;
    }
    function locPanel(l) {
      var c = W.snap.locs[l];
      var h = '<div class="wcpanel"><div class="wcph"><b class="mono">' + l + '</b>' + chip(c.st) + '<span class="hint">' + (c.recs.length ? c.recs.length + ' 个商品 / 批次' : '系统里是空的') + '</span><button class="tbtn" data-note="' + l + '">' + (c.note ? '✎ 改备注' : '📝 写备注') + '</button></div>';
      if (c.note) h += '<div class="wcnote" data-note="' + l + '"><b>📝 备注</b><div class="wcnt">' + esc(c.note.text) + '</div><div class="hint">' + esc(c.note.by) + ' ' + esc(c.note.at) + '</div></div>';     // v1.9.14
      h += c.recs.map(function (x) { var b = bInfo(x.item, x.base), dl = b ? daysLeft(b.exp) : null;
        return '<div class="wcrec"><div><b>' + esc(x.desc) + '</b><div class="hint mono">' + esc(x.item) + (x.base ? ' · 批次 ' + esc(x.base) : ' · 不分批次') + '</div>' +
          '<div class="wcrm">' + (b ? '库存 <b>' + b.qty + '</b> ' + esc(b.uom) + ' · 到期 <b' + (dl != null && dl < 60 ? ' class="red"' : '') + '>' + esc(b.exp || '—') + '</b>' : '<span class="hint">AutoCount 没有这个批次的库存</span>') + '</div>' +
          '<div class="hint">' + (x.status === '已核实' ? '● 受控' : '○ 未受控（' + esc(x.status) + '）') + ' · ' + esc(x.by || x.src || '') + ' ' + esc(x.at || '') + '</div></div>' +
          '<div class="wcracts">' + (x.status !== '已核实' ? '<button class="btn save" data-ver="' + esc(x.id) + '">已核实</button>' : '') + '<button class="tbtn" data-mv="' + esc(x.id) + '">改库位</button><button class="tbtn red" data-rm="' + esc(x.id) + '" data-what="' + esc(x.desc + ' ' + x.base) + '">不在这里了</button></div></div>'; }).join('');
      if (c.tasks.length) h += '<div class="wcpt"><b>这个库位的待处理</b>' + c.tasks.map(function (t) { return '<div class="hint">◐ ' + esc(t.type) + ' · ' + esc(t.desc || t.bc) + ' · ' + esc(t.from || '—') + ' → ' + esc(t.to || '—') + '</div>'; }).join('') + '</div>';
      h += '<div class="wcadd"><button class="btn save" data-add="' + l + '">＋ 登记商品在这个库位</button></div>';
      return h + '<p class="hint">货真的搬了请用手机【库位转移】；这里只改正记录、登记货在哪里。</p></div>';
    }
    function vInv() {
      var h = '<div class="wcsearch"><input id="wcQ" placeholder="扫码或输入 箱码 / Item Code / 品名（几个词用空格分开）" value="' + esc(W.q) + '"><button class="btn save" id="wcGo">查询</button></div>';
      if (W.found) {
        if (!W.found.length) h += '<div class="empty">没有找到</div>';
        else if (!W.item) h += '<div class="wclist">' + W.found.map(function (x) { return '<button class="wcli" data-it="' + esc(x[0]) + '"><b>' + esc(x[1] || W.snap.items[x[0]] || '') + '</b><span class="mono hint">' + esc(x[0]) + '</span></button>'; }).join('') + '</div>';
      }
      if (W.item) {
        var it = W.item, D = W.snap, bs = Object.keys(D.bat).map(function (k) { return D.bat[k]; }).filter(function (b) { return b.item === it; })
          .sort(function (a, b) { var x = dmy(a.exp), y = dmy(b.exp); return (x ? x.getTime() : 9e15) - (y ? y.getTime() : 9e15); });
        var recs = []; Object.keys(D.locs).forEach(function (l) { D.locs[l].recs.forEach(function (x) { if (x.item === it) recs.push(x); }); });
        var tot = bs.reduce(function (s, b) { return s + b.qty; }, 0);
        h += '<div class="wcpanel"><div class="wcph"><b>' + esc(D.items[it] || it) + '</b><span class="mono hint">' + esc(it) + '</span><span class="hint">总库存 <b>' + Math.round(tot * 1000) / 1000 + '</b> · ' + bs.length + ' 个批次</span>' + (W.found && W.found.length > 1 ? '<button class="tbtn" id="wcBack">‹ 换一个商品</button>' : '') + '</div>' +
          '<table class="wct"><thead><tr><th>批次</th><th>到期（先到先出）</th><th>生产</th><th class="n">库存</th><th>系统库位</th></tr></thead><tbody>' +
          bs.map(function (b) { var rl = recs.filter(function (x) { return x.base === b.base; }), dl = daysLeft(b.exp);
            return '<tr><td class="mono">' + esc(b.base || '（不分批次）') + (b.src === '入库单' ? ' <span class="chip c-info">入库单</span>' : '') + '</td><td><b' + (dl != null && dl < 60 ? ' class="red"' : '') + '>' + esc(b.exp || '—') + '</b>' + (dl != null ? ' <span class="hint">' + (dl < 0 ? '已过期' : dl + ' 天') + '</span>' : '') + '</td><td>' + esc(b.mfg || '—') + '</td><td class="n"><b>' + b.qty + '</b> ' + esc(b.uom) + '</td><td>' +
              (rl.length ? rl.map(function (x) { return '<button class="lnk mono" data-goloc="' + esc(x.loc) + '">' + esc(x.loc) + '</button>' + (x.status === '已核实' ? '' : ' <span class="hint">○</span>'); }).join(' ') : '<span class="hint">没有库位' + (Object.keys(b.acLocs).length ? '（AutoCount：' + esc(Object.keys(b.acLocs).join(' ')) + '）' : '') + '</span>') + ' <button class="tbtn" data-bind="' + esc(b.base) + '">＋ 登记库位</button></td></tr>'; }).join('') +
          '</tbody></table>' + (bs.length ? '' : '<p class="hint">AutoCount 没有这个商品的库存批次。 <button class="tbtn" data-bind="">＋ 登记库位（不分批次）</button></p>') + (recs.filter(function (x) { return !x.base; }).length ? '<p class="hint">不分批次的库位：' + recs.filter(function (x) { return !x.base; }).map(function (x) { return esc(x.loc); }).join(' ') + '</p>' : '') + '</div>';
      }
      return h;
    }
    function vTasks() {
      var T = W.snap.tasks;
      if (!T.length) return '<div class="empty">没有待处理 👍</div>';
      return '<table class="wct"><thead><tr><th>类型</th><th>商品 / 箱码</th><th>库位</th><th>说明</th><th>时间</th><th></th></tr></thead><tbody>' + T.map(function (t, i) {
        var cands = t.type === '移库：箱码不认识' && t.from && W.snap.locs[t.from] ? W.snap.locs[t.from].recs : [];
        return '<tr><td><span class="chip c-warn">◐ ' + esc(t.type) + '</span></td><td><b>' + esc(t.desc || '（不认识）') + '</b>' + (t.bc ? '<div class="mono hint">' + esc(t.bc) + '</div>' : '') + (t.base ? '<div class="hint">批次 ' + esc(t.base) + '</div>' : '') + '</td>' +
          '<td class="mono">' + esc(t.from || '—') + ' → <b>' + esc(t.to || '—') + '</b></td><td class="hint">' + esc(t.note) +
          (cands.length ? '<div class="wccands"><b>他从 ' + esc(t.from) + ' 搬走的是：</b>' + cands.map(function (x) { return '<button class="tbtn" data-res="' + i + '" data-rec="' + esc(x.id) + '">' + esc(x.desc) + (x.base ? ' · ' + esc(x.base) : '') + '</button>'; }).join('') + '</div>' : '') + '</td>' +
          '<td class="hint">' + esc(t.at) + '</td><td><button class="tbtn" data-sk="' + i + '">已处理 / 忽略</button>' + (t.to ? '<button class="lnk" data-goloc="' + esc(t.to) + '">看库位</button>' : '') + '</td></tr>'; }).join('') + '</tbody></table>' +
        '<p class="hint">需要选商品、选批次的，也可以在仓管手机【📍 库位】→【待处理】里处理。</p>';
    }
    function vEmpty() {
      var D = W.snap, E = Object.keys(D.locs).filter(function (l) { return D.locs[l].st === 'empty'; }).sort(), g = {};
      E.forEach(function (l) { (g[lmParts(l).a] = g[lmParts(l).a] || []).push(l); });
      return '<div class="wcbar"><b>空库位 ' + E.length + ' 个</b><span class="hint">仓库全部货架里，系统没记着放货的库位</span><button class="tbtn" id="wcPrint">🖨 打印</button></div>' +
        Object.keys(g).sort().map(function (a) { return '<div class="wcempg"><b>' + a + ' 排（' + g[a].length + '）</b><div>' + g[a].map(function (l) { return '<button class="lnk mono" data-goloc="' + l + '">' + l + '</button>'; }).join(' ') + '</div></div>'; }).join('');
    }
    function vExp() {
      var D = W.snap, rows = [];
      Object.keys(D.bat).forEach(function (k) { var b = D.bat[k], dl = daysLeft(b.exp); if (dl == null || dl > W.days || !(b.qty > 0)) return; rows.push({ b: b, dl: dl }); });
      rows.sort(function (a, b) { return a.dl - b.dl; });
      var locsOf = function (b) { var o = []; Object.keys(D.locs).forEach(function (l) { D.locs[l].recs.forEach(function (x) { if (x.item === b.item && x.base === b.base) o.push(l); }); }); return o; };
      return '<div class="wcbar">' + [30, 60, 90].map(function (d) { return '<button class="rtab' + (W.days === d ? ' on' : '') + '" data-days="' + d + '">' + d + ' 天内</button>'; }).join('') + '<span class="hint">' + rows.length + ' 个批次（含已过期），按到期日排序</span></div>' +
        '<table class="wct"><thead><tr><th>到期</th><th>商品</th><th>批次</th><th class="n">库存</th><th>库位</th></tr></thead><tbody>' + rows.map(function (r) { var l = locsOf(r.b);
          return '<tr><td><b class="' + (r.dl < 30 ? 'red' : '') + '">' + esc(r.b.exp) + '</b> <span class="hint">' + (r.dl < 0 ? '已过期' : r.dl + ' 天') + '</span></td><td>' + esc(r.b.desc) + '<div class="mono hint">' + esc(r.b.item) + '</div></td><td class="mono">' + esc(r.b.base) + '</td><td class="n">' + r.b.qty + ' ' + esc(r.b.uom) + '</td><td>' +
            (l.length ? l.map(function (x) { return '<button class="lnk mono" data-goloc="' + x + '">' + x + '</button>'; }).join(' ') : '<span class="hint">没有库位</span>') + '</td></tr>'; }).join('') + '</tbody></table>';
    }
    var ACT = { BIND: '绑定库位', MOVE: '移库 / 改库位', VERIFY: '核实', REMOVE: '移走', UNDO: '撤回', OVERWRITE: '新托盘覆盖', LEARN: '记住箱码', MERGE: '合并新商品', IMPORT: '导入', INBOUND: '入库单', 'NEW ITEM': '新商品', NOTE: '库位备注' };
    function vLog() {
      var q = W.lf.toUpperCase(), L = W.snap.log.filter(function (r) { return !q || r.join(' ').toUpperCase().indexOf(q) >= 0; });
      return '<div class="wcbar"><input id="wcLf" placeholder="筛选：商品 / 库位 / 人 / 箱码" value="' + esc(W.lf) + '"><span class="hint">最近 ' + W.snap.log.length + ' 条（每次核实、移库、更正都有一条）</span></div>' +
        '<table class="wct"><thead><tr><th>时间</th><th>动作</th><th>商品</th><th>批次</th><th>原库位 → 新库位</th><th>操作人</th><th>备注</th></tr></thead><tbody>' + L.slice(0, 400).map(function (r) {
          return '<tr><td class="hint">' + esc(r[0]) + '</td><td>' + esc(ACT[r[1]] || r[1]) + '</td><td>' + esc(r[3]) + '<div class="mono hint">' + esc(r[2]) + '</div></td><td class="mono">' + esc(r[4]) + '</td><td class="mono">' + esc(r[5] || '—') + ' → <b>' + esc(r[6] || '—') + '</b></td><td>' + esc(r[7]) + '</td><td class="hint">' + esc(r[8]) + '</td></tr>'; }).join('') + '</tbody></table>';
    }
    function vTr() {
      return '<table class="wct"><thead><tr><th>时间</th><th>员工</th><th>商品 / 箱码</th><th>批次</th><th>来源 → 目的</th><th>系统库位</th><th>状态</th></tr></thead><tbody>' + W.snap.tr.map(function (r) {
        return '<tr><td class="hint">' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[6] || '') + '<div class="mono hint">' + esc(r[5] || '') + ' · ' + esc(r[4]) + '</div></td><td class="mono">' + esc(r[8] || '') + (r[9] ? '<div class="hint">到期 ' + esc(r[9]) + '</div>' : '') + '</td><td class="mono">' + esc(r[3] || '—') + ' → <b>' + esc(r[7]) + '</b></td><td class="hint">' + esc(r[10] || '') + '</td><td>' + esc(r[11]) + '</td></tr>'; }).join('') + '</tbody></table>';
    }
    // ---------- 外框 ----------
    function paintTop() {
      var t = $('#wcTop'); if (!t) return;
      var age = W.at ? Math.round((Date.now() - W.at) / 1000) : null, m = W.snap && W.snap.meta['sync:wms_locations'];
      t.innerHTML = '<span class="hint">' + (W.busy ? '读取中…' : W.snap ? '数据库 ' + esc(W.snap.at) + (m ? ' · 表格同步 ' + esc(m[1]) : '') : '') + '</span><button class="tbtn" id="wcRe"' + (W.busy ? ' disabled' : '') + '>⟳ 刷新</button>' + (PF === 'wc' ? '<span class="wcwho">' + esc(operator) + '</span><button class="tbtn" id="wcOut">退出</button>' : '<a class="tbtn" href="#/">后台 ›</a>');
      var o = $('#wcOut'); if (o) o.onclick = function () { confirmBox('退出登录？', '退出', function () { clearInterval(W.timer); api({ action: 'logout' }).catch(function () { }); setSession(null); WC = null; route(); }); };
      var b = $('#wcRe'); if (b) b.onclick = function () { W.busy = true; paintTop(); api({ action: PF + 'SbSync' }, true).then(function () { load(true); }, function () { load(true); }); };
    }
    function draw() {
      if (location.hash !== '#/wc' || (PF === 'wc' && !sess)) return;
      LS.set('wcView', W.view);
      var D = W.snap, nT = D ? D.tasks.length : 0;
      var body = W.err ? '<div class="wcerr"><b>读不到数据</b><p>' + esc(W.err) + '</p><button class="btn save" id="wcRetry">重试</button></div>' : !D ? '<p class="hint">读取中…</p>' :
        W.view === 'inv' ? vInv() : W.view === 'tasks' ? vTasks() : W.view === 'empty' ? vEmpty() : W.view === 'exp' ? vExp() : W.view === 'log' ? vLog() : W.view === 'tr' ? vTr() : vMap();
      app.innerHTML = '<div class="wc"><nav class="wcnav" aria-label="中控台"><div class="wcbrand"><span>AW</span><b>库位中控台</b></div>' + NAV.map(function (n) {
        return '<button class="wcn' + (W.view === n[0] ? ' on' : '') + '" data-v="' + n[0] + '">' + n[1] + (n[0] === 'tasks' && nT ? '<i>' + nT + '</i>' : '') + '</button>'; }).join('') + '</nav>' +
        '<section class="wcmain"><div class="wctop"><h2>' + esc(NAV.filter(function (n) { return n[0] === W.view; })[0][1]) + '</h2><div id="wcTop"></div></div>' + body + '</section></div>';
      paintTop(); bindAll();
    }
    function bindAll() {
      var all = function (sel, fn) { Array.prototype.forEach.call(app.querySelectorAll(sel), fn); };
      all('[data-v]', function (b) { b.onclick = function () { W.view = b.dataset.v; draw(); window.scrollTo(0, 0); }; });
      all('[data-ai]', function (b) { b.onclick = function () { W.aisle = b.dataset.ai; W.loc = ''; draw(); }; });
      all('[data-loc]', function (b) { b.onclick = function () { W.loc = b.dataset.loc; draw(); }; });
      all('[data-goloc]', function (b) { b.onclick = function () { var l = b.dataset.goloc, p = lmParts(l); if (!p) return; W.view = 'map'; W.aisle = p.a; W.loc = l; draw(); window.scrollTo(0, 0); }; });
      all('[data-ver]', function (b) { b.onclick = function () { act({ act: 'verify', id: b.dataset.ver }, '已核实'); }; });
      all('[data-rm]', function (b) { b.onclick = function () { confirmBox('确定“' + b.dataset.what + '”不在 ' + W.loc + ' 了？（记录会保留）', '不在这里了', function () { act({ act: 'remove', id: b.dataset.rm }, '已移走'); }); }; });
      all('[data-mv]', function (b) { b.onclick = function () {
        modal('<div class="tmiss"><h3>改到哪个库位？</h3><p class="hint">货没动、只是系统记错了才在这里改。</p><input id="wcMv" class="tqtyin" placeholder="例如 08-C-02" autocomplete="off" style="text-transform:uppercase"><div class="row" style="margin-top:10px"><button class="btn ghost" id="wcMvN">取消</button><button class="btn save" id="wcMvY">改库位</button></div></div>', function (m) {
          var go = function () { var v = normLocAny($('#wcMv', m).value); if (!lmParts(v)) return toast('库位格式不对', 2500); closeModal(); act({ act: 'move', id: b.dataset.mv, loc: v }, '已改到 ' + v).then(function () { var p = lmParts(v); W.aisle = p.a; W.loc = v; draw(); }); };
          $('#wcMvN', m).onclick = closeModal; $('#wcMvY', m).onclick = go; $('#wcMv', m).addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); }); setTimeout(function () { $('#wcMv', m).focus(); }, 50);
        }); }; });
      all('[data-add]', function (b) { b.onclick = function () { addAt(b.dataset.add); }; });
      all('[data-note]', function (b) { b.onclick = function () { noteEdit(b.dataset.note); }; });
      all('[data-bind]', function (b) { b.onclick = function () { bindTo(W.item, b.dataset.bind); }; });
      all('[data-sk]', function (b) { b.onclick = function () { skip(W.snap.tasks[+b.dataset.sk]); }; });
      all('[data-res]', function (b) { b.onclick = function () { var t = W.snap.tasks[+b.dataset.res]; confirmBox('箱码 ' + t.bc + ' 是“' + b.textContent + '”？系统会记住这个箱码，并把库位改到 ' + t.to + '。', '确定', function () { act({ act: 'resolve', taskId: t.id, recId: b.dataset.rec }, '已记住，库位已更新'); }); }; });
      all('[data-days]', function (b) { b.onclick = function () { W.days = +b.dataset.days; draw(); }; });
      all('[data-it]', function (b) { b.onclick = function () { W.item = b.dataset.it; draw(); }; });
      var q = $('#wcQ'); if (q) { var go = function () { W.q = q.value.trim(); W.item = ''; if (!W.q) return; rpc('wc_find', { p_token: cfg.d, p_q: W.q }).then(function (d) { W.found = (d.items || []).map(function (x) { return Array.isArray(x) ? x : [x, W.snap.items[x] || '']; }); if (W.found.length === 1) W.item = W.found[0][0]; draw(); }, function (e) { toast(e.message, 4000); }); };
        $('#wcGo').onclick = go; q.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); }); if (!W.q) q.focus(); }
      var bk = $('#wcBack'); if (bk) bk.onclick = function () { W.item = ''; draw(); };
      var lf = $('#wcLf'); if (lf) lf.oninput = function () { W.lf = lf.value; var p = lf.selectionStart; draw(); var n = $('#wcLf'); n.focus(); n.setSelectionRange(p, p); };
      var pr = $('#wcPrint'); if (pr) pr.onclick = function () { window.print(); };
      var rt = $('#wcRetry'); if (rt) rt.onclick = function () { W.sb = null; load(); };
    }
    /** v1.9.5 登记：商品 + 批次 → 库位（记为已核实） */
    function doBind(item, base, loc) {
      var D = W.snap; closeModal();
      return act({ act: 'bind', item: item, base: base, loc: loc, desc: D.items[item] || '', note: '中控台登记' }, '已登记 ' + loc).then(function () { var p = lmParts(loc); W.view = 'map'; W.aisle = p.a; W.loc = loc; draw(); });
    }
    function batchesOf(it) {
      var D = W.snap; return Object.keys(D.bat).map(function (k) { return D.bat[k]; }).filter(function (b) { return b.item === it; })
        .sort(function (a, b) { var x = dmy(a.exp), y = dmy(b.exp); return (x ? x.getTime() : 9e15) - (y ? y.getTime() : 9e15); });
    }
    /** 从库存查询：这个批次放在哪个库位 */
    function bindTo(item, base) {
      var D = W.snap;
      modal('<div class="tmiss"><h3>登记库位</h3><p><b>' + esc(D.items[item] || item) + '</b><br><span class="hint mono">' + esc(item) + ' · ' + (base ? '批次 ' + esc(base) : '不分批次') + '</span></p>' +
        '<input id="wcBl" class="tqtyin" placeholder="库位，例如 08-C-02" autocomplete="off" style="text-transform:uppercase"><div class="row" style="margin-top:10px"><button class="btn ghost" id="wcBlN">取消</button><button class="btn save" id="wcBlY">登记</button></div></div>', function (m) {
        var go = function () { var v = normLocAny($('#wcBl', m).value); if (!lmParts(v)) return toast('库位格式不对', 2500); doBind(item, base, v); };
        $('#wcBlN', m).onclick = closeModal; $('#wcBlY', m).onclick = go; $('#wcBl', m).addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); }); setTimeout(function () { var e = $('#wcBl', m); if (e) e.focus(); }, 50);
      });
    }
    /** 从库位图：这个库位放了什么（搜商品 → 选批次） */
    function addAt(loc) {
      var D = W.snap;
      modal('<div class="tmiss wcaddm"><h3>登记商品在 <span class="mono">' + loc + '</span></h3><div class="wcsearch"><input id="wcAq" placeholder="扫箱码或输入 Item Code / 品名" autocomplete="off"><button class="btn save" id="wcAgo">查询</button></div><div id="wcAr"></div><div class="row" style="margin-top:10px"><button class="btn ghost" id="wcAx">取消</button></div></div>', function (m) {
        var box = $('#wcAr', m), q = $('#wcAq', m);
        var pick = function (it) {
          var bs = batchesOf(it);
          box.innerHTML = '<p><b>' + esc(D.items[it] || it) + '</b> <span class="hint mono">' + esc(it) + '</span></p><p class="hint">选批次（按到期先后）：</p><div class="wclist">' +
            bs.map(function (b) { return '<button class="wcli" data-ab="' + esc(b.base) + '"><b class="mono">' + esc(b.base || '（不分批次）') + '</b><span class="hint">库存 ' + b.qty + ' ' + esc(b.uom) + ' · 到期 ' + esc(b.exp || '—') + '</span></button>'; }).join('') +
            (bs.some(function (b) { return !b.base; }) ? '' : '<button class="wcli" data-ab=""><b>不分批次</b><span class="hint">不知道批次 / 没有批次</span></button>') + '</div>';
          Array.prototype.forEach.call(box.querySelectorAll('[data-ab]'), function (b) { b.onclick = function () { doBind(it, b.dataset.ab, loc); }; });
        };
        var go = function () {
          var v = q.value.trim(); if (!v) return; box.innerHTML = '<p class="hint">查询中…</p>';
          rpc('wc_find', { p_token: cfg.d, p_q: v }).then(function (d) {
            var f = (d.items || []).map(function (x) { return Array.isArray(x) ? x : [x, D.items[x] || '']; });
            if (!f.length) { box.innerHTML = '<p class="hint">没有找到。新商品请先用手机【📍库位】登记。</p>'; return; }
            if (f.length === 1) return pick(f[0][0]);
            box.innerHTML = '<div class="wclist">' + f.map(function (x) { return '<button class="wcli" data-ai2="' + esc(x[0]) + '"><b>' + esc(x[1] || D.items[x[0]] || '') + '</b><span class="mono hint">' + esc(x[0]) + '</span></button>'; }).join('') + '</div>';
            Array.prototype.forEach.call(box.querySelectorAll('[data-ai2]'), function (b) { b.onclick = function () { pick(b.dataset.ai2); }; });
          }, function (e) { box.innerHTML = '<p class="hint red">' + esc(e.message) + '</p>'; });
        };
        $('#wcAx', m).onclick = closeModal; $('#wcAgo', m).onclick = go; q.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); }); setTimeout(function () { if (q.isConnected) q.focus(); }, 50);
      });
    }
    function normLocAny(v) { var s = String(v || '').trim().toUpperCase(); return s.replace(/^(\d{2})-?([A-Z])-?(\d{2})$/, '$1-$2-$3'); }
    currentRedraw = function () { if (location.hash === '#/wc') draw(); };
    draw();
    if (!W.snap || Date.now() - W.at > 30e3) load();
    clearInterval(W.timer); W.timer = setInterval(function () { if (location.hash === '#/wc' && !document.hidden && !W.busy && $('#modal').hidden) load(); }, 60e3);
  }

  // ---------- PDA：本机存储 + 离线队列 ----------
  var LDQ = null, ldMem = {}, ldFlushing = null, ldPendN = 0, ldLastErr = '';
  function ldLoadQ() {
    if (LDQ) return Promise.resolve(LDQ);
    return IDB.get('ld:q').then(function (q) { LDQ = LDQ || q || []; ldPendN = LDQ.filter(function (o) { return !(o.txn && o.txn.method === 'ALLOC'); }).length; renderNet(); return LDQ; }, function () { LDQ = LDQ || []; return LDQ; });
  }
  function ldSaveQ() { ldPendN = LDQ.filter(function (o) { return !(o.txn && o.txn.method === 'ALLOC'); }).length; renderNet(); return IDB.set('ld:q', LDQ); }
  function ldGet(id) { if (ldMem[id]) return Promise.resolve(ldMem[id]); return IDB.get('ld:' + id).then(function (s) { if (s) ldMem[id] = s; return s || null; }, function () { return null; }); }
  function ldPut(s) { ldMem[s.task.id] = s; pkLocalSave(s); return IDB.set('ld:' + s.task.id, s); }
  /** v1.5.3 拣货：手机里已下载的任务摘要（任务列表断网时用，不会变空白） */
  function pkLocalSave(s) {
    var t = s && s.task; if (!t || !/^PK-/i.test(t.id)) return;
    var c = ldCounts(s), cnt = 0; s.items.forEach(function (it) { cnt = r3(cnt + (c[it.key] || 0)); });
    var all = LS.get('pkLocal', {});
    all[t.id] = { id: t.id, date: t.date, doCount: t.doCount, itemCount: s.items.length, required: t.required, counted: cnt, assignedTo: t.assignedTo || '', customer: t.customer || '', dos: t.dos || '',
      status: s.localDone ? '已完成' : t.status, at: new Date().toISOString() };
    LS.set('pkLocal', all);
  }
  function ldFromServer(d, old) {
    var items = d.items.map(function (r) { var o = {}; d.itemCols.forEach(function (c, i) { o[c] = r[i]; }); return o; });
    var txns = {};
    d.txns.forEach(function (r) { var o = {}; d.txnCols.forEach(function (c, i) { o[c] = r[i]; }); o.synced = true; txns[o.id] = o; });
    if (old) Object.keys(old.txns).forEach(function (k) { if (!txns[k] && !old.txns[k].synced) txns[k] = old.txns[k]; });    // 本机还没上传的
    var s = { task: d.task, items: items, txns: txns, localDone: !!(old && old.localDone && d.task.status !== '已完成'), fetched: new Date().toISOString() };
    if (s.localDone) s.task.status = '已完成';
    return s;
  }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function ldCounts(s) { var c = {}; Object.keys(s.txns).forEach(function (k) { var t = s.txns[k]; c[t.key] = r3((c[t.key] || 0) + Number(t.qty)); }); return c; }
  function ldItemSt(req, c, done) { return c > req ? '超出' : c === req ? '已点齐' : done ? '短少' : c > 0 ? '点货中' : '未点'; }
  function ldCodes(it) { if (!it._codes) it._codes = [it.code].concat(String(it.bc || '').split(' / ')).map(ldNorm).filter(Boolean); return it._codes; }
  function ldPending(id) { return (LDQ || []).filter(function (o) { return o.taskId === id && !(o.txn && o.txn.method === 'ALLOC'); }).length; }   // v1.9.12 分货那一笔不单独算
  function ldFlush() {
    if (ldFlushing) return ldFlushing;
    if (!cfg || !sess || cfg.r) return Promise.resolve();
    ldFlushing = ldLoadQ().then(function step() {
      if (!LDQ.length) return;
      var first = LDQ[0];
      if (first.op === 'submit') {
        return ldGet(first.taskId).then(function (s) {
          var ids = s ? Object.keys(s.txns) : [];
          return api({ action: 'ldSubmit', taskId: first.taskId, txnIds: ids }, true).then(function (d) {
            if (d.status === 'missing') throw new Error('还有点货记录没上传完');
            LDQ.shift();
            if (d.status === 'rejected' && d.gone) return ldPurge(first.taskId).then(step);
            if (d.status === 'rejected') toast('完成提交被退回：' + (d.message || ''), 4000);
            if (s && d.task) { s.task = d.task; s.localDone = false; }
            return (s ? ldPut(s) : Promise.resolve()).then(ldSaveQ).then(step);
          });
        });
      }
      var batch = [], rejT = {};
      for (var i = 0; i < LDQ.length && batch.length < 40 && LDQ[i].op === 'txn'; i++) batch.push(LDQ[i]);
      return api({ action: 'ldTxns', txns: batch.map(function (o) { return o.txn; }) }, true).then(function (d) {
        var res = {}; (d.results || []).forEach(function (r) { res[r.txnId] = r; });
        var ps = [];
        batch.forEach(function (o) {
          var r = res[o.txn.txnId]; if (!r) return;
          LDQ.splice(LDQ.indexOf(o), 1);
          if (r.status === 'rejected') { rejT[o.taskId] = 1; toast((/EDIT|VOID|ADJUST|REVERSAL/.test(o.txn.method) ? '修改被退回：' : '有一笔点货被退回：') + r.message, 5000); var rj = LS.get('ldRejected', []); rj.push({ o: o, msg: r.message, at: new Date().toISOString() }); LS.set('ldRejected', rj.slice(-100)); }
          ps.push(ldGet(o.taskId).then(function (s) {
            if (!s || !s.txns[o.txn.txnId]) return;
            if (r.status === 'rejected') delete s.txns[o.txn.txnId]; else s.txns[o.txn.txnId].synced = true;
            return ldPut(s);
          }));
        });
        return Promise.all(ps).then(ldSaveQ).then(function () { return ldRefetch(Object.keys(rejT)); }).then(step);
      });
    }).then(function () { ldFlushing = null; ldLastErr = ''; if (ldRedraw) ldRedraw(); }, function (e) { ldFlushing = null; ldLastErr = e.message; renderNet(); if (ldRedraw) ldRedraw(); });
    return ldFlushing;
  }
  var ldRedraw = null;
  var LD_GONE = '这个装车任务已被删除或取消';
  var ldMovedMsg = {};      // v1.7 拣货任务改派给别人 / 取消分配
  function ldGone(id) { return ldMovedMsg[id] || (ldModOf(id) === 'pk' ? '这个拣货任务已被删除或取消' : LD_GONE); }
  var ldOnGone = null;      // 正在看的任务被删除时，页面要做的事
  /** v1.4.5 任务已被删除：清掉手机上的这个任务和它还没上传的记录（其他任务不受影响） */
  function ldPurge(tid, moved) {
    if (moved) ldMovedMsg[tid] = typeof moved === 'string' ? moved : '这个拣货任务已改派给别人（或取消了分配），不能再在这台 PDA 上拣';
    delete ldMem[tid];
    if (!moved) LDQ = (LDQ || []).filter(function (o) { return o.taskId !== tid; });   // v1.7 改派：本机还没上传的记录保留，继续上传（改派前拣的后台照收）
    ['ldTasks', 'pkTasks'].forEach(function (ck) { var ts = LS.get(ck, null); if (ts) LS.set(ck, ts.filter(function (t) { return t.id !== tid; })); });
    var pl = LS.get('pkLocal', null); if (pl && pl[tid]) { delete pl[tid]; LS.set('pkLocal', pl); }
    return Promise.all([IDB.kdel('ld:' + tid).catch(function () { }), ldSaveQ()]).then(function () { if (ldOnGone) ldOnGone(tid); if (moved) ldFlush(); });
  }
  /** 有修改被退回（别人已经改过 / 任务已删除）→ 重新下载这个任务，手机上显示最新的数量 */
  function ldRefetch(ids) {
    return Promise.all(ids.map(function (tid) {
      return api({ action: 'ldTask', taskId: tid }, true).then(function (d) {
        if (d.error === 'NOTASK') return ldPurge(tid, d.moved ? d.message : false);
        if (d.error) return;
        return ldGet(tid).then(function (cur) { return ldPut(ldFromServer(d, cur)); });
      }).catch(function () { });
    }));
  }
  ldLoadQ().then(function () { if (ldPendN && sess) ldFlush(); });

  // ---------- PDA：任务列表 ----------
  function ldBadge(s) { return '<span class="ldb ' + ({ '待点货': 'b1', '点货中': 'b2', '已完成': 'b3' }[s] || 'b1') + '">' + esc(s) + '</span>'; }
  function viewLdList(mod) {
    mod = mod === 'pk' ? 'pk' : 'ld'; LDW_MOD = mod;
    var base = '#/' + mod, CK = mod === 'pk' ? 'pkTasks' : 'ldTasks';
    setBar(mod === 'pk' ? '仓库拣货' : '装车点货', false);
    var cached = LS.get(CK, null), note = '', offline = false;
    /** v1.5.3 拣货：服务器列表 + 手机里已下载的任务；已下载的用手机上的最新数量 */
    function merge(list, fromServer) {
      if (mod !== 'pk') return list;
      var loc = LS.get('pkLocal', {}), out = [], seen = {};
      (list || []).forEach(function (t) {
        var l = loc[t.id]; seen[t.id] = 1;
        out.push(l ? Object.assign({}, t, { counted: l.counted, status: l.status === '已完成' ? '已完成' : t.status, local: true }) : t);
      });
      Object.keys(loc).sort().reverse().forEach(function (k) {
        if (seen[k]) return;
        if (fromServer && !ldPending(k)) return;          // 联网时服务器列表里已经没有（已删除 / 太旧）又没有待上传的 → 不显示
        if (loc[k].assignedTo && loc[k].assignedTo !== operator) return;   // v1.7 同一台 PDA 换了员工：只显示自己的任务
        out.push(Object.assign({}, loc[k], { local: true }));
      });
      return out;
    }
    if (mod === 'pk') { var m0 = merge(cached, false); cached = m0.length || cached ? m0 : null; }
    function draw(list) {
      if (list) {        // v1.4.2：待点货 → 点货中 → 已完成（同组保持后台顺序：新的在上）
        var rank = { '待点货': 0, '点货中': 1, '已完成': 2 };
        list = list.map(function (t, i) { var st = ldMem[t.id] && ldMem[t.id].localDone ? '已完成' : t.status; return { t: t, i: i, r: rank[st] == null ? 1 : rank[st] }; })
          .sort(function (a, b) { return (a.r - b.r) || (a.i - b.i); }).map(function (x) { return x.t; });
      }
      app.innerHTML = modTabs(mod) + ldW('<div class="topline"><span>员工：<span data-nt>' + esc(operator) + '</span></span><button class="link" id="lr">刷新</button></div>' +
        (note ? '<p class="hint">' + esc(note) + '</p>' : '') +
        (!list ? '<div class="empty">加载中…</div>' : list.length ? '' : '<div class="empty">' + (mod === 'pk' && offline ? '现在没有网络，手机里也还没有下载过的拣货任务。<br>联网后打开任务一次，之后断网也能继续。' : (mod === 'pk' ? '没有分配给你的拣货任务。办公室在上传电脑分配后会出现在这里。' : '没有装车任务。办公室上传 DO 后会出现在这里。')) + '</div>') +
        (list || []).map(function (t) {
          var pct = t.required ? Math.min(100, t.counted / t.required * 100) : 0, pend = ldPending(t.id);
          var dl = mod === 'pk' ? (t.local ? '<span class="pkdl">📥 已下载，可离线</span>' : offline ? '<span class="pkdl no">未下载，需联网打开一次</span>' : '') : '';
          return '<button class="card job ldtask' + (mod === 'pk' && offline && !t.local ? ' nodl' : '') + '" data-id="' + esc(t.id) + '"><div class="id">' + esc(t.id) + ' ' + ldBadge(t.status) + dl + '</div>' +
            '<div class="meta"><span>日期</span><b>' + esc(t.date) + '</b><span>DO</span><b' + (mod === 'pk' && t.doCount === 1 && t.dos ? ' data-nt>' + esc(t.dos) : '>' + t.doCount + ' 张') + (t.carry ? ' + 之前未装 ' + t.carry + ' 项' : '') + '</b>' +
            (mod === 'pk' && t.customer ? '<span>客户</span><b data-nt>' + esc(t.customer) + '</b>' : '') +
            '<span>商品</span><b>' + t.itemCount + ' 项</b><span>数量</span><b>已点 ' + t.counted + ' / 需求 ' + t.required + '</b></div>' +
            '<div class="progress"><i class="d" style="width:' + pct + '%"></i></div>' +
            (pend ? '<div class="ptext err">本机还有 ' + pend + ' 笔没上传</div>' : '') + '</button>';
        }).join(''));
      Array.prototype.forEach.call(app.querySelectorAll('.ldtask'), function (b) { b.onclick = function () { location.hash = ldHash(b.dataset.id); }; });
      $('#lr').onclick = load; bindModTabs();
    }
    function load() {
      api({ action: 'ldTasks', mod: mod }, true).then(function (d) { LS.set(CK, d.tasks); note = ''; offline = false; if (location.hash === base) draw(merge(d.tasks, true)); },
        function (e) {
          offline = !!e.network;
          note = e.network ? (mod === 'pk' ? '没有网络：显示手机里的任务，可以继续拣货，记录联网后自动上传' : '离线：显示上次的任务列表') : e.message;
          if (location.hash === base) draw(mod === 'pk' ? merge(LS.get(CK, null), false) : (cached || []));
        });
    }
    draw(cached); load(); ldFlush();
    ldLoadQ().then(function () { if (location.hash === base && ldPendN) draw(mod === 'pk' ? merge(LS.get(CK, null), false) : cached); });   // 待上传笔数读出来后再画一次
  }

  // ---------- PDA：点货 ----------
  function viewLdTask(id, review, idx) {
    var mod = ldModOf(id), PK = mod === 'pk', modal = ldModal; LDW_MOD = mod;      // v1.5 拣货任务（PK-）用同一套画面
    var IT = PK && !review && idx != null ? idx : null;                              // v1.5.1 拣货 SKU 页（整页）
    var U = PK ? (pkUi[id] = pkUi[id] || { filter: 'all', pq: '', locF: '', chip: null, y: 0 }) : null;
    var ent = pkEntry; pkEntry = null;
    setBar(review ? '复核' : ldW('装车点货'), true);
    var s = null, filter = U ? U.filter : 'todo', msg = null, busy = false; var keepVal = '', keepFocus = false, pq = U ? U.pq : '', restoreY = PK && IT == null && !review;     // 装车每次打开任务都从“未点完”开始
    function done() { return s && s.task.status === '已完成'; }
    function stats() {
      var c = ldCounts(s), so = PK ? ldShortOkC(s) : {}, o = { n: s.items.length, ok: 0, todo: 0, prog: 0, over: 0, short: 0, req: 0, cnt: 0 };
      s.items.forEach(function (it) {
        var v = c[it.key] || 0, st = ldItemSt(it.req, v, done() || !!so[it.key]);
        it._c = v; it._st = st; it._so = so[it.key] || ''; o.req = r3(o.req + it.req); o.cnt = r3(o.cnt + v);
        if (st === '已点齐') o.ok++; else if (st === '超出') o.over++; else if (st === '未点') o.todo++; else if (st === '短少') o.short++; else o.prog++;
      });
      return o;
    }
    function itemName(it) {
      if (PK && LANG === 'my') return it.descMy ? '<span class="myn" data-nt>' + esc(it.descMy) + '</span><small class="zhn" data-nt>' + esc(it.desc) + '</small>' : '<span data-nt>' + esc(it.desc) + '</span>';
      return esc(it.desc) + (it.origin === '之前' ? ' <span class="ldold">之前 ' + esc(it.originDate) + '</span>' : '');
    }
    /** 提示文字里的品名（缅甸语模式用缅甸语品名） */
    function dn(it) { return PK && LANG === 'my' && it.descMy ? it.descMy : it.desc; }
    /** 拣货：库位 + 批次号（大字） */
    function pkTag(it) { return PK ? '<i class="pkb' + (it.loc ? '' : ' no') + '">' + esc(it.loc || '无库位') + '</i> ' + (it.batch ? '<span data-nt>' + esc(it.batch) + '</span>' : '（没有批次号）') + ' · ' : ''; }
    function itemRow(it) {
      var diff = r3(it._c - it.req);
      if (PK) return '<button class="ldi pki ' + ({ '未点': 's0', '点货中': 's1', '已点齐': 's2', '超出': 's3', '短少': 's4' }[it._st]) + (it.flag ? ' pkflag' : '') + '" data-k="' + esc(it.key) + '">' +
        '<div class="pkloc' + (it.loc ? '' : ' no') + '" data-fl="' + esc(it.loc) + '"' + (it.loc ? ' data-nt' : '') + '>' + (it.loc ? esc(it.loc) : '无库位') + '</div>' +
        '<div class="ldi-t"><div class="pkbatch" data-fb="' + esc(it.batch) + '"' + (it.batch ? ' data-nt' : '') + '>' + esc(it.batch || '（没有批次号）') + '</div><b>' + itemName(it) + '</b><span>' + esc(ldId(it, '')) + (it.spec ? ' · ' + esc(it.spec) : '') + (it.flag ? '</span><span class="pkwarn">⚠ ' + esc(it.flag) : '') + (it.locNote ? '</span><span class="pkfix">📍 ' + esc(it.locNote) : '') + '</span></div>' +
        '<div class="ldi-n"><b>' + it._c + '<small> / ' + it.req + ' ' + esc(it.uom) + '</small></b><span>' + esc(it._so && it._c < it.req ? '已确认短少' : it._st) + (diff && it._c ? '（' + (diff > 0 ? '+' : '') + diff + '）' : '') + '</span></div></button>';
      return '<button class="ldi ' + ({ '未点': 's0', '点货中': 's1', '已点齐': 's2', '超出': 's3', '短少': 's4' }[it._st]) + '" data-k="' + esc(it.key) + '">' +
        '<div class="ldi-t"><b>' + itemName(it) + '</b><span>' + esc(ldId(it, '')) + (it.spec ? ' · ' + esc(it.spec) : '') + '</span></div>' +
        '<div class="ldi-n"><b>' + it._c + '<small> / ' + it.req + ' ' + esc(it.uom) + '</small></b><span>' + esc(it._st) + (diff && it._c ? '（' + (diff > 0 ? '+' : '') + diff + '）' : '') + '</span></div></button>';
    }
    function draw() {
      if (!s) { app.innerHTML = ldW('<div class="empty">' + esc(msg ? msg.text : '加载中…') + '</div>'); return; }
      var o = stats(), pend = ldPending(id);
      setBar((review ? '复核 · ' : '') + s.task.id, true);
      var head = '<div class="card ldhead"><div class="ldhead-t"><b>' + esc(s.task.id) + '</b> ' + ldBadge(s.task.status) + '<span class="hint">' + esc(s.task.date) + ' · DO ' + s.task.doCount + ' 张</span></div>' +
        (PK ? '<div class="ldstat"><div><b>' + o.n + '</b><span>商品</span></div><div class="g"><b>' + (o.ok + o.over + o.short) + '</b><span>拣完</span></div><div class="o"><b>' + (o.todo + o.prog) + '</b><span>未拣完</span></div><div class="p"><b>' + o.short + '</b><span>短少</span></div></div>' +
          '<div class="progress"><i class="d" style="width:' + (o.n ? (o.ok + o.over + o.short) / o.n * 100 : 0) + '%"></i></div>' :
        '<div class="ldstat"><div><b>' + o.n + '</b><span>商品</span></div><div class="g"><b>' + (o.ok + o.over) + '</b><span>点齐</span></div><div class="o"><b>' + (o.todo + o.prog + o.short) + '</b><span>未点完</span></div><div class="p"><b>' + o.over + '</b><span>超出</span></div></div>' +
        '<div class="progress"><i class="d" style="width:' + (o.n ? (o.ok + o.over) / o.n * 100 : 0) + '%"></i></div>') +
        '<div class="hint">数量：已点 <b>' + o.cnt + '</b> / 需求 ' + o.req + (pend ? ' · <span class="err">本机 ' + pend + ' 笔待上传</span>' : '') + (ldLastErr && pend ? ' · ' + esc(ldLastErr) : '') + '</div></div>';
      if (review) return drawReview(head, o);
      var im = prefs.pda ? 'none' : 'text', keep = $('#ldIn');
      keepVal = keep ? keep.value : ''; keepFocus = !!keep && document.activeElement === keep;   // 重画时不吞掉正在扫的条码
      if (IT != null) return drawItem();
      app.innerHTML = ldW(head + (msg ? '<div class="tmsg ' + msg.cls + '">' + esc(msg.text) + '</div>' : '') +
        (PK ? '' : '<div class="row tsub ldfenrow"><button class="btn ldfenb" id="ldFen">📦 分货：扫商品看每家几箱</button><button class="btn ldfenb2" id="ldCs">🧾 各家差货</button></div>') +
        (done() ? '<div class="card lddone">✓ 已完成' + (s.task.submittedBy ? '（' + esc(s.task.submittedBy) + ' ' + esc(s.task.submitted) + '）' : s.localDone ? '（待上传）' : '') + '，不能再修改。需要更正请找办公室重新打开。</div>' :
          (PK ? '<div class="bcrow tscan"><input id="ldIn" inputmode="' + im + '" maxlength="64" autocomplete="off" spellcheck="false" placeholder="扫码 / 搜索商品（品名、条码后几位、批次、库位）" value="' + esc(pq) + '"><button class="btn cam" id="ldCam">📷</button></div>' :
          '<div class="bcrow tscan"><input id="ldIn" inputmode="' + im + '" maxlength="64" autocomplete="off" spellcheck="false" placeholder="扫描条码，或点这里手输（后几位 / 品名）"><button class="btn cam" id="ldCam">📷 扫描</button></div>' +
          '<div class="row tsub"><button class="tbtn" id="ldSearch">🔍 搜索 / 全部商品</button></div>')) +
        (PK ? pkFilterHtml() : '') +
        '<div class="ldf">' + (PK ? [['todo', '未拣完 ' + (o.todo + o.prog)], ['over', '超出 ' + o.over], ['ok', '已拣完 ' + (o.ok + o.short)], ['all', '全部 ' + o.n]] :
          [['todo', '未点完 ' + (o.todo + o.prog + o.short)], ['over', '超出 ' + o.over], ['ok', '已点齐 ' + o.ok], ['all', '全部 ' + o.n]]).map(function (f) {
          return '<button data-f="' + f[0] + '" class="' + (filter === f[0] && !(PK && pq.trim()) ? 'on' : '') + '">' + f[1] + '</button>';
        }).join('') + '</div><div id="ldList">' + listHtml() + '</div>' +
        '<div id="dock" class="dock"><button class="btn ghost" id="ldHist" style="flex:0 0 36%">点货记录</button>' +
        (done() ? '<button class="btn ghost" id="ldRev">查看结果</button>' : '<button class="btn save" id="ldRev">完成点货 →</button>') + '</div>');
      bind();
    }
    /** 商品列表：装车按状态排；拣货保持后台的库位顺序（没有库位的在最后），页面上的筛选框即时过滤 */
    /** 拣货列表的筛选区：库位（通道号）下拉 + 点批次 / 库位得到的筛选标签（和扫码 / 搜索入口分开） */
    function pkFilterHtml() {
      var nos = {}; s.items.forEach(function (it) { nos[it.loc ? it.loc.slice(0, 2) : '-'] = 1; });
      var opts = Object.keys(nos).sort();
      return '<div class="pkfil"><label class="pksel">库位 <select id="pkLoc"><option value="">全部</option>' + opts.map(function (k) {
        return '<option value="' + k + '"' + (U.locF === k ? ' selected' : '') + '>' + (k === '-' ? '无库位' : k + ' 号') + '</option>';
      }).join('') + '</select></label>' +
        (U.chip ? '<span class="pkchip">' + (U.chip.t === 'b' ? '批次 ' : '库位 ') + esc(U.chip.v || '（空）') + ' <button id="pkChipX" aria-label="取消筛选">✕</button></span>' : '<span class="hint">点批次号或库位可以只看它</span>') + '</div>';
    }
    function pkBase() {
      return s.items.filter(function (it) {
        if (U.locF && (U.locF === '-' ? !!it.loc : (it.loc || '').slice(0, 2) !== U.locF)) return false;
        if (U.chip && (U.chip.t === 'b' ? it.batch !== U.chip.v : it.loc !== U.chip.v)) return false;
        return true;
      });
    }
    function listHtml() {
      var list;
      if (PK) {
        var base = pkBase();
        if (pq.trim()) { var hit = find(pq); list = base.filter(function (it) { return hit.indexOf(it) >= 0; }); }
        else list = base.filter(function (it) {
          return filter === 'all' ? true : filter === 'todo' ? !(it._c >= it.req || it._so) : filter === 'over' ? it._c > it.req : it._c === it.req || (it._so && it._c < it.req);
        });
        return (pq.trim() ? '<p class="hint">搜索“<span data-nt>' + esc(pq.trim()) + '</span>”：' + list.length + ' 项（所有状态）</p>' : '') +
          (list.length ? list.map(itemRow).join('') : '<div class="empty">' + (pq.trim() ? '没有找到。可以输入品名、条码后几位、批次号或库位（如 07-J）' : filter === 'todo' && base.length === s.items.length ? '全部拣完了 👍 可以点“完成拣货”复核' : '没有') + '</div>');
      }
      if (PK && pq.trim()) list = find(pq);
      else {
        list = s.items.filter(function (it) {
          return filter === 'all' ? true : filter === 'todo' ? it._c < it.req : filter === 'over' ? it._c > it.req : it._c === it.req;
        });
        if (!PK) {
          var order = { '点货中': 0, '未点': 1, '短少': 1, '超出': 2, '已点齐': 3 };
          list.sort(function (a, b) { return (order[a._st] - order[b._st]) || ((b.origin === '之前') - (a.origin === '之前')); });    // 之前未装的排在前面
        }
      }
      return (PK && pq.trim() ? '<p class="hint">筛选“' + esc(pq.trim()) + '”：' + list.length + ' 项（所有状态）</p>' : '') +
        (list.length ? list.map(itemRow).join('') : '<div class="empty">' + (PK && pq.trim() ? '没有找到。可以输入库位（如 07-J）、批次号、品名或条码后几位' : filter === 'todo' ? '全部点齐了 👍 可以点“完成点货”复核' : '没有') + '</div>');
    }
    function bindRows() {
      Array.prototype.forEach.call(app.querySelectorAll('.ldi'), function (b) {
        b.onclick = function (e) {
          var fb = PK && e.target.closest && e.target.closest('[data-fb]'), fl = PK && e.target.closest && e.target.closest('[data-fl]');
          if (fb || fl) { U.chip = fb ? { t: 'b', v: fb.dataset.fb } : { t: 'l', v: fl.dataset.fl }; pq = U.pq = ''; var x = $('#ldIn'); if (x) x.value = ''; draw(); window.scrollTo(0, 0); return; }
          if (PK) openIt(byKey(b.dataset.k), 'SEARCH', ''); else detail(byKey(b.dataset.k));
        };
      });
    }
    /** 打开商品：拣货 → SKU 整页；装车 → 原来的输入数量弹窗 */
    function openIt(it, method, code) {
      if (!it) return;
      if (!PK) return qty(it, method, code);
      closeModal();
      pkEntry = { key: it.key, method: method || 'SEARCH', code: code || '' };
      var url = ldHash(id) + '/i/' + s.items.indexOf(it);
      if (IT != null) location.replace(url); else { U.y = window.scrollY || 0; location.hash = url; }
    }
    function pkDoneIt(it) { return it._c >= it.req || !!it._so; }
    function pkNext(i) { var n = s.items.length; for (var k = 1; k < n; k++) { var it = s.items[(i + k) % n]; if (!pkDoneIt(it)) return it; } return null; }
    /** 列表页：回车 / 扫描枪 → 条码对上就进 SKU 页；对不上的长数字当未知条码；文字就是搜索 */
    function pkEnter(raw) {
      raw = String(raw || '').trim(); var inp = $('#ldIn');
      if (!raw) return;
      var q = ldNorm(raw), exact = s.items.filter(function (it) { return ldCodes(it).indexOf(q) >= 0; });
      if (exact.length || /^\d{8,}$/.test(q)) { if (inp) inp.value = ''; pq = U.pq = ''; }
      if (exact.length === 1) return openIt(exact[0], 'BARCODE', raw);
      if (exact.length > 1) { draw(); return pick(exact, '这个条码对应 ' + exact.length + ' 行（不同批次），请选择', '', raw); }
      if (/^\d{8,}$/.test(q)) { draw(); return handle(raw, 'BARCODE'); }
      var lc = normLoc(raw);
      if (lc && locRe().test(lc)) { if (inp) inp.value = ''; pq = U.pq = ''; U.chip = { t: 'l', v: lc }; draw(); return toast('库位 ' + lc + '：只显示这个库位的商品', 2500); }
      pq = U.pq = raw;
      var hit = find(raw), base = pkBase(), r = base.filter(function (it) { return hit.indexOf(it) >= 0; });
      if (r.length === 1) return openIt(r[0], 'SEARCH', '');
      draw();
    }
    // ---------- v1.5.1 拣货 SKU 页（整页）：大库位 / 批次、应拣 / 已拣 / 差异、页面内数量框、这个商品的记录 ----------
    function histRows(it, ro) {
      var list = Object.keys(s.txns).map(function (k) { return s.txns[k]; }).filter(function (t) { return t.key === it.key && ORIG.indexOf(t.method) >= 0 && !(PK && t.method === 'ADJUST' && false); }).sort(byTime);
      var rows = list.map(function (t, i) {
        var st = txState(t.id), adj = t.method === 'ADJUST', v = st.voided;
        var head = adj ? '调整累计 ' + t.orig + ' → ' + t.to : ML[t.method] || t.method;
        var sub = [hhmm(t.time), t.staff || ''];
        var nt = function (x) { return '<span data-nt>' + esc(x || '') + '</span>'; };     // 员工名字不翻译
        if (PK) { head = hhmm(t.time); sub = [nt(t.staff)]; if (t.aloc) sub.push('<span>' + esc('库位 ' + t.aloc) + '</span>'); }
        if (t.code && !PK) sub.push('码 ' + t.code);
        if (t.reason) sub.push(PK ? '<span>原因：' + nt(t.reason) + '</span>' : '原因：' + t.reason);
        st.edits.forEach(function (e) { sub.push(PK ? '<span>' + esc('改 ' + e.orig + '→' + e.to) + '（' + nt(e.staff) + ' ' + esc(hhmm(e.time)) + '）</span>' : '改 ' + e.orig + '→' + e.to + '（' + (e.staff || '') + ' ' + hhmm(e.time) + '）'); });
        if (v) sub.push(PK ? '<span>已撤销（' + nt(v.staff) + ' ' + esc(hhmm(v.time)) + '）</span>' : '已撤销（' + (v.staff || '') + ' ' + hhmm(v.time) + '）');
        if (!t.synced) sub.push('<span class="err">未上传</span>');
        var q = adj ? sg(Number(t.qty)) : (st.edits.length && !v ? '<s>' + t.qty + '</s> ' + st.eff : String(t.qty));
        return '<div class="ldh' + (v ? ' gone' : '') + '"><span class="t"><b>#' + (i + 1) + ' ' + esc(head) + (st.edits.length && !v ? ' <span class="ldedited">已修改</span>' : '') + '</b><span>' + sub.map(function (x) { return /^<span/.test(x) ? x : esc(x); }).join(' · ') + '</span></span>' +
          '<b class="q">' + q + '</b>' + (!ro && !v ? '<span class="ldacts">' + (adj ? '' : '<button class="tbtn" data-ed="' + esc(t.id) + '">修改</button>') + '<button class="tbtn" data-vd="' + esc(t.id) + '">撤销</button></span>' : '') + '</div>';
      });
      if (PK) rows.reverse();          // 拣货：最新的在上
      return { n: list.length, html: rows.join('') };
    }
    function bindHist(it, m) {
      Array.prototype.forEach.call((m || app).querySelectorAll('[data-ed]'), function (b) { b.onclick = function () { editTxn(it, s.txns[b.dataset.ed]); }; });
      Array.prototype.forEach.call((m || app).querySelectorAll('[data-vd]'), function (b) { b.onclick = function () { voidTxn(it, s.txns[b.dataset.vd]); }; });
    }
    function back(it) { if (PK && IT != null) { closeModal(); draw(); } else detail(it, 0); }
    // ---------- v1.5.2 拣货 SKU 页：固定布局 + 页面内数字键盘（不弹系统键盘，页面不跳） ----------
    var kpv = '';          // 本次数量（还没确认）
    var aloc = '';         // v1.6 这个商品页扫到的实际取货库位（可不扫；换商品清空）
    function pkLocCode(raw) { var c = normLoc(raw); return c && locRe().test(c) ? c : ''; }
    function pkSetLoc(c, it, manual) {
      if (!manual && aloc && c === aloc) { beep(); msg = { cls: 'good', text: '库位 ' + c + ' 已经记录过了（没有变化）' }; return draw(); }
      if (!manual && aloc && c !== aloc) {
        errBeep();
        return confirmBox('把实际取货库位从 ' + aloc + ' 改成 ' + c + '？', '改成 ' + c, function () { pkSetLoc(c, it, true); });
      }
      aloc = c; beep();
      msg = { cls: !it.loc || c === it.loc ? 'good' : 'bad', text: '实际库位 ' + c + (!it.loc ? '（系统没有库位）' : c === it.loc ? ' ✓ 和系统库位一致' : ' ⚠ 和系统库位 ' + it.loc + ' 不一样') };
      draw();
    }
    function pkLocInput(it) {
      modal('<div class="ldq"><div class="ldq-h">实际取货库位</div><p class="hint">扫货架上的库位码；标签坏了可以在这里输入，例如 07-J-01</p>' +
        '<input id="alIn" class="pkq" maxlength="20" autocomplete="off" autocapitalize="characters" placeholder="07-J-01" value="' + esc(aloc) + '"><div id="alM" class="ldq-m"></div>' +
        '<div class="row"><button class="btn ghost" id="alC">取消</button>' + (aloc ? '<button class="btn ghost" id="alX">清除</button>' : '') + '<button class="btn save" id="alO">确定</button></div></div>', function (m) {
          var ax = $('#alX', m); if (ax) ax.onclick = function () { closeModal(); aloc = ''; msg = null; draw(); };
          var inp = $('#alIn', m), ok = function () {
            var c = pkLocCode(inp.value);
            if (!c) { $('#alM', m).className = 'ldq-m err'; $('#alM', m).textContent = '库位格式不对，例如 07-J-01'; errBeep(); return; }
            closeModal(); pkSetLoc(c, it, true);
          };
          inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
          $('#alO', m).onclick = ok; $('#alC', m).onclick = closeModal;
          setTimeout(function () { inp.focus(); }, 50);
        });
    }
    function kpPad(id) {
      return '<div class="kp" id="' + id + '">' + ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'b'].map(function (k) {
        return '<button type="button" tabindex="-1" data-k="' + k + '"' + (k === 'b' ? ' aria-label="退格"' : '') + '>' + (k === 'b' ? '⌫' : k) + '</button>';
      }).join('') + '</div>';
    }
    function drawItem() {
      var it = s.items[IT];
      if (!it) { location.replace(ldHash(id)); return; }
      var ro = done(), rem = r3(it.req - it._c), d = r3(it._c - it.req), nx = pkNext(IT), H = histRows(it, ro);
      if (ent && ent.key === it.key && ent.method === 'BARCODE' && !ent.shown && !msg) { ent.shown = true; msg = { cls: 'good', text: '✓ 扫码识别：' + dn(it) + '，请输入本次数量' }; }
      setBar((it.loc || '无库位') + ' · 第 ' + (IT + 1) + ' / ' + s.items.length + ' 项', true);
      app.innerHTML = ldW('<div class="pks">' +
        (ro ? '<div class="card lddone">✓ 任务已完成，不能再修改。需要更正请找办公室重新打开。</div>' :
          '<div class="pks-scan"><input id="ldIn" inputmode="none" maxlength="64" autocomplete="off" spellcheck="false" placeholder="扫箱码 / 扫库位码 / 搜索商品"><button class="btn cam" id="ldCam" aria-label="摄像头扫码">📷</button></div>') +
        '<div class="pks-it' + (it.flag ? ' pkflag' : '') + '"><div class="pks-top"><div class="pkloc big' + (it.loc ? '' : ' no') + '">' + (it.loc ? esc(it.loc) : '无库位') + '</div>' +
        '<div class="pkit-b"><span>批次号</span><b' + (it.batch ? ' data-nt' : '') + '>' + esc(it.batch || '（没有批次号）') + '</b></div></div>' +
        (ro ? '' : '<button type="button" tabindex="-1" class="pks-al' + (aloc ? (!it.loc || aloc === it.loc ? ' ok' : ' diff') : '') + '" id="pkAl">' +
          '<span class="al-t"><span>实际取货库位' + (aloc ? '' : '（选填）') + '</span><u>' + (aloc ? '✎ 修改' : '✎ 手输') + '</u></span>' +
          '<span class="al-v">' + (aloc ? '<b data-nt>' + esc(aloc) + ' ✓</b><i>' + (!it.loc || aloc === it.loc ? '已记录实际取货位置' : '⚠ 和系统库位 ' + esc(it.loc) + ' 不一样') + '</i>' : '<em>尚未记录 · 扫描货架码即可自动记录</em>') + '</span></button>') +
        '<div class="pks-desc">' + itemName(it) + '</div>' +
        '<div class="pks-code">' + esc(ldId(it, '条码 ')) + ' · ' + esc(it.uom || '') + (it.flag ? ' · <span class="pkwarn">⚠ ' + esc(it.flag) + '</span>' : '') + (it.locNote ? ' · <span class="pkfix">📍 ' + esc(it.locNote) + '</span>' : '') + '</div></div>' +
        '<div class="pks-st"><div><span>应拣</span><b>' + it.req + '</b></div><div><span>累计已拣</span><b id="pkCnt">' + it._c + '</b></div>' +
        '<div class="' + (d > 0 ? 'p' : d ? 'o' : 'g') + '"><span>差异</span><b>' + (d > 0 ? '+' : '') + d + '</b></div></div>' +
        (ro ? '' :
          '<div class="pks-q"><span class="pks-ql">本次数量<small>' + esc(it.uom || '') + '</small></span><b id="kpD" class="pks-qv"></b><button type="button" tabindex="-1" id="kpC" class="pks-qc" aria-label="清空">✕</button></div>' +
          '<div id="pkFb" class="pks-fb"></div>' + kpPad('kp') +
          '<button type="button" tabindex="-1" class="btn save pks-ok" id="pkSave">✓ 确认本次数量</button>') +
        '<div class="pks-nav"><button type="button" class="btn ghost" id="pkBack">‹ 返回列表</button>' +
        (nx ? '<button type="button" class="btn ghost" id="pkNext">下一个 ' + esc(nx.loc || '无库位') + ' →</button>' : '<button type="button" class="btn ghost" id="pkRev">全部拣完 → 复核</button>') + '</div>' +
        (it._so && rem > 0 ? '<div class="card pkso"><span>已确认拣完（短少 ' + rem + '）</span>' + (ro ? '' : '<button class="tbtn" id="pkUnso">取消确认</button>') + '</div>' : '') +
        '<div class="ldq-l"><b>最近拣货记录</b>（' + H.n + ' 笔，合计 ' + it._c + '）</div>' +
        '<div id="dtL">' + (H.html || '<div class="empty">还没有拣货记录</div>') + '</div>' +
        (!ro && rem > 0 && !it._so ? '<button type="button" class="pkshort2" id="pkShort">确认缺货并完成<small>剩余短少：' + rem + ' ' + esc(it.uom || '') + '</small></button>' : '') +
        '</div>');
      bindHist(it);
      var al = $('#pkAl'); if (al) al.onclick = function () { pkLocInput(it); };
      $('#pkBack').onclick = function () { pkLeave(function () { location.hash = ldHash(id); }); };
      var nb = $('#pkNext'); if (nb) nb.onclick = function () { pkLeave(function () { openIt(nx, 'SEARCH', ''); }); };
      var rb = $('#pkRev'); if (rb) rb.onclick = function () { pkLeave(function () { location.hash = ldHash(id) + '/review'; }); };
      var sh = $('#pkShort'); if (sh) sh.onclick = function () {
        pkLeave(function () {
          confirmBox('确认“' + dn(it) + '”拣完了？已拣 ' + it._c + ' / 应拣 ' + it.req + '，短少 ' + rem + '。之后还可以继续加数量，或取消确认。', '确认拣完', function () {
            push(it, 'SHORT_OK', 0, {}, '已确认拣完（短少 ' + rem + '）').catch(function () { });
          });
        });
      };
      var un = $('#pkUnso'); if (un) un.onclick = function () {
        confirmBox('取消“确认拣完”？这个商品会回到“未拣完”。', '取消确认', function () { push(it, 'VOID', 0, { rev: it._so, orig: 0, to: 0 }, '已取消确认拣完').catch(function () { }); });
      };
      if (!ro) {
        var D = $('#kpD'), FB = $('#pkFb');
        var show = function () {
          D.textContent = kpv; D.classList.toggle('z', !kpv);
          var v = Number(kpv);
          if (kpv && v > 0) { FB.className = 'pks-fb'; FB.textContent = '确认后累计：' + r3(it._c + v) + ' / ' + it.req + (r3(it._c + v) > it.req ? '（超出 ' + r3(it._c + v - it.req) + '）' : r3(it._c + v) === it.req ? '（拣齐）' : ''); }
          else if (msg) { FB.className = 'pks-fb ' + msg.cls; FB.textContent = ldW(msg.text); }
          else { FB.className = 'pks-fb hint'; FB.textContent = '用下面的数字键输入本次拣到的数量'; }
        };
        var set = function (v) { kpv = v; if (v) msg = null; show(); };
        kpBind($('#kp'), function () { return kpv; }, set);
        $('#kpC').onclick = function () { set(''); };
        $('#pkSave').onclick = function () { pkSave(); };
        kpPage = { get: function () { return kpv; }, set: set, enter: function () { pkSave(); }, scan: function (str) { pkItemScan(str); } };
        show();
      } else kpPage = null;
      var inp = $('#ldIn');
      if (inp) {        // 点一下扫码框才弹键盘（打字搜索）；扫描枪不需要先点
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); var v = inp.value; inp.value = ''; inp.blur(); pkItemScan(v); } });
        var prev = 0, tm;
        inp.addEventListener('input', function () {
          var now = inp.value.length; clearTimeout(tm);
          if (now - prev >= 6) tm = setTimeout(function () { if (document.activeElement === inp && inp.value) { var v = inp.value; inp.value = ''; inp.blur(); pkItemScan(v); } }, 250);
          prev = now;
        });
        $('#ldCam').onclick = function () { openCamera('ld', function (code) { pkItemScan(code); }, { label: '商品条码 / 货架库位码', qr: true }); };
      }
    }
    function pkSave() {
      var it = s.items[IT]; if (!it || done()) return false;
      var raw = kpv, v = Number(raw), FB = $('#pkFb');
      if (!(v > 0) || v > 100000) { if (FB) { FB.className = 'pks-fb err'; FB.textContent = raw ? '数量不对，请重新输入' : '请先输入本次数量'; } errBeep(); return false; }
      kpv = '';
      var m = ent && ent.key === it.key ? ent : { method: 'SEARCH', code: '' };
      add(it, v, m.method, m.code, aloc);
      return true;
    }
    /** SKU 页离开前：本次数量还没确认 → 保存 / 放弃 / 取消 */
    function pkLeave(cb) {
      var v = kpv;
      if (!v) return cb();
      modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>本次数量 ' + esc(v) + ' 还没确认</h3></div></div>' +
        '<div class="row"><button class="btn ghost" id="lvX">取消</button><button class="btn ghost" id="lvD">放弃</button><button class="btn save" id="lvS">确认保存</button></div></div>', function (m) {
          $('#lvX', m).onclick = closeModal;
          $('#lvD', m).onclick = function () { closeModal(); kpv = ''; cb(); };
          $('#lvS', m).onclick = function () { closeModal(); if (pkSave()) cb(); };
        });
    }
    /** 修改某一笔：弹窗里也用页面数字键盘（不弹系统键盘）；不再二次确认 */
    function pkEditBox(it, t) {
      var cur = txState(t.id).eff, total = ldCounts(s)[it.key] || 0, v = String(cur);
      modal('<div class="ldq"><div class="ldq-h">修改这一笔</div><div class="hint">' + itemName(it) + ' · ' + hhmm(t.time) + ' · 原来 ' + cur + '</div>' +
        '<div class="pks-q"><span class="pks-ql">改成</span><b id="kpMD" class="pks-qv"></b><button type="button" tabindex="-1" id="kpMC" class="pks-qc" aria-label="清空">✕</button></div>' +
        '<div id="kpMF" class="pks-fb"></div>' + kpPad('kpM') +
        '<div class="row"><button class="btn ghost" id="nbC">取消</button><button class="btn save" id="nbO">保存修改</button></div></div>', function (m) {
          var D = $('#kpMD', m), F = $('#kpMF', m), first = true;
          var show = function () {
            D.textContent = v; D.classList.toggle('z', !v);
            var n = Number(v); F.className = 'pks-fb';
            F.textContent = v === '' ? '输入正确的数量' : n === 0 ? '改成 0 = 撤销这一笔' : '修改后累计：' + r3(total - cur + n) + ' / ' + it.req;
          };
          var set = function (x) { if (first) { first = false; if (x.length > v.length && x.indexOf(v) === 0) x = x.slice(v.length); } v = x; show(); };    // 第一次按数字 = 重新输入
          var ok = function () {
            var n = Number(v);
            if (v === '' || !isFinite(n) || n < 0 || n > 100000) { F.className = 'pks-fb err'; F.textContent = '请输入正确的数量'; errBeep(); return; }
            n = r3(n);
            if (n === cur) { closeModal(); return; }
            if (n === 0) { closeModal(); return voidTxn(it, t); }
            closeModal();
            push(it, 'EDIT', r3(n - cur), { rev: t.id, orig: cur, to: n }, '已修改：' + cur + ' 改成 ' + n).catch(function () { });
          };
          kpBind($('#kpM', m), function () { return v; }, set);
          $('#kpMC', m).onclick = function () { first = false; v = ''; show(); };
          $('#nbC', m).onclick = closeModal; $('#nbO', m).onclick = ok;
          kpModal = { get: function () { return v; }, set: set, enter: ok, scan: function () { errBeep(); F.className = 'pks-fb err'; F.textContent = '这里只能输入数量'; } };
          show();
        });
    }
    /** SKU 页的扫码 / 搜索：同一商品 = 确认条码；别的商品 = 切换；文字 = 回列表搜索 */
    function pkItemScan(raw) {
      raw = String(raw || '').trim(); if (!raw || !s) return;
      var it = s.items[IT], q = ldNorm(raw), exact = s.items.filter(function (x) { return ldCodes(x).indexOf(q) >= 0; });
      var lc = !exact.length && pkLocCode(raw);
      if (lc) return pkSetLoc(lc, it);              // v1.6 扫到的是货架库位码 → 记为实际取货库位
      if (exact.indexOf(it) >= 0) {
        beep(); ent = { key: it.key, method: 'BARCODE', code: raw };
        msg = { cls: 'good', text: '✓ 条码正确（就是这个商品）' + (exact.length > 1 ? '，这个条码还有其它批次' : '') + '，请输入本次数量' }; ent.shown = true; draw(); return;
      }
      if (exact.length) return pkLeave(function () { if (exact.length === 1) openIt(exact[0], 'BARCODE', raw); else pick(exact, '这个条码对应 ' + exact.length + ' 行（不同批次），请选择', '', raw); });
      if (/^\d{8,}$/.test(q)) return handle(raw, 'BARCODE');
      if (/^[A-Za-z0-9-]+$/.test(raw) && /[A-Za-z]/.test(raw) && /\d/.test(raw) && !s.items.some(function (x) { return (String(x.batch || '') + ' ' + String(x.loc || '')).toUpperCase().indexOf(raw.toUpperCase()) >= 0; })) {
        errBeep(); msg = { cls: 'bad', text: '无法识别：' + raw + '（不是商品条码，也不是库位码）' }; return draw();   // v1.6.1 不填任何字段，已记录的库位不变
      }
      pkLeave(function () { U.pq = raw; U.chip = null; location.hash = ldHash(id); });
    }
    function drawReview(head, o) {
      var bad = s.items.filter(function (it) { return it._c < it.req; }), over = s.items.filter(function (it) { return it._c > it.req; }), ok = s.items.filter(function (it) { return it._c === it.req; });
      var tr = function (it) {
        var d = r3(it._c - it.req);
        return '<tr class="' + (d < 0 ? 'neg' : d > 0 ? 'pos' : '') + '" data-k="' + esc(it.key) + '"><td><b>' + itemName(it) + '</b><div class="hint">' + pkTag(it) + esc(ldId(it, '')) + ' · ' + esc(it.uom) + '</div></td><td class="n">' + it.req + '</td><td class="n">' + it._c + '</td><td class="n"><b>' + (d > 0 ? '+' : '') + d + '</b></td></tr>';
      };
      var tbl = function (title, arr, cls) {
        return arr.length ? '<div class="card"><h3 class="' + cls + '">' + title + '（' + arr.length + '）</h3><table class="ldrt"><thead><tr><th>商品</th><th class="n">需求</th><th class="n">已点</th><th class="n">差异</th></tr></thead><tbody>' + arr.map(tr).join('') + '</tbody></table></div>' : '';
      };
      app.innerHTML = ldW(head + (msg ? '<div class="tmsg ' + msg.cls + '">' + esc(msg.text) + '</div>' : '') +
        tbl(done() ? '短少 / 未装' : '没点够 / 没点（未装）', bad, 'err') + tbl('超出', over, 'ldpos') +
        (!PK && s.task.customer ? custShortHtml() : '') +      // v1.9.12 按客户看差货
        (ok.length ? '<details class="card"><summary><b>已点齐 ' + ok.length + ' 项</b></summary><table class="ldrt"><tbody>' + ok.map(tr).join('') + '</tbody></table></details>' : '') +
        (done() ? '' : PK ? '<p class="hint">提交的是实际点到的数量，不需要改成和 DO 一样。没点够的会记为<b>短少</b>。</p>' : '<p class="hint">提交的是实际点到的数量，不需要改成和 DO 一样。没点够的会记为<b>未装</b>，下次上传 DO 时可以带进新任务（会注明今天的日期）。</p>') +
        '<div id="dock" class="dock"><button class="btn ghost" id="ldBack" style="flex:0 0 36%">‹ 继续点货</button>' +
        (done() ? '' : '<button class="btn save" id="ldSubmit">✓ 确认完成点货</button>') + '</div>');
      $('#ldBack').onclick = function () { location.hash = ldHash(id); };
      Array.prototype.forEach.call(app.querySelectorAll('.cshort tr[data-k]'), function (r) { r.onclick = function () { detail(byKey(r.dataset.k)); }; });
      var sb = $('#ldSubmit');
      if (sb) sb.onclick = function () {
        modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic" style="background:#e6f4ea;color:#1a7f37">✓</span><div><h3>确认完成点货？</h3></div></div>' +
          '<ul class="tmiss-list"><li class="' + (bad.length ? 'bad' : 'ok') + '"><span class="mk">' + (bad.length ? '!' : '✓') + '</span><span class="t"><b>未装 / 短少 ' + bad.length + ' 项</b>' + (PK ? '' : '<span>下次上传 DO 时可以带上</span>') + '</span></li>' +
          '<li class="' + (over.length ? 'bad' : 'ok') + '"><span class="mk">' + (over.length ? '!' : '✓') + '</span><span class="t"><b>超出 ' + over.length + ' 项</b><span>按实际点到的数量记录</span></span></li>' +
          '<li class="ok"><span class="mk">✓</span><span class="t"><b>已点齐 ' + ok.length + ' 项</b></span></li></ul>' +
          '<p>完成后不能再修改。</p><div class="row"><button class="btn ghost" id="cfNo">再看看</button><button class="btn save" id="cfYes">确认完成</button></div></div>', function (m) {
            $('#cfNo', m).onclick = closeModal;
            $('#cfYes', m).onclick = function () {
              closeModal();
              s.localDone = true; s.task.status = '已完成'; s.task.submittedBy = operator;
              LDQ.push({ op: 'submit', taskId: id, at: new Date().toISOString() });
              Promise.all([ldPut(s), ldSaveQ()]).then(function () {
                beep(); toast(ldW(navigator.onLine === false ? '✓ 已完成（没网，联网后自动上传）' : '✓ 已完成'));
                ldFlush(); location.hash = ldHash(id);
              });
            };
          });
      };
      Array.prototype.forEach.call(app.querySelectorAll('tr[data-k]'), function (r) { r.onclick = function () { detail(byKey(r.dataset.k)); }; });
    }
    function byKey(k) { return s.items.filter(function (it) { return it.key === k; })[0]; }
    function bind() {
      Array.prototype.forEach.call(app.querySelectorAll('[data-f]'), function (b) { b.onclick = function () { filter = b.dataset.f; pq = ''; if (U) { U.filter = filter; U.pq = ''; var x = $('#ldIn'); if (x) x.value = ''; } msg = null; draw(); }; });
      bindRows();
      if (PK) {
        var sl = $('#pkLoc'); if (sl) sl.onchange = function () { U.locF = sl.value; draw(); };
        var cx = $('#pkChipX'); if (cx) cx.onclick = function () { U.chip = null; draw(); };
        if (restoreY && s) { restoreY = false; var y = U.y; if (y) setTimeout(function () { window.scrollTo(0, y); }, 0); }
      }
      $('#ldHist').onclick = showHistory;
      $('#ldRev').onclick = function () { location.hash = ldHash(id) + '/review'; };
      var fz = $('#ldFen'); if (fz) fz.onclick = function () { fenOpen(''); };
      var cz = $('#ldCs'); if (cz) cz.onclick = custShortOpen;
      var inp = $('#ldIn');
      if (!inp) return;
      if (PK) {        // v1.5.1 拣货：一个入口 —— 扫码进商品，打字即时搜索
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); pkEnter(inp.value); } });
        var pv = 0, pt;
        inp.addEventListener('input', function () {
          var now = inp.value.length; clearTimeout(pt);
          if (now - pv >= 6) pt = setTimeout(function () { if (document.activeElement === inp && inp.value) pkEnter(inp.value); }, 250);
          pv = now;
          pq = U.pq = inp.value; stats(); $('#ldList').innerHTML = ldW(listHtml()); bindRows();
          Array.prototype.forEach.call(app.querySelectorAll('[data-f]'), function (b) { b.classList.toggle('on', !pq.trim() && b.dataset.f === filter); });
        });
        if (keepVal) { inp.value = keepVal; pv = keepVal.length; keepVal = ''; }
        if (keepFocus && $('#modal').hidden) inp.focus();
        setTimeout(function () { var x = $('#ldIn'); if (x && $('#modal').hidden && document.activeElement !== x && !/^(INPUT|SELECT)$/.test((document.activeElement || {}).tagName || '')) x.focus(); }, 30);
        $('#ldCam').onclick = function () { openCamera('ld', function (code) { pkEnter(code); }, { label: '商品条码' }); };
        return;
      }
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); var v = inp.value; inp.value = ''; handle(v, 'BARCODE'); } });
      var prev = 0, t;
      inp.addEventListener('input', function () {      // PDA “直接填充”模式（没有回车）
        var now = inp.value.length; clearTimeout(t);
        if (now - prev >= 6) t = setTimeout(function () { if (document.activeElement === inp && inp.value) { var v = inp.value; inp.value = ''; handle(v, 'BARCODE'); } }, 250);
        prev = now;
      });
      if (keepVal) { inp.value = keepVal; prev = keepVal.length; keepVal = ''; }
      if (keepFocus && $('#modal').hidden) inp.focus();
      setTimeout(function () { var x = $('#ldIn'); if (x && $('#modal').hidden) x.focus(); }, 30);
      $('#ldCam').onclick = function () { openCamera('ld', function (code) { handle(code, 'BARCODE'); }, { label: '商品条码' }); };
      var sb = $('#ldSearch'); if (sb) sb.onclick = function () { pick(s.items, '搜索商品', ''); };
    }
    /** v1.9.9 分货：扫商品码（或搜品名）→ 这个商品每张 DO（每家客户）要几箱。不记点货数量，只是查看 */
    function fenCust() {
      var m = {}; String(s.task.customer || '').split(/\n/).forEach(function (x) { var i = x.indexOf('='); if (i > 0) m[x.slice(0, i).trim()] = x.slice(i + 1).trim(); });
      return m;
    }
    function fenRows(it) {
      var src = String(it.src || ''), pre = '', i = src.indexOf('：');
      if (it.origin === '之前' && i >= 0) { pre = src.slice(0, i); src = src.slice(i + 1); }
      var g = {}, order = [];
      src.split(/;\s*/).forEach(function (p) { var m = /^(.+?)×(-?[\d.]+)$/.exec(p.trim()); if (!m) return; if (g[m[1]] == null) { g[m[1]] = 0; order.push(m[1]); } g[m[1]] = r3(g[m[1]] + Number(m[2])); });
      return { pre: pre, list: order.map(function (d) { return { doNo: d, qty: g[d] }; }) };
    }
    /** v1.9.10 按客户（送货地址）合计：同一家有几张 DO 的加在一起 */
    function fenByCust(it) {
      var c = fenCust(), f = fenRows(it), g = {}, order = [];
      f.list.forEach(function (x) { var k = c[x.doNo] || x.doNo; if (!g[k]) { g[k] = { cust: c[x.doNo] || '', dos: [], qty: 0 }; order.push(k); } g[k].dos.push(x.doNo); g[k].qty = r3(g[k].qty + x.qty); });
      return { pre: f.pre, list: order.map(function (k) { return g[k]; }) };
    }
    /** 点货弹窗里的分货小表：这个商品每家几箱（一边点一边分） */
    function fenMini(it) {
      var f = fenByCust(it); if (!f.list.length || (f.list.length === 1 && !f.list[0].cust)) return '';
      return '<div class="fenmini"><b>📦 分货</b>' + (f.pre ? '<span class="hint">（之前未装，原来的 DO）</span>' : '') + f.list.map(function (x) {
        return '<div><span>' + esc(x.cust || x.dos[0]) + '</span><b>' + x.qty + ' ' + esc(it.uom || '') + '</b></div>'; }).join('') + '</div>';
    }
    /** v1.9.12 按家分货：这个商品要分给哪几家（2 家以上才要按家填） */
    function allocKeys(it) { return fenByCust(it).list.map(function (x) { return { k: x.cust || x.dos[0], cust: x.cust || x.dos[0], need: x.qty }; }); }
    function allocMulti(it) { return !PK && allocKeys(it).length >= 2; }
    /** 每家已经放了几个：以最后一笔 ALLOC 为准；只有一家的商品 = 点到的总数 */
    function allocOf(it) {
      var last = null; Object.keys(s.txns).forEach(function (k) { var t = s.txns[k]; if (t.key === it.key && t.method === 'ALLOC' && (!last || String(t.time) > String(last.time))) last = t; });
      var m = {}; if (last) { try { m = typeof last.alloc === 'string' ? JSON.parse(last.alloc || '{}') : (last.alloc || {}); } catch (e) { m = {}; } }
      return m;
    }
    function allocSum(m) { return r3(Object.keys(m).reduce(function (a, k) { return a + (Number(m[k]) || 0); }, 0)); }
    /** 每家差什么：[{cust, rows:[{it, need, put, short}]}]；还有分货数和点货数对不上的商品 */
    function custShort() {
      stats(); var g = {}, order = [], mism = [];
      s.items.forEach(function (it) {
        var ks = allocKeys(it); if (!ks.length) return;
        var multi = ks.length >= 2, a = multi ? allocOf(it) : null;
        if (multi && allocSum(a) !== r3(it._c)) mism.push({ it: it, sum: allocSum(a) });
        ks.forEach(function (x) {
          var put = multi ? (Number(a[x.k]) || 0) : Math.min(it._c, x.need), sh = r3(x.need - put);
          if (!g[x.cust]) { g[x.cust] = []; order.push(x.cust); }
          if (sh > 0) g[x.cust].push({ it: it, need: x.need, put: put, short: sh });
        });
      });
      return { list: order.map(function (c) { return { cust: c, rows: g[c] }; }), mism: mism };
    }
    function custShortHtml() {
      var r = custShort(), bad = r.list.filter(function (x) { return x.rows.length; });
      return '<div class="card"><h3 style="margin-top:0">🧾 各家差货（' + (bad.length ? bad.length + ' 家有差' : '每家都够了') + '）</h3>' +
        (r.mism.length ? '<div class="tmsg bad">这些商品各家填的数加起来和点货数不一样，请点商品改“各家数量”：' + r.mism.map(function (x) { return esc(x.it.desc) + '（点了 ' + x.it._c + '，各家共 ' + x.sum + '）'; }).join('；') + '</div>' : '') +
        r.list.map(function (x) {
          return '<div class="cshort"><div class="cshort-h"><b>' + esc(x.cust) + '</b>' + (x.rows.length ? '<span class="err">差 ' + x.rows.length + ' 项</span>' : '<span class="ok">✓ 够了</span>') + '</div>' +
            (x.rows.length ? '<table class="fentab"><thead><tr><th>商品</th><th class="n">要</th><th class="n">放了</th><th class="n">差</th></tr></thead><tbody>' + x.rows.map(function (y) {
              return '<tr data-k="' + esc(y.it.key) + '"><td>' + esc(y.it.desc) + '</td><td class="n">' + y.need + '</td><td class="n">' + y.put + '</td><td class="n"><b class="err">' + y.short + ' ' + esc(y.it.uom || '') + '</b></td></tr>'; }).join('') + '</tbody></table>' : '') + '</div>';
        }).join('') + '</div>';
    }
    function custShortOpen() {
      modal(custShortHtml() + '<div class="row"><button class="btn ghost" id="csX">关闭</button></div>', function (m) {
        $('#csX', m).onclick = function () { closeModal(); draw(); };
        Array.prototype.forEach.call(m.querySelectorAll('tr[data-k]'), function (r) { r.onclick = function () { detail(byKey(r.dataset.k)); }; });
      });
    }
    /** 改各家数量（点错 / 撤销 / 调整过之后用） */
    function allocEdit(it) {
      stats(); var ks = allocKeys(it), a = allocOf(it);
      modal('<div class="ldq"><div class="ldq-h">' + itemName(it) + '</div><div class="hint">各家放了几个 ' + esc(it.uom || '') + '（点货一共 ' + it._c + '）</div>' +
        ks.map(function (x, i) { return '<label class="alrow"><span>' + esc(x.cust) + ' <small class="hint">要 ' + x.need + '</small></span><input data-ai="' + i + '" class="ldq-in" inputmode="decimal" autocomplete="off" maxlength="9" value="' + (a[x.k] != null ? a[x.k] : '') + '"></label>'; }).join('') +
        '<div id="alM" class="ldq-m"></div><div class="row"><button class="btn ghost" id="alC2">取消</button><button class="btn save" id="alO2">保存各家数量</button></div></div>', function (m) {
          var ins = m.querySelectorAll('[data-ai]'), out = $('#alM', m);
          var sum = function () { var t = 0; Array.prototype.forEach.call(ins, function (x) { t += Number(x.value) || 0; }); return r3(t); };
          Array.prototype.forEach.call(ins, function (x) { x.oninput = function () { var t = sum(); out.className = 'ldq-m' + (t !== r3(it._c) ? ' err' : ''); out.textContent = '各家共 ' + t + (t !== r3(it._c) ? '，和点货数 ' + it._c + ' 不一样' : ''); }; });
          $('#alC2', m).onclick = function () { closeModal(); detail(it); };
          $('#alO2', m).onclick = function () {
            var na = {}, bad = false; Array.prototype.forEach.call(ins, function (x) { var v = x.value.trim(); if (v === '') return; var n = Number(v); if (!(n >= 0) || n > 100000) bad = true; else na[ks[+x.dataset.ai].k] = r3(n); });
            if (bad) { out.className = 'ldq-m err'; out.textContent = '请输入正确的数量'; errBeep(); return; }
            closeModal(); push(it, 'ALLOC', 0, { alloc: na }, '已保存各家数量');
          };
        });
    }
    function fenShow(it, box) {
      var c = fenCust(), f0 = fenByCust(it), f = { pre: f0.pre, list: f0.list.map(function (x) { return { doNo: x.dos.join(' / '), qty: x.qty, cust: x.cust }; }) }, tot = f.list.reduce(function (a, x) { return r3(a + x.qty); }, 0);
      box.innerHTML = '<div class="fenit"><b>' + esc(it.desc) + '</b><div class="hint">' + esc(ldId(it, '条码 ')) + (it.spec ? ' · ' + esc(it.spec) : '') + '</div>' +
        (f.pre ? '<p class="hint">之前未装（' + esc(f.pre) + '），这次要装 ' + it.req + ' ' + esc(it.uom) + '；下面是原来的 DO：</p>' : '') +
        '<table class="fentab"><thead><tr><th>客户</th><th>DO</th><th class="n">' + esc(it.uom || '数量') + '</th></tr></thead><tbody>' +
        (f.list.length ? f.list.map(function (x) { return '<tr><td><b>' + esc(x.cust || '—') + '</b></td><td class="hint">' + esc(x.doNo) + '</td><td class="n"><b>' + x.qty + '</b></td></tr>'; }).join('') : '<tr><td colspan="3" class="hint">没有 DO 明细</td></tr>') +
        '</tbody><tfoot><tr><td colspan="2">' + f.list.length + ' 家 · 合计</td><td class="n"><b>' + tot + '</b></td></tr></tfoot></table></div>';
    }
    function fenOpen(code) {
      var im = prefs.pda ? 'none' : 'text';
      modal('<h3 style="margin-top:0">📦 分货</h3><p class="hint">扫商品条码，或输入品名 / 条码后几位。只是查看每家要几箱，不会改点货数量。</p>' +
        '<div class="bcrow tscan"><input id="fenIn" inputmode="' + im + '" maxlength="64" autocomplete="off" spellcheck="false" placeholder="扫商品码 / 搜品名"><button class="btn cam" id="fenCam" aria-label="相机扫码">📷</button></div>' +
        '<div id="fenOut"></div><div class="row"><button class="btn ghost" id="fenX">关闭</button></div>', function (m) {
          var inp = $('#fenIn', m), out = $('#fenOut', m);
          var go = function (raw) {
            raw = String(raw || '').trim(); if (!raw) return; inp.value = '';
            var q = ldNorm(raw), exact = s.items.filter(function (it) { return ldCodes(it).indexOf(q) >= 0; });
            var list = exact.length ? exact : find(raw);
            if (list.length === 1) { fenShow(list[0], out); beep(); }
            else if (!list.length) { errBeep(); out.innerHTML = '<div class="tmsg err">“' + esc(raw) + '”不在这个装车任务里</div>'; }
            else {
              out.innerHTML = '<p class="hint">找到 ' + list.length + ' 个，点一个：</p>' + list.slice(0, 40).map(function (it) { return '<button class="ldp" data-fk="' + esc(it.key) + '"><span class="t"><b>' + itemName(it) + '</b><span>' + esc(ldId(it, '')) + ' · ' + esc(it.uom) + '</span></span><span class="n">' + it.req + '</span></button>'; }).join('');
              Array.prototype.forEach.call(out.querySelectorAll('[data-fk]'), function (b) { b.onclick = function () { fenShow(byKey(b.dataset.fk), out); }; });
            }
            setTimeout(function () { if (inp.isConnected) inp.focus(); }, 30);
          };
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); go(inp.value); } });
          var pv = 0, pt;
          inp.addEventListener('input', function () { var n = inp.value.length; clearTimeout(pt); if (n - pv >= 6) pt = setTimeout(function () { if (inp.value) go(inp.value); }, 250); pv = n; });
          $('#fenX', m).onclick = function () { closeModal(); draw(); };
          $('#fenCam', m).onclick = function () { closeModal(); openCamera('ld', function (c) { fenOpen(c); }, { label: '商品条码（分货）' }); };
          if (code) go(code);
          setTimeout(function () { if (inp.isConnected) inp.focus(); }, 50);
        });
    }
    // 扫码 / 输入：先精确比对条码和 Item Code；没有就按“后几位”或品名找
    function handle(raw, method) {
      raw = String(raw || '').trim(); if (!raw || !s || done()) return;
      var q = ldNorm(raw), exact = s.items.filter(function (it) { return ldCodes(it).indexOf(q) >= 0; });
      if (exact.length === 1) return openIt(exact[0], method, raw);
      if (exact.length > 1) return pick(exact, '这个条码对应 ' + exact.length + ' 行，请选择', '', raw);
      var found = find(raw);
      if (found.length) { if (found.length === 1 && /^\d{4,}$/.test(q) && q.length < 8) return openIt(found[0], 'SEARCH', raw); return pick(found, '找到 ' + found.length + ' 个可能的商品', raw); }
      errBeep();
      if (/^\d{8,}$/.test(q)) { LDQ.push({ op: 'txn', taskId: id, txn: { txnId: uuid(), taskId: id, method: 'UNKNOWN', code: raw, clientTime: new Date().toISOString() } }); ldSaveQ().then(ldFlush); }
      modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">?</span><div><h3>条码不在本次装车单里</h3><div class="hint">' + esc(raw) + '</div></div></div>' +
        '<p>可能是箱子上的备用码。请手动搜索（品名、Item Code 或条码后几位），或从列表里选正确的商品。<b>不会自动加进清单。</b></p>' +
        '<div class="row"><button class="btn ghost" id="nfOk">知道了</button><button class="btn save" id="nfS">🔍 手动搜索 / 选商品</button></div></div>', function (m) {
          $('#nfOk', m).onclick = closeModal; $('#nfS', m).onclick = function () { pick(s.items, '搜索商品', ''); };
        });
    }
    function find(text) {
      var q = ldNorm(text), low = String(text || '').trim().toLowerCase(), res = [];
      if (!low) return s.items.slice();
      if (/^\d+$/.test(q)) {
        res = s.items.filter(function (it) { return ldCodes(it).some(function (c) { return c.slice(-q.length) === q; }); });     // 后几位
        if (!res.length && q.length >= 3) res = s.items.filter(function (it) { return ldCodes(it).some(function (c) { return c.indexOf(q) >= 0; }); });
      } else {
        res = s.items.filter(function (it) { return (it.desc + ' ' + (it.descMy || '') + ' ' + it.code + ' ' + it.bc + ' ' + it.spec + ' ' + (it.batch || '') + ' ' + (it.loc || '') + ' ' + String(it.loc || '').replace(/-/g, '')).toLowerCase().indexOf(low) >= 0; });
      }
      return res;
    }
    function pick(list, title, query, scanned) {
      stats();
      var sortL = function (arr) { return arr.slice().sort(function (a, b) { return (a._c >= a.req) - (b._c >= b.req); }); };
      function rows(arr) {
        return arr.length ? sortL(arr).slice(0, 80).map(function (it) {
          return '<button class="ldp" data-k="' + esc(it.key) + '"><span class="t"><b>' + itemName(it) + '</b><span>' + pkTag(it) + esc(ldId(it, '')) + ' · ' + esc(it.uom) + '</span></span>' +
            '<span class="n">' + it._c + ' / ' + it.req + '</span></button>';
        }).join('') + (arr.length > 80 ? '<p class="hint">还有 ' + (arr.length - 80) + ' 项，请输入更多字缩小范围</p>' : '') : '<div class="empty">没有找到。可以输入品名的一部分、Item Code 或条码后几位</div>';
      }
      modal('<h3 style="margin-top:0">' + esc(title) + '</h3><input id="pkQ" class="pkq" placeholder="品名 / Item Code / 条码后几位" value="' + esc(query || '') + '" autocomplete="off">' +
        '<div id="pkL" class="pkl">' + rows(list) + '</div><div class="row"><button class="btn ghost" id="pkX">关闭</button></div>', function (m) {
          var qEl = $('#pkQ', m), L = $('#pkL', m);
          function bindRows() { Array.prototype.forEach.call(L.querySelectorAll('.ldp'), function (b) { b.onclick = function () { openIt(byKey(b.dataset.k), scanned ? 'BARCODE' : 'SEARCH', scanned || ''); }; }); }
          qEl.oninput = function () { L.innerHTML = rows(find(qEl.value)); bindRows(); };
          qEl.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); var r = find(qEl.value); if (r.length === 1) openIt(r[0], 'SEARCH', ''); } };
          $('#pkX', m).onclick = closeModal; bindRows();
          if (!scanned) setTimeout(function () { qEl.focus(); }, 50);
        });
    }
    // 输入本次数量 → 加到累计（不覆盖）
    function qty(it, method, code) {
      if (!it) return;
      stats();
      var rem = r3(it.req - it._c);
      modal('<div class="ldq"><div class="ldq-h">' + itemName(it) + '</div><div class="hint">' + pkTag(it) + esc(ldId(it, '条码 ')) + (it.spec ? ' · ' + esc(it.spec) : '') + '</div>' +
        '<div class="ldq-n"><div><span>需求</span><b>' + it.req + '</b></div><div><span>已点</span><b>' + it._c + '</b></div><div class="' + (rem < 0 ? 'p' : rem ? 'o' : 'g') + '"><span>' + (rem < 0 ? '已超出' : '还差') + '</span><b>' + Math.abs(rem) + '</b></div></div>' +
        (allocMulti(it) ? (function () {          // v1.9.12 好几家要：按家填这次放了几个（总数 = 加起来）
          var ks = allocKeys(it), a = allocOf(it);
          return '<div class="fenmini alq"><b>📦 这次每家放了几个 ' + esc(it.uom || '') + '？</b>' + ks.map(function (x, i) {
            var put = Number(a[x.k]) || 0, left = Math.max(0, r3(x.need - put));
            return '<label class="alrow"><span>' + esc(x.cust) + ' <small class="hint">要 ' + x.need + (put ? ' · 已放 ' + put : '') + '</small></span><input data-aq="' + i + '" data-left="' + left + '" class="ldq-in" inputmode="decimal" autocomplete="off" maxlength="9"></label>';
          }).join('') + '<button class="tbtn" id="alFill">全部按要求填满</button></div><input id="ldQn" type="hidden">';
        })() : (PK ? '' : fenMini(it)) +
        '<label class="ldq-l">这次点了多少 <b>' + esc(it.uom || '') + '</b>？</label><input id="ldQn" class="ldq-in" inputmode="decimal" autocomplete="off" maxlength="9">') +
        '<div id="ldQm" class="ldq-m"></div><div class="row"><button class="btn ghost" id="ldQc">取消</button><button class="btn save" id="ldQo">＋ 确认累加</button></div></div>', function (m) {
          var inp = $('#ldQn', m), out = $('#ldQm', m), aqs = m.querySelectorAll('[data-aq]');
          if (aqs.length) {          // 按家填：总数自动加起来
            var tot = function () { var t = 0; Array.prototype.forEach.call(aqs, function (x) { t += Number(x.value) || 0; }); inp.value = t ? r3(t) : ''; inp.oninput(); };
            Array.prototype.forEach.call(aqs, function (x, i) { x.oninput = tot; x.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); if (aqs[i + 1]) aqs[i + 1].focus(); else ok(); } }; });
            $('#alFill', m).onclick = function () { Array.prototype.forEach.call(aqs, function (x) { x.value = x.dataset.left; }); tot(); };
          }
          inp.oninput = function () {
            var v = Number(inp.value);
            out.className = 'ldq-m';
            out.textContent = inp.value && v > 0 ? '累加后：' + r3(it._c + v) + ' / ' + it.req + (r3(it._c + v) > it.req ? '（超出 ' + r3(it._c + v - it.req) + '）' : '') : '';
          };
          var ok = function () {
            var raw = inp.value.trim(), v = Number(raw);
            if (/^\d{7,}$/.test(raw)) { out.className = 'ldq-m err'; out.textContent = '数量太大——是不是扫到了条码？请输入数量'; inp.value = ''; errBeep(); return; }
            if (!(v > 0) || v > 100000) { out.className = 'ldq-m err'; out.textContent = aqs.length ? '请填每家放了几个（至少一家大于 0）' : '请输入点到的数量（大于 0）'; errBeep(); (aqs[0] || inp).focus(); return; }
            var al = null;
            if (aqs.length) { var ks = allocKeys(it); al = allocOf(it); Array.prototype.forEach.call(aqs, function (x) { var n = Number(x.value) || 0; if (n > 0) { var k = ks[+x.dataset.aq].k; al[k] = r3((Number(al[k]) || 0) + n); } }); }
            closeModal(); add(it, v, method, code, '', al);
          };
          inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
          $('#ldQo', m).onclick = ok; $('#ldQc', m).onclick = function () { closeModal(); draw(); };
          setTimeout(function () { (aqs[0] || inp).focus(); }, 50);
        });
    }
    function add(it, v, method, code, aloc, alloc) {
      var tid = uuid(), now = new Date().toISOString();
      s.txns[tid] = { id: tid, key: it.key, qty: v, method: method, staff: operator, time: now, rev: '', code: code || '', aloc: aloc || '', synced: false };
      var tx = { txnId: tid, taskId: id, key: it.key, qty: v, method: method, code: code || '', clientTime: now };
      if (aloc) tx.aloc = aloc;                     // v1.6 拣货：实际取货库位（扫了才有）
      LDQ.push({ op: 'txn', taskId: id, txn: tx });
      if (alloc) {                                  // v1.9.12 装车：每家放了几个（另记一笔 ALLOC，数量 0）
        var aid = uuid(), at = new Date(Date.parse(now) + 1).toISOString();
        s.txns[aid] = { id: aid, key: it.key, qty: 0, method: 'ALLOC', staff: operator, time: at, rev: '', code: '', alloc: alloc, synced: false };
        LDQ.push({ op: 'txn', taskId: id, txn: { txnId: aid, taskId: id, key: it.key, qty: 0, method: 'ALLOC', alloc: alloc, clientTime: at } });
      }
      if (s.task.status === '待点货') s.task.status = '点货中';
      Promise.all([ldPut(s), ldSaveQ()]).then(function () {
        var c = ldCounts(s)[it.key] || 0;
        beep();
        msg = { cls: c > it.req ? 'bad' : 'good', text: (PK && IT != null ? '✓ 已保存 +' + v + ' → 累计 ' : '✓ ' + it.desc + '  +' + v + ' → 共 ') + c + ' / ' + it.req + (c > it.req ? '（超出 ' + r3(c - it.req) + '）' : c === it.req ? '（已点齐）' : '') };
        draw(); ldFlush();
      }, function (e) { infoBoxLd('保存失败', '保存到手机失败（' + e.message + '），请再点一次。'); });
    }
    function infoBoxLd(t, x) {
      errBeep();
      modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>' + esc(t) + '</h3></div></div><p>' + esc(x) + '</p><div class="row"><button class="btn save" id="ibOk">知道了</button></div></div>', function (m) { $('#ibOk', m).onclick = closeModal; });
    }
    // ---------- v1.4.3 修正点货：修改 / 撤销 / 调整累计 —— 都是另加一笔，原记录永远保留 ----------
    var ML = { BARCODE: '扫码', SEARCH: '搜索', MANUAL: '手输', REVERSAL: '撤销', VOID: '撤销', EDIT: '修改', ADJUST: '调整累计', SHORT_OK: '确认拣完（短少）' };
    var ORIG = ['BARCODE', 'SEARCH', 'MANUAL', 'ADJUST'];
    function byTime(a, b) { return String(a.time).localeCompare(String(b.time)); }
    function sg(v) { return (v > 0 ? '+' : '') + v; }
    /** 某一笔现在的数量：原数量 + 修改差额；被撤销 = 0 */
    function txState(tid) {
      var o = s.txns[tid], eff = o ? Number(o.qty) : 0, voided = null, edits = [];
      Object.keys(s.txns).forEach(function (k) {
        var t = s.txns[k]; if (t.rev !== tid) return;
        if (t.method === 'VOID' || t.method === 'REVERSAL') voided = t; else if (t.method === 'EDIT') { eff = r3(eff + Number(t.qty)); edits.push(t); }
      });
      return { eff: voided ? 0 : eff, voided: voided, edits: edits.sort(byTime) };
    }
    function push(it, method, delta, extra, okText) {
      var tid = uuid(), now = new Date().toISOString();
      var rec = Object.assign({ id: tid, key: it.key, qty: delta, method: method, staff: operator, time: now, rev: '', code: '', orig: '', to: '', reason: '', synced: false }, extra);
      s.txns[tid] = rec;
      var tx2 = { txnId: tid, taskId: id, key: it.key, qty: delta, method: method, reverses: rec.rev, orig: rec.orig, to: rec.to, reason: rec.reason, clientTime: now };
      if (rec.alloc) tx2.alloc = rec.alloc;
      LDQ.push({ op: 'txn', taskId: id, txn: tx2 });
      if (s.task.status === '待点货') s.task.status = '点货中';
      return Promise.all([ldPut(s), ldSaveQ()]).then(function () {
        beep(); var c = ldCounts(s)[it.key] || 0;
        msg = { cls: 'good', text: okText + (PK && IT != null ? ' → 累计 ' : ' → ' + it.desc + ' 现在共 ') + c + ' / ' + it.req };
        draw(); ldFlush();
      }, function (e) { delete s.txns[tid]; LDQ.pop(); infoBoxLd('保存失败', '保存到手机失败（' + e.message + '），请再试一次。'); throw e; });
    }
    function numBox(title, sub, label, val, okText, onOk, extraHtml) {
      modal('<div class="ldq"><div class="ldq-h">' + title + '</div>' + (sub ? '<div class="hint">' + sub + '</div>' : '') +
        '<label class="ldq-l" style="margin-top:12px">' + label + '</label><input id="nbN" class="ldq-in" inputmode="decimal" autocomplete="off" maxlength="9" value="' + esc(val) + '">' +
        (extraHtml || '') + '<div id="nbM" class="ldq-m"></div><div class="row"><button class="btn ghost" id="nbC">取消</button><button class="btn save" id="nbO">' + okText + '</button></div></div>', function (m) {
          var inp = $('#nbN', m), out = $('#nbM', m);
          var ok = function () {
            var raw = inp.value.trim(), v = Number(raw);
            if (raw === '' || !isFinite(v) || v < 0 || v > 100000 || /^\d{7,}$/.test(raw)) { out.className = 'ldq-m err'; out.textContent = '请输入正确的数量'; errBeep(); inp.focus(); return; }
            onOk(r3(v), m, out);
          };
          inp.oninput = function () { out.className = 'ldq-m'; if (onOk.live) out.textContent = onOk.live(Number(inp.value), inp.value); };
          inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
          $('#nbO', m).onclick = ok; $('#nbC', m).onclick = function () { closeModal(); };
          setTimeout(function () { inp.focus(); inp.select(); }, 50);
        });
    }
    /** 商品详情：需求 / 已点 / 还差 + 这个商品的每一笔点货（修改、撤销）+ 再点 / 调整累计 */
    var dKey = null;      // 正在看的商品详情（后台资料更新时跟着刷新）
    function detail(it) {
      if (!it) return;
      if (PK) return openIt(it, 'SEARCH', '');
      dKey = it.key;
      stats();
      var c = it._c, rem = r3(it.req - c), ro = done();
      var H = histRows(it, ro), list = { length: H.n }, rows = [H.html];
      modal('<div class="ldq"><div class="ldq-h">' + itemName(it) + '</div><div class="hint">' + pkTag(it) + esc(ldId(it, '条码 ')) + ' · ' + esc(it.uom || '') + (it.spec ? ' · ' + esc(it.spec) : '') + '</div>' +
        '<div class="ldq-n"><div><span>需求</span><b>' + it.req + '</b></div><div><span>已点</span><b>' + c + '</b></div><div class="' + (rem < 0 ? 'p' : rem ? 'o' : 'g') + '"><span>' + (rem < 0 ? '超出' : '还差') + '</span><b>' + Math.abs(rem) + '</b></div></div>' +
        (allocMulti(it) ? (function () {       // v1.9.12 各家放了几个
          var ks = allocKeys(it), a = allocOf(it), sum = allocSum(a);
          return '<div class="fenmini"><b>📦 各家放了几个</b>' + ks.map(function (x) { var p = Number(a[x.k]) || 0; return '<div><span>' + esc(x.cust) + ' <small class="hint">要 ' + x.need + '</small></span><b class="' + (p < x.need ? 'err' : '') + '">' + p + '</b></div>'; }).join('') +
            (sum !== r3(c) ? '<div class="err">各家共 ' + sum + '，和点货数 ' + c + ' 不一样' + (ro ? '' : '，请改一下') + '</div>' : '') + (ro ? '' : '<button class="tbtn" id="dtAl">改各家数量</button>') + '</div>';
        })() : '') +
        '<div class="ldq-l"><b>点货记录</b>（' + list.length + ' 笔）' + (ro ? '' : '<span class="hint"> 点错了可以修改或撤销，原记录会保留</span>') + '</div>' +
        '<div class="pkl" id="dtL">' + (rows.join('') || '<div class="empty">还没有点货记录</div>') + '</div>' +
        (ro ? '<p class="hint">任务已完成，不能修改。需要更正请找办公室重新打开。</p><div class="row"><button class="btn ghost" id="dtX">关闭</button></div>' :
          '<div class="row"><button class="btn ghost" id="dtX">关闭</button><button class="btn ghost" id="dtA">调整数量</button><button class="btn save" id="dtP">＋ 再点</button></div>') + '</div>', function (m) {
          $('#dtX', m).onclick = function () { dKey = null; closeModal(); draw(); };
          if (ro) return;
          $('#dtP', m).onclick = function () { qty(it, 'SEARCH', ''); };
          $('#dtA', m).onclick = function () { adjust(it); };
          var dal = $('#dtAl', m); if (dal) dal.onclick = function () { allocEdit(it); };
          bindHist(it, m);
        });
    }
    function editTxn(it, t) {
      if (PK) return pkEditBox(it, t);
      var cur = txState(t.id).eff, total = ldCounts(s)[it.key] || 0;
      var onOk = function (v) {
        if (v === cur) { back(it); return; }
        if (v === 0) { voidTxn(it, t); return; }
        confirmBox('确定把这一笔的数量从 ' + cur + ' 改成 ' + v + '？（累计 ' + total + ' → ' + r3(total - cur + v) + '）', '确定修改', function () {
          push(it, 'EDIT', r3(v - cur), { rev: t.id, orig: cur, to: v }, '已修改：' + cur + ' 改成 ' + v).then(function () { back(it); }, function () { });
        });
      };
      onOk.live = function (v, raw) { return raw !== '' && v >= 0 ? '修改后累计：' + r3(total - cur + v) + ' / ' + it.req + (v === 0 ? '（改成 0 = 撤销这一笔）' : '') : ''; };
      numBox('修改这一笔', esc(it.desc) + ' · ' + ML[t.method] + ' ' + hhmm(t.time) + ' · 现在 ' + cur, '改成多少 <b>' + esc(it.uom || '') + '</b>？', cur, '下一步', onOk);
    }
    function voidTxn(it, t) {
      var cur = txState(t.id).eff, total = ldCounts(s)[it.key] || 0, adj = t.method === 'ADJUST';
      confirmBox('撤销这一笔' + (adj ? '调整' : '') + '（' + sg(adj ? Number(t.qty) : cur) + '）？撤销后不计入累计（' + total + ' → ' + r3(total - cur) + '），原记录保留。', '确定撤销', function () {
        push(it, 'VOID', r3(-cur), { rev: t.id, orig: cur, to: 0 }, '已撤销一笔 ' + sg(cur)).then(function () { back(it); }, function () { });
      });
    }
    /** 调整累计：输入正确的总数，系统加一笔差额（记录 原累计 → 调整后） */
    function adjust(it) {
      var cur = ldCounts(s)[it.key] || 0;
      var onOk = function (v, m) {
        var reason = ($('#nbR', m) || {}).value || '';
        if (v === cur) { back(it); return; }
        confirmBox('确定把累计从 ' + cur + ' 改成 ' + v + '（' + sg(r3(v - cur)) + '）？', '确定调整', function () {
          push(it, 'ADJUST', r3(v - cur), { orig: cur, to: v, reason: reason.trim().slice(0, 200) }, '已调整累计：' + cur + ' → ' + v).then(function () { back(it); }, function () { });
        });
      };
      onOk.live = function (v, raw) { return raw !== '' && v >= 0 ? (v === cur ? '没有变化' : '差额 ' + sg(r3(v - cur)) + (v > it.req ? '（超出需求 ' + r3(v - it.req) + '）' : '')) : ''; };
      numBox('调整数量', esc(it.desc) + ' · 需求 ' + it.req + ' · 现在累计 <b>' + cur + '</b>', '正确的累计数量是多少 <b>' + esc(it.uom || '') + '</b>？', cur, '下一步', onOk,
        '<input id="nbR" class="pkq" style="margin-top:10px" maxlength="200" placeholder="原因（可不填），例：箱子破损退回">');
    }
    // 整个任务的点货记录（最新在上）；点一行打开那个商品的详情去修改
    function showHistory() {
      var list = Object.keys(s.txns).map(function (k) { return s.txns[k]; }).filter(function (t) { return t.method !== 'ALLOC'; }).sort(function (a, b) { return byTime(b, a); });
      var voided = {}; list.forEach(function (t) { if (t.method === 'VOID' || t.method === 'REVERSAL') voided[t.rev] = 1; });
      var name = function (k) { var it = byKey(k); return it ? dn(it) + (it.uom ? '（' + it.uom + '）' : '') : k; };
      modal('<h3 style="margin-top:0">点货记录（' + list.length + ' 笔）</h3><p class="hint" style="margin-top:-6px">点一行可以修改 / 撤销。修改、撤销、调整都会另记一笔，原记录保留。</p><div class="pkl">' + (list.length ? list.map(function (t) {
        var d = t.method === 'EDIT' ? (PK ? t.orig + ' → ' + t.to : '把 ' + t.orig + ' 改成 ' + t.to) : t.method === 'ADJUST' ? '累计 ' + t.orig + ' → ' + t.to : '';
        return '<div class="ldh ldhc' + (voided[t.id] ? ' gone' : '') + '" data-hk="' + esc(t.key) + '"><span class="t"><b>' + esc(name(t.key)) + '</b><span>' + esc(hhmm(t.time)) + ' · <span data-nt>' + esc(t.staff || '') + '</span> · ' +
          esc(ML[t.method] || t.method) + (d ? ' · ' + esc(d) : '') + (t.reason ? ' · ' + esc(t.reason) : '') + (t.synced ? '' : ' · <span class="err">未上传</span>') + (voided[t.id] ? ' · 已撤销' : '') + '</span></span>' +
          '<b class="q">' + sg(Number(t.qty)) + '</b></div>';
      }).join('') : '<div class="empty">还没有点货记录</div>') + '</div><div class="row"><button class="btn ghost" id="hX">关闭</button></div>', function (m) {
        $('#hX', m).onclick = closeModal;
        Array.prototype.forEach.call(m.querySelectorAll('[data-hk]'), function (r) { r.onclick = function () { detail(byKey(r.dataset.hk)); }; });
      });
    }
    // v1.4.5 任务被删除（电脑端 / 办公室）→ 停止点货，显示提示，回到列表
    ldOnGone = function (tid) {
      if (tid !== id || location.hash.indexOf(ldHash(id)) !== 0) return;
      s = null; dKey = null; closeModal(); msg = { cls: 'bad', text: ldGone(id) }; draw();
      app.innerHTML = ldW('<div class="card ldgone"><div class="upok-ic" style="background:#fde8e7;color:#b42318">✕</div><h2>' + esc(ldGone(id)) + '</h2><p class="hint">任务 ' + esc(id) + ' 已不能再点货。请回到任务列表。</p><button class="btn save" id="goneBack">回到任务列表</button></div>');
      $('#goneBack').onclick = function () { location.hash = '#/' + mod; };
      errBeep();
    };
    // 每 30 秒轻量检查一次这个任务的状态（被删除 / 被别人完成 / 被重新打开）
    if (ldStTimer) clearInterval(ldStTimer);
    var stTimer = ldStTimer = setInterval(function () {
      if (location.hash.indexOf(ldHash(id)) !== 0) { clearInterval(stTimer); return; }
      if (document.hidden || !s || navigator.onLine === false) return;
      api({ action: 'ldStatus', taskIds: [id] }, true).then(function (d) {
        var v = d.status && d.status[id];
        if (v === 'gone') return ldPurge(id);
        if (v === 'moved') return ldPurge(id, true);
        if (v && s && v !== s.task.status && !s.localDone && !ldPending(id)) ldRefetch([id]).then(function () { if (ldRedraw) ldRedraw(); });
      }, function () { });
    }, 30000);
    ldRedraw = function () {
      if (location.hash.indexOf(ldHash(id)) === 0 && s) ldGet(id).then(function (x) {
        if (!x && !ldMem[id]) return;
        if (x) s = x;
        if ($('#modal').hidden) draw();
        else if (dKey && $('#dtL')) { draw(); detail(byKey(dKey)); }       // 详情开着：显示最新数量
      });
    };
    currentRedraw = ldRedraw;
    ldLoadQ().then(function () { return ldGet(id); }).then(function (local) {
      if (local) { s = local; draw(); }
      if (local && IT != null && Date.now() - Date.parse(local.fetched || 0) < 120000) { ldFlush(); return; }   // SKU 页之间切换：刚下载过就不重复下载
      return api({ action: 'ldTask', taskId: id }, true).then(function (d) {
        if (d.error === 'NOTASK') return ldPurge(id, d.moved ? d.message : false);        // 任务已被删除 → 清掉本机资料和待上传；改派 → 清掉本机资料，待上传的照样上传
        if (d.error) { if (!s) { msg = { cls: 'bad', text: d.message }; draw(); } return; }
        return ldGet(id).then(function (cur) { s = ldFromServer(d, cur); return ldPut(s); }).then(function () { if ($('#modal').hidden) draw(); ldFlush(); });
      }, function (e) {
        if (!s) { msg = { cls: 'bad', text: e.network ? '离线：这个任务还没下载到手机。第一次打开需要联网。' : e.message }; draw(); }
      });
    });
    draw();
  }
  // =====================================================================
  // v1.8 PDA【📍 库位】（只有仓管）：扫货架看放了什么、扫箱码看在哪；核实 / 改库位 / 绑定 / 移走；待核实、没有库位、待处理 三个清单
  //   按「商品 + 批次」记库位。货上没有批次码：选批次时显示生产日期 / 到期日，对着箱子上的日期选。需要联网。
  // =====================================================================
  function viewLm(sub, arg) {
    setBar('库位管理', false);
    var LMS = { busy: false };
    var head = function (inner) { var o = $('#lmIn'); LMS.keep = o && document.activeElement === o ? o.value : null; return modTabs('lm') + '<div class="lmscan"><input id="lmIn" inputmode="none" maxlength="64" autocomplete="off" spellcheck="false" placeholder="扫货架码 / 箱码 / 搜索商品"><button class="btn cam" id="lmCam" aria-label="摄像头扫码">📷</button></div>' + inner; };
    var stChip = function (s) { return '<span class="lmst ' + (s === '已核实' ? 'ok' : 'todo') + '">' + (s === '已核实' ? '✓ 已核实' : '? 待核实') + '</span>'; };
    function bindHead() {
      bindModTabs();
      var inp = $('#lmIn');
      if (LMS.keep != null) { inp.value = LMS.keep; inp.focus(); LMS.keep = null; }   // 重新画页面时扫描枪正在输入：不丢字
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); var v = inp.value.trim(); inp.value = ''; inp.blur(); if (v) go(v); } });
      $('#lmCam').onclick = function () { openCamera('lm', function (code) { go(code); }, { label: '货架码 / 箱码', qr: true }); };
    }
    /** 扫到 / 输入的东西：库位 → 库位页；箱码 → 商品页；文字 → 搜索 */
    function go(v) {
      var c = normLoc(v);
      if (c && locRe().test(c)) { location.hash = '#/lm/l/' + encodeURIComponent(c); return; }
      loading('查找中…');
      api({ action: 'lmFind', code: v }, true).then(function (d) {
        if (d.kind === 'item') { lmLast = d; location.hash = '#/lm/i/' + encodeURIComponent(d.item) + (/^\d{6,}$/.test(v) ? '?bc=' + encodeURIComponent(v) : ''); return; }
        if (d.kind === 'unknown') return pickItem('', '这个码系统还不认识：' + v + '（可能是新商品，也可能是老商品的另一个箱码）。先搜品名：找到就选它，系统会记住这个码；都不是再点“新商品”。', function (it) {
          if (!it.isNewName) { api({ action: 'lmSave', act: 'learn', item: it.item, barcode: v }, true).then(function (r) { if (r.status === 'ok') toast('已记住：' + v + ' 是 ' + (it.desc || it.item), 2500); else toast('记不住：' + r.message, 4000); }, function () { }); location.hash = '#/lm/i/' + encodeURIComponent(it.item) + '?bc=' + encodeURIComponent(v); return; }
          askLoc('新商品放在哪个库位？', '', function (c) { save({ act: 'bind', newName: it.desc, barcode: v, loc: c }, '已记住新商品，库位 ' + c, function (r) { location.hash = '#/lm/i/' + encodeURIComponent(r.item) + '?bc=' + encodeURIComponent(v); }); });
        }, null, v);
        if (d.kind === 'search') return pickItem(v, '', function (it) {
          if (!it.isNewName) { location.hash = '#/lm/i/' + encodeURIComponent(it.item); return; }
          askLoc('新商品放在哪个库位？', '', function (c) { save({ act: 'bind', newName: it.desc, loc: c }, '已记住新商品，库位 ' + c, function (r) { location.hash = '#/lm/i/' + encodeURIComponent(r.item); }); });
        }, d.items, '');
        draw();
      }, fail);
    }
    var lmLastMsg = '';
    function fail(e) { LMS.busy = false; lmLastMsg = e.network ? '没有网络：库位管理需要联网' : e.message; draw(); errBeep(); }
    function loading(t) { app.innerHTML = head('<div class="empty">' + esc(t) + '</div>'); bindHead(); }
    /** 搜索 / 选商品（弹窗） */
    function pickItem(q, note, cb, first, newCode) {
      var show = function (items, qq) {
        modal('<div class="ldq"><div class="ldq-h">选商品</div>' + (note ? '<p class="hint">' + esc(note) + '</p>' : '') +
          '<div class="lmrow"><input id="piQ" class="pkq" placeholder="品名 / Item Code" value="' + esc(qq || '') + '"><button class="btn save" id="piGo" style="flex:0 0 70px">搜索</button></div>' +
          '<div class="lmpick">' + (items ? (items.length ? items.map(function (x, i) { return '<button class="lmpi" data-pi="' + i + '"><b data-nt>' + esc(x.desc) + '</b><span>' + (x.isNew ? '<em class="lmnew">新商品</em>' : '<span data-nt>' + esc(x.item) + '</span>') + (x.stock === false && !x.isNew ? ' · 没有库存' : '') + '</span></button>'; }).join('') : '<p class="hint">没有找到</p>') : '') + '</div>' +
          (newCode != null && items ? '<button class="tbtn lmnewb" id="piNew">都不是：新商品（系统里还没有）</button>' : '') +
          '<div class="row"><button class="btn ghost" id="piX">取消</button></div></div>', function (m) {
            var q2 = $('#piQ', m), run = function () { var v = q2.value.trim(); if (!v) return; api({ action: 'lmFind', code: v }, true).then(function (d) { show(d.kind === 'search' ? d.items : d.kind === 'item' ? [{ item: d.item, desc: d.desc }] : [], v); }, function (e) { toast(e.message, 2500); }); };
            $('#piGo', m).onclick = run; q2.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } };
            $('#piX', m).onclick = function () { closeModal(); draw(); };
            Array.prototype.forEach.call(m.querySelectorAll('[data-pi]'), function (b) { b.onclick = function () { closeModal(); cb(items[+b.dataset.pi]); }; });
            var nb = $('#piNew', m); if (nb) nb.onclick = function () { newItem(q2.value.trim(), newCode, cb); };
            if (!items) { if (q2.value.trim()) run(); else setTimeout(function () { q2.focus(); }, 50); }
          });
      };
      show(first || null, q);
    }
    /** 新商品：输入品名（系统先用临时编号记住，以后导入条码表 / 库存表对上了自动合并） */
    function newItem(name, code, cb) {
      modal('<div class="ldq"><div class="ldq-h">新商品</div><p class="hint">' + (code ? '箱码 <b data-nt>' + esc(code) + '</b> · ' : '没有箱码 · ') + '写下箱子上的品名，系统记住它和库位。以后 DO 开这个商品就能找到库位。</p>' +
        '<input id="niN" class="pkq" maxlength="100" autocomplete="off" placeholder="品名，例如 李錦記蒸鱼豉油 410ML" value="' + esc(/^\d+$/.test(name || '') ? '' : name || '') + '"><div id="niM" class="ldq-m"></div>' +
        '<div class="row"><button class="btn ghost" id="niX">取消</button><button class="btn save" id="niO">下一步：扫库位</button></div></div>', function (m) {
          var inp = $('#niN', m), ok = function () { var v = inp.value.trim(); if (v.length < 2) { $('#niM', m).className = 'ldq-m err'; $('#niM', m).textContent = '请写品名'; errBeep(); return; } closeModal(); cb({ item: '', desc: v, isNewName: true }); };
          inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
          $('#niO', m).onclick = ok; $('#niX', m).onclick = function () { closeModal(); draw(); }; setTimeout(function () { inp.focus(); }, 50);
        });
    }
    /** 扫 / 输入一个库位（弹窗） */
    function askLoc(title, cur, cb) {
      modal('<div class="ldq"><div class="ldq-h">' + esc(title) + '</div><p class="hint">扫货架上的库位码，或输入，例如 07-J-01</p>' +
        '<input id="alIn" class="pkq" maxlength="20" autocomplete="off" autocapitalize="characters" placeholder="07-J-01" value="' + esc(cur || '') + '"><div id="alM" class="ldq-m"></div>' +
        '<div class="row"><button class="btn ghost" id="alC">取消</button><button class="btn save" id="alO">确定</button></div></div>', function (m) {
          var inp = $('#alIn', m), ok = function () { var c = normLoc(inp.value); if (!c || !locRe().test(c)) { $('#alM', m).className = 'ldq-m err'; $('#alM', m).textContent = '库位格式不对，例如 07-J-01'; errBeep(); return; } closeModal(); cb(c); };
          inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
          $('#alO', m).onclick = ok; $('#alC', m).onclick = closeModal; setTimeout(function () { inp.focus(); inp.select(); }, 50);
        });
    }
    function save(p, okMsg, after) {
      if (LMS.busy) return; LMS.busy = true;
      api(Object.assign({ action: 'lmSave' }, p), true).then(function (d) {
        LMS.busy = false;
        if (d.status !== 'ok') { errBeep(); return toast(d.message || '没有保存', 3000); }
        beep(); toast(d.already ? '已经是这样了' : okMsg, 2000); (after || draw)(d);
      }, function (e) { LMS.busy = false; errBeep(); toast(e.network ? '没有网络，没有保存' : e.message, 3000); });
    }
    /** 一条库位记录的按钮 */
    function recActs(x, fromLoc) {
      return '<div class="lmacts">' + (x.status !== '已核实' ? '<button class="btn save" data-v="' + esc(x.id) + '">✓ 核实在这里</button>' : '') +
        '<button class="tbtn" data-mv="' + esc(x.id) + '" data-cur="' + esc(x.loc) + '">改库位</button><button class="tbtn red" data-rm="' + esc(x.id) + '" data-what="' + esc(x.desc + ' ' + x.base + ' @ ' + x.loc) + '">不在这里了</button></div>';
    }
    function bindRecActs() {
      Array.prototype.forEach.call(app.querySelectorAll('[data-v]'), function (b) { b.onclick = function () { save({ act: 'verify', id: b.dataset.v }, '已核实'); }; });
      Array.prototype.forEach.call(app.querySelectorAll('[data-mv]'), function (b) { b.onclick = function () { askLoc('改到哪个库位？（现在 ' + b.dataset.cur + '）', '', function (c) { save({ act: 'move', id: b.dataset.mv, loc: c }, '已改到 ' + c); }); }; });
      Array.prototype.forEach.call(app.querySelectorAll('[data-rm]'), function (b) { b.onclick = function () { confirmBox('确定“' + b.dataset.what + '”不在这个库位了？（记录会保留，可在后台查到）', '不在这里了', function () { save({ act: 'remove', id: b.dataset.rm }, '已移走'); }); }; });
    }
    /** 选批次 → 绑定到库位 */
    function bindFlow(v, loc, bc, taskId) {
      var bs = v.batches.filter(function (b) { return b.qty > 0; });
      var pickBatch = function (cb) {
        if (bs.length === 1) return cb(bs[0]);
        modal('<div class="ldq"><div class="ldq-h">是哪个批次？</div><p class="hint">对照箱子上印的<b>生产日期 / 到期日</b>选</p><div class="lmpick">' +
          (bs.length ? bs : v.batches).map(function (b, i) { return '<button class="lmpi" data-bi="' + i + '"><b data-nt>' + esc(b.base || '（没有批次号）') + '</b><span>生产 ' + esc(b.mfg || '—') + ' · 到期 ' + esc(b.exp || '—') + ' · 库存 ' + b.qty + ' ' + esc(b.uom || '') + '</span></button>'; }).join('') +
          '</div><div class="row"><button class="btn ghost" id="bX">取消</button></div></div>', function (m) {
            $('#bX', m).onclick = closeModal;
            Array.prototype.forEach.call(m.querySelectorAll('[data-bi]'), function (b) { b.onclick = function () { closeModal(); cb((bs.length ? bs : v.batches)[+b.dataset.bi]); }; });
          });
      };
      pickBatch(function (b) {
        var doIt = function (c) { save({ act: 'bind', item: v.item, base: b.base, loc: c, barcode: bc || '', taskId: taskId || '' }, '已绑定 ' + c); };
        if (loc) doIt(loc); else askLoc('放在哪个库位？', '', doIt);
      });
    }
    function draw() {
      var m;
      if (sub === 'l') return drawLoc(arg);
      if (sub === 'i') return drawItem(arg);
      if (sub === 'todo' || sub === 'noloc' || sub === 'tasks') return drawList(sub);
      if (sub === 'a') return drawAisle(arg);
      if (sub === 'empty') return drawEmpty();
      if (sub === 'exp') return drawExp(arg);
      // 首页 = 现场总览：每排进度
      // v1.8.6 先显示上次的总览（马上能点），后台读到最新的再刷新
      var cached = LS.get('lmMapC', null), myHash = location.hash, fresh = false;
      if (cached) renderMap(cached); else loading('读取库位总览…');
      api({ action: 'lmMap' }, true).then(function (d) {
        if (location.hash !== myHash) return;
        fresh = true; LS.set('lmMapC', d); renderMap(d);
      }, function (e) { if (cached) { var u = $('#lmUpd'); if (u) u.textContent = e.network ? '离线：显示的是上次的' : '更新失败：' + e.message; } else fail(e); });
      function renderMap(d) {
        setBar('库位总览', false);
        var L = d.locs, tot = L.ok + L.todo + L.task + L.empty, pct = function (x, t) { return (t ? x * 100 / t : 0).toFixed(1) + '%'; };
        app.innerHTML = head((lmLastMsg ? '<p class="err">' + esc(lmLastMsg) + '</p>' : '') +
          '<div class="lmstats">' + [['tasks', d.counts.tasks, '待处理', 'r'], ['todo', d.counts.todo, '待核实', 'y'], ['empty', L.empty, '空库位', 'k'], ['noloc', d.counts.noloc, '没库位商品', 'k']].map(function (x) {
            return '<button data-go="' + x[0] + '"><b class="' + x[3] + '">' + x[1] + '</b><span>' + x[2] + '</span></button>'; }).join('') + '</div>' +
          '<div class="lmchips"><button class="tbtn" data-go="exp">⏰ 快到期</button><span class="hint">已核实库位 ' + L.ok + ' / ' + tot + '</span><span class="hint" id="lmUpd">' + (fresh ? '' : '更新中…') + '</span></div>' +
          '<div class="lmlg"><span class="ok">已核实</span><span class="todo">待核实</span><span class="task">有问题</span><span class="emp">空</span></div>' +
          d.aisles.map(function (a) {
            return '<button class="card lmais" data-a="' + a.a + '"><span class="lmaisn" data-nt>' + a.a + '</span><span class="lmpb"><i class="ok" style="width:' + pct(a.ok, a.total) + '"></i><i class="todo" style="width:' + pct(a.todo, a.total) + '"></i><i class="task" style="width:' + pct(a.task, a.total) + '"></i></span>' +
              '<small>' + a.ok + '/' + a.total + ' 已核实<br>空 ' + a.empty + (a.task ? ' · ⚠ ' + a.task : '') + '</small></button>';
          }).join('') + (d.aisles.length ? '' : '<div class="empty">还没有库位资料：请先在电脑后台导入 AutoCount 库存表</div>'));
        bindHead(); lmLastMsg = '';
        Array.prototype.forEach.call(app.querySelectorAll('[data-go]'), function (b) { b.onclick = function () { location.hash = '#/lm/' + b.dataset.go; }; });
        Array.prototype.forEach.call(app.querySelectorAll('[data-a]'), function (b) { b.onclick = function () { location.hash = '#/lm/a/' + b.dataset.a; }; });
      }
    }
    /** 一排一张表：行 = 位置（字母），列 = 层 */
    function drawAisle(a) {
      loading('读取第 ' + a + ' 排…');
      api({ action: 'lmMap', kind: 'aisle', aisle: a }, true).then(function (d) {
        setBar('第 ' + d.aisle + ' 排', true);
        var ix = d.aisles.indexOf(d.aisle), prev = d.aisles[ix - 1], next = d.aisles[ix + 1];
        var ps = [], lvs = [], by = {};
        d.cells.forEach(function (c) { if (ps.indexOf(c.p) < 0) ps.push(c.p); if (lvs.indexOf(c.lv) < 0) lvs.push(c.lv); by[c.p + c.lv] = c; });
        ps.sort(); lvs.sort();
        var stTxt = { ok: '已核实', todo: '待核实', task: '有问题', empty: '空' };
        app.innerHTML = head('<div class="lmnav">' + (prev ? '<button class="tbtn" data-a="' + prev + '">◀ ' + prev + '</button>' : '<span></span>') + '<b>第 ' + d.aisle + ' 排 · ' + d.cells.length + ' 个库位</b>' + (next ? '<button class="tbtn" data-a="' + next + '">' + next + ' ▶</button>' : '<span></span>') + '</div>' +
          '<div class="lmlg"><span class="ok">已核实</span><span class="todo">待核实</span><span class="task">有问题</span><span class="emp">空</span></div>' +
          '<div class="lmgrid" style="grid-template-columns:24px repeat(' + lvs.length + ',1fr)"><span></span>' + lvs.map(function (l) { return '<span class="lmgh">' + l + ' 层</span>'; }).join('') +
          ps.map(function (p) {
            return '<span class="lmgp">' + p + '</span>' + lvs.map(function (l) {
              var c = by[p + l];
              if (!c) return '<span class="lmcell none"></span>';
              return '<button class="lmcell ' + c.st + '" data-c="' + esc(c.loc) + '" aria-label="' + esc(c.loc + ' ' + stTxt[c.st]) + '">' + (c.n ? '<b data-nt>' + esc(c.first) + '</b>' + (c.n > 1 ? '<small>+' + (c.n - 1) + ' 个</small>' : '') : '<small>空</small>') + '</button>';
            }).join('');
          }).join('') + '</div><p class="hint">点格子看放了什么。字母 = 位置，01–03 = 层。</p>');
        bindHead();
        Array.prototype.forEach.call(app.querySelectorAll('[data-a]'), function (b) { b.onclick = function () { location.hash = '#/lm/a/' + b.dataset.a; }; });
        Array.prototype.forEach.call(app.querySelectorAll('[data-c]'), function (b) { b.onclick = function () { peekLoc(b.dataset.c); }; });
      }, fail);
    }
    /** 点格子：弹出这个库位放了什么 */
    function peekLoc(loc) {
      api({ action: 'lmFind', code: loc }, true).then(function (d) {
        modal('<div class="ldq"><div class="ldq-h"><span data-nt>' + esc(d.loc) + '</span> · ' + d.rows.length + ' 个商品</div>' +
          (d.rows.length ? d.rows.map(function (x) { return '<div class="lmpeek"><b data-nt>' + esc(x.desc) + '</b> ' + stChip(x.status) + '<small>批次 <span data-nt>' + esc(x.base || '—') + '</span> · 库存 ' + x.stock + (x.stock && x.uom ? ' ' + esc(x.uom) : '') + (x.status === '已核实' ? ' · ' + esc(x.by) + ' ' + esc(x.at) : ' · ' + esc(x.source)) + '</small></div>'; }).join('') : '<p class="hint">系统里这个库位是空的</p>') +
          '<div class="row"><button class="btn ghost" id="pkX">关闭</button><button class="btn save" id="pkO">打开这个库位（核实 / 改）</button></div></div>', function (m) {
            $('#pkX', m).onclick = closeModal; $('#pkO', m).onclick = function () { closeModal(); location.hash = '#/lm/l/' + encodeURIComponent(d.loc); };
          });
      }, function (e) { toast(e.network ? '没有网络' : e.message, 2500); });
    }
    function drawEmpty() {
      loading('读取空库位…');
      api({ action: 'lmMap', kind: 'empty' }, true).then(function (d) {
        setBar('空库位（' + d.list.length + '）', true);
        app.innerHTML = head('<p class="hint">系统里没有放东西的库位（只列出 AutoCount 或系统里出现过的库位）。给新品安排库位：挑一个，到现场确认是空的，点进去扫箱码绑定。</p>' +
          (d.list.length ? d.list.map(function (x) { return '<button class="card lmemp" data-l="' + esc(x.loc) + '"><b class="pkloc" data-nt>' + esc(x.loc) + '</b><small>' + (x.gone ? '上次 ' + esc(x.gone.slice(0, 5)) + ' 移走' : x.hist ? 'AutoCount 以前放过，现在没库存' : '系统里没放过') + '</small></button>'; }).join('') : '<div class="empty">没有空库位</div>'));
        bindHead();
        Array.prototype.forEach.call(app.querySelectorAll('[data-l]'), function (b) { b.onclick = function () { location.hash = '#/lm/l/' + encodeURIComponent(b.dataset.l); }; });
      }, fail);
    }
    function drawExp(days) {
      days = +days || 60;
      loading('读取快到期…');
      api({ action: 'lmMap', kind: 'exp', days: days }, true).then(function (d) {
        setBar('快到期（' + d.list.length + '）', true);
        app.innerHTML = head('<div class="lmchips">' + [30, 60, 90].map(function (n) { return '<button class="tbtn' + (n === d.days ? ' on' : '') + '" data-d="' + n + '">' + n + ' 天内</button>'; }).join('') + '</div>' +
          (d.list.length ? d.list.map(function (x) {
            return '<button class="card lmgrp" data-i="' + esc(x.item) + '"><b data-nt>' + esc(x.desc) + '</b><span class="' + (x.days < 0 ? 'r' : x.days <= 30 ? 'y' : '') + '">' + (x.days < 0 ? '已过期 ' + (-x.days) + ' 天' : '还有 ' + x.days + ' 天') + '</span>' +
              '<small>到期 ' + esc(x.exp) + ' · 批次 <span data-nt>' + esc(x.base) + '</span> · 库存 ' + x.qty + ' ' + esc(x.uom) + ' · 库位 <b data-nt>' + esc(x.locs.join(' / ') || '没有') + '</b></small></button>';
          }).join('') : '<div class="empty">' + d.days + ' 天内没有到期的</div>'));
        bindHead();
        Array.prototype.forEach.call(app.querySelectorAll('[data-d]'), function (b) { b.onclick = function () { location.hash = '#/lm/exp/' + b.dataset.d; }; });
        Array.prototype.forEach.call(app.querySelectorAll('[data-i]'), function (b) { b.onclick = function () { location.hash = '#/lm/i/' + encodeURIComponent(b.dataset.i); }; });
      }, fail);
    }
    function drawLoc(loc) {
      loading('读取库位 ' + loc + '…');
      api({ action: 'lmFind', code: loc }, true).then(function (d) {
        setBar('库位 ' + d.loc, true);
        app.innerHTML = head('<div class="lmloc"><div class="pkloc big" data-nt>' + esc(d.loc) + '</div><span>' + d.rows.length + ' 个商品 / 批次</span></div>' +
          (d.rows.length ? d.rows.map(function (x) {
            return '<div class="card lmrec"><div class="lmrec-h"><b data-nt>' + esc(x.desc) + '</b>' + stChip(x.status) + '</div><div class="hint"><span data-nt>' + esc(x.item) + '</span> · 批次 <b data-nt>' + esc(x.base || '—') + '</b> · 库存 ' + x.stock + (x.stock && x.uom ? ' ' + esc(x.uom) : '') +
              (x.status !== '已核实' ? ' · 来自 ' + esc(x.source) : ' · ' + esc(x.by) + ' ' + esc(x.at)) + '</div>' + recActs(x) + '</div>';
          }).join('') : '<div class="empty">系统里这个库位还没有商品</div>') +
          '<button class="btn save lmadd" id="lmAdd">＋ 这个库位还放了别的商品（扫箱码）</button>');
        bindHead(); bindRecActs();
        $('#lmAdd').onclick = function () {
          modal('<div class="ldq"><div class="ldq-h">扫箱码</div><p class="hint">扫箱子上的条码；箱子上没有条码就输入品名搜索</p><input id="adIn" class="pkq" autocomplete="off"><div class="row"><button class="btn ghost" id="adX">取消</button><button class="btn save" id="adO">下一步</button></div></div>', function (m) {
            var inp = $('#adIn', m), next = function () {
              var v = inp.value.trim(); if (!v) return; closeModal();
              api({ action: 'lmFind', code: v }, true).then(function (r) {
                if (r.kind === 'item') return bindFlow(r, d.loc, /^\d{6,}$/.test(v) ? v : '');
                var code = /^\d{6,}$/.test(v) ? v : '';
                var then = function (it) {
                  if (it.isNewName) return save({ act: 'bind', newName: it.desc, barcode: code, loc: d.loc }, '已记住新商品，库位 ' + d.loc);
                  api({ action: 'lmFind', code: it.item, item: it.item }, true).then(function (r2) { bindFlow(r2, d.loc, code); }, fail);
                };
                if (r.kind === 'unknown') return pickItem('', '这个码系统还不认识：' + v + '（可能是新商品，也可能是老商品的另一个箱码）。先搜品名：找到就选它，系统会记住这个码；都不是再点“新商品”。', then, null, v);
                pickItem(v, '', then, r.items || [], '');
              }, fail);
            };
            inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); next(); } };
            $('#adO', m).onclick = next; $('#adX', m).onclick = closeModal; setTimeout(function () { inp.focus(); }, 50);
          });
        };
      }, fail);
    }
    function drawItem(item) {
      var bc = (location.hash.match(/\?bc=([^&]+)/) || [])[1]; bc = bc ? decodeURIComponent(bc) : '';
      loading('读取商品…');
      api({ action: 'lmFind', code: item, item: item }, true).then(function (v) {
        setBar('商品库位', true);
        app.innerHTML = head('<div class="card lmitem"><b data-nt>' + esc(v.desc) + '</b><div class="hint">' + (v.isNew ? '<em class="lmnew">新商品 · 还没对上 AutoCount</em>' : '<span data-nt>' + esc(v.item) + '</span>') + (bc ? ' · 箱码 <span data-nt>' + esc(bc) + '</span>' : '') + '</div>' +
          (v.barcodes && v.barcodes.length ? '<div class="hint lmbcs">条码：<span data-nt>' + esc(v.barcodes.join(' · ')) + '</span></div>' : '') +
          (v.isNew ? '<button class="tbtn" id="lmMerge">其实是已有商品？合并过去</button>' : '') + '</div>' +
          (v.batches.length ? v.batches.map(function (b, bi) {
            return '<div class="card lmbatch">' + (b.nobatch ? '<div class="lmrec-h"><b>不分批次</b><span class="hint">' + (v.isNew ? '新商品' : '没有库存批次') + '</span></div>' :
              '<div class="lmrec-h"><b data-nt>批次 ' + esc(b.base || '—') + '</b><span class="hint">库存 ' + b.qty + ' ' + esc(b.uom) + '</span></div><div class="hint">生产 ' + esc(b.mfg || '—') + ' · 到期 ' + esc(b.exp || '—') +
              (b.ac.length ? ' · AutoCount：' + esc(b.ac.join(' / ')) : '') + '</div>') +
              (b.locs.length ? b.locs.map(function (x) { return '<div class="lmloc2"><b class="pkloc" data-nt>' + esc(x.loc) + '</b>' + stChip(x.status) + recActs(x) + '</div>'; }).join('') : '<p class="err" style="margin:4px 0">没有库位</p>') +
              '<button class="tbtn lmbind" data-bb="' + bi + '">＋ 绑定库位</button></div>';
          }).join('') : '<div class="empty">这个商品现在没有库存批次</div>'));
        bindHead(); bindRecActs();
        var mg = $('#lmMerge'); if (mg) mg.onclick = function () {
          pickItem(v.desc.split(/\s+/)[0], '选它其实是哪个商品。库位和条码都会合并过去。', function (it) {
            if (it.isNew || it.item === v.item) return toast('请选 AutoCount 里的商品', 2500);
            confirmBox('把“' + v.desc + '”合并到“' + it.desc + '”（' + it.item + '）？', '合并', function () { save({ act: 'merge', item: v.item, into: it.item }, '已合并', function () { location.hash = '#/lm/i/' + encodeURIComponent(it.item); }); });
          });
        };
        Array.prototype.forEach.call(app.querySelectorAll('[data-bb]'), function (b) { b.onclick = function () { var one = Object.assign({}, v, { batches: [v.batches[+b.dataset.bb]] }); one.batches[0] = Object.assign({}, one.batches[0], { qty: Math.max(1, one.batches[0].qty) }); bindFlow(one, '', bc); }; });
      }, fail);
    }
    function drawList(kind) {
      loading('读取中…');
      api({ action: 'lmTodo', kind: kind }, true).then(function (d) {
        setBar({ todo: '待核实', noloc: '没有库位', tasks: '待处理' }[kind] + '（' + d.counts[kind] + '）', true);
        var L = d.list, h = '';
        if (kind === 'todo') {
          var g = {}, order = [];
          L.forEach(function (x) { if (!g[x.loc]) { g[x.loc] = []; order.push(x.loc); } g[x.loc].push(x); });
          h = order.map(function (l) { return '<button class="card lmgrp" data-l="' + esc(l) + '"><b class="pkloc" data-nt>' + esc(l) + '</b><span>' + g[l].length + ' 个待核实</span><small data-nt>' + esc(g[l].slice(0, 3).map(function (x) { return x.desc; }).join('、')) + (g[l].length > 3 ? '…' : '') + '</small></button>'; }).join('');
        } else if (kind === 'noloc') {
          h = L.map(function (x) { return '<button class="card lmgrp" data-i="' + esc(x.item) + '"><b data-nt>' + esc(x.desc) + '</b><span>库存 ' + x.qty + ' ' + esc(x.uom) + '</span><small><span data-nt>' + esc(x.item) + ' · ' + esc(x.base) + '</span> · 到期 ' + esc(x.exp || '—') + '</small></button>'; }).join('');
        } else {
          h = L.map(function (t, i) {
            if (t.type === '移库：库位覆盖待确认') return '<div class="card lmtask"><div class="lmrec-h"><b>库位里还有旧货？</b><span class="hint">' + esc(t.at) + '</span></div>' +      // v1.8.6
              '<div class="lmmv">新托盘放到 <b class="pkloc" data-nt>' + esc(t.to) + '</b></div><div class="hint"><span data-nt>' + esc(t.desc || '') + '</span> · ' + esc(t.note) + '</div>' +
              '<p class="hint lmchk">请到 <b data-nt>' + esc(t.to) + '</b> 看一下：旧货不在了就在库位页里点“不在这里了”</p>' +
              '<div class="lmacts"><button class="btn save" data-go="' + esc(t.to) + '">打开库位 ' + esc(t.to) + '</button><button class="tbtn" data-sk="' + i + '">处理好了</button></div></div>';
            if (t.type === '移库：箱码不认识') return '<div class="card lmtask"><div class="lmrec-h"><b>移库：箱码不认识</b><span class="hint">' + esc(t.at) + '</span></div>' +      // v1.8.7
              '<div>箱码 <b data-nt>' + esc(t.bc) + '</b></div><div class="lmmv"><span data-nt>' + esc(t.from || '（没扫来源）') + '</span> → <b class="pkloc" data-nt>' + esc(t.to) + '</b></div><div class="hint">' + esc(t.note) + '</div>' +
              ((t.cands || []).length ? '<p class="hint lmchk">他从 <b data-nt>' + esc(t.from) + '</b> 搬走的是哪个？点一下（系统记住这个箱码，并把库位改到 ' + esc(t.to) + '）</p><div class="lmcands">' +
                t.cands.map(function (c, j) { return '<button class="tbtn lmcand" data-cd="' + i + ':' + j + '"><b data-nt>' + esc(c.desc) + '</b><span data-nt>' + esc(c.item) + (c.base ? ' · 批次 ' + esc(c.base) : '') + '</span>' + (c.exp ? '<span>到期 <b>' + esc(c.exp) + '</b></span>' : '') + '</button>'; }).join('') + '</div>'
                : (t.from ? '<p class="hint lmchk">系统里 ' + esc(t.from) + ' 没有记录，请搜品名</p>' : '')) +
              '<div class="lmacts"><button class="btn save" data-ts="' + i + '">' + ((t.cands || []).length ? '都不是：搜品名' : '搜品名 / 选商品') + '</button><button class="tbtn" data-sk="' + i + '">忽略</button></div></div>';
            return '<div class="card lmtask"><div class="lmrec-h"><b>' + esc(t.type) + '</b><span class="hint">' + esc(t.at) + '</span></div><div><b data-nt>' + esc(t.desc || '（不认识的箱码）') + '</b></div><div class="hint">' +
              (t.bc ? '箱码 <span data-nt>' + esc(t.bc) + '</span> · ' : '') + (t.base ? '批次 <span data-nt>' + esc(t.base) + '</span> · ' : '') + esc(t.note) + '</div>' +
              (t.to ? '<div class="lmmv"><span data-nt>' + esc(t.from || '—') + '</span> → <b class="pkloc" data-nt>' + esc(t.to) + '</b></div>' : '<p class="err" style="margin:4px 0">' + (t.item ? '没有库位' : '系统认不出这个商品') + '</p>') +
              (t.to ? '<p class="hint lmchk">请到 <b data-nt>' + esc(t.to) + '</b> 现场核实这个商品和批次，确认后再改</p>' : '') +
              '<div class="lmacts"><button class="btn save" data-tk="' + i + '">' + (t.to ? '已核实：改到 ' + esc(t.to) : t.item ? '处理：绑定库位' : '处理：选商品 + 库位') + '</button><button class="tbtn" data-sk="' + i + '">' + (t.to && t.from ? '不对，还在 ' + esc(t.from) : '忽略') + '</button></div></div>';
          }).join('');
        }
        app.innerHTML = head(h || '<div class="empty">没有了 👍</div>');
        bindHead();
        Array.prototype.forEach.call(app.querySelectorAll('[data-l]'), function (b) { b.onclick = function () { location.hash = '#/lm/l/' + encodeURIComponent(b.dataset.l); }; });
        Array.prototype.forEach.call(app.querySelectorAll('[data-i]'), function (b) { b.onclick = function () { location.hash = '#/lm/i/' + encodeURIComponent(b.dataset.i); }; });
        // v1.8.7 箱码不认识：从来源库位的货里点选 / 搜品名 → 记住箱码 + 更新这笔移库的库位
        var resolve = function (t, q, label) {
          confirmBox('箱码 ' + t.bc + ' 是“' + label + '”？确定后系统记住这个箱码，并把库位改到 ' + t.to + '。', '确定', function () {
            api(Object.assign({ action: 'lmSave', act: 'resolve', taskId: t.id }, q), true).then(function (r) { if (r.status !== 'ok') return toast(r.message || '处理不了', 4000); toast('已记住，库位已更新', 2000); draw(); }, fail);
          });
        };
        Array.prototype.forEach.call(app.querySelectorAll('[data-cd]'), function (b) { b.onclick = function () { var k = b.dataset.cd.split(':'), t = L[+k[0]], c = t.cands[+k[1]]; resolve(t, { recId: c.id }, c.desc + (c.base ? '（批次 ' + c.base + '）' : '')); }; });
        Array.prototype.forEach.call(app.querySelectorAll('[data-ts]'), function (b) { b.onclick = function () {
          var t = L[+b.dataset.ts];
          pickItem('', '箱码 ' + t.bc + ' 是哪个商品？选了以后系统记住这个箱码。', function (it) {
            if (!it.isNewName) return resolve(t, { item: it.item }, it.desc || it.item);
            save({ act: 'bind', newName: it.desc, barcode: t.bc, loc: t.to, taskId: t.id }, '已记住新商品，库位 ' + t.to);
          }, null, t.bc || '');
        }; });
        Array.prototype.forEach.call(app.querySelectorAll('.lmtask [data-go]'), function (b) { b.onclick = function () { location.hash = '#/lm/l/' + encodeURIComponent(b.dataset.go); }; });
        Array.prototype.forEach.call(app.querySelectorAll('[data-sk]'), function (b) { b.onclick = function () { var t = L[+b.dataset.sk]; if (t.type === '移库：库位覆盖待确认') return api({ action: 'lmTaskSkip', id: t.id, note: '仓管已处理' }, true).then(function () { toast('已处理', 1500); draw(); }, fail); confirmBox('忽略这条？（' + (t.desc || t.bc) + (t.to ? ' → ' + t.to : '') + '）', '忽略', function () { api({ action: 'lmTaskSkip', id: t.id }, true).then(function () { toast('已忽略', 1500); draw(); }, fail); }); }; });
        Array.prototype.forEach.call(app.querySelectorAll('[data-tk]'), function (b) {
          b.onclick = function () {
            var t = L[+b.dataset.tk];
            if (t.to && !b.dataset.sure) return confirmBox('你已经到 ' + t.to + ' 看过，“' + (t.desc || t.bc) + '”' + (t.base ? '（批次 ' + t.base + '）' : '') + '确实在这里？确定就把库位' + (t.from ? '从 ' + t.from + ' ' : '') + '改到 ' + t.to + '。', '已核实，改库位', function () { b.dataset.sure = '1'; b.click(); });
            var withItem = function (item) { api({ action: 'lmFind', code: item, item: item }, true).then(function (v) {
              // 旧库位上的同一批次（系统里有记录的）→ 改库位；没有 → 绑定新库位
              var cand = [].concat.apply([], v.batches.map(function (x) { return x.locs; })).filter(function (x) { return x.loc === t.from && (!t.base || x.base === t.base); });
              if (cand.length === 1) return save({ act: 'move', id: cand[0].id, loc: t.to, taskId: t.id }, '已改到 ' + t.to);
              if (t.base) { var bb = v.batches.filter(function (x) { return x.base === t.base; }); if (bb.length) return bindFlow(Object.assign({}, v, { batches: [Object.assign({}, bb[0], { qty: Math.max(1, bb[0].qty) })] }), t.to, t.bc, t.id); }
              bindFlow(v, t.to, t.bc, t.id);
            }, fail); };
            if (t.item) return withItem(t.item);
            var q0 = String(t.desc || '').replace(/[0-9.]+\s*(ML|G|KG|L|克|毫升)\b.*$/i, '').slice(0, 8);
            pickItem(q0, (t.bc ? '系统认不出 DO 上的条码 ' + t.bc + '。' : '') + '“' + (t.desc || '') + '”是哪个商品？选了以后系统记住这个条码。', function (it) {
              if (!it.isNewName) return withItem(it.item);
              var go2 = function (c) { save({ act: 'bind', newName: it.desc, barcode: t.bc, loc: c, taskId: t.id }, '已记住新商品，库位 ' + c); };
              if (t.to) go2(t.to); else askLoc('放在哪个库位？', '', go2);
            }, null, t.bc || '');
          };
        });
      }, fail);
    }
    draw();
  }
  var lmLast = null;
  // 焦点不在输入框时，扫描头的按键送到点货扫描框
  document.addEventListener('keydown', function (e) {
    if (!camOpen && /^#\/pk\/[^/]+\/i\/\d+$/.test(location.hash) && kpKey(e)) return;     // v1.5.2 拣货 SKU 页：数字键 / 扫描枪
    var isLm = /^#\/lm(\/|$)/.test(location.hash);
    if ((!isLm && !/^#\/(ld|pk)\/[^/]+(\/i\/\d+)?$/.test(location.hash)) || !$('#modal').hidden || camOpen) return;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { var t = $(isLm ? '#lmIn' : '#ldIn'); if (t) t.focus(); }
  }, true);

  var cam = null, camOpen = false, camState = null;
  var RETAIL_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf', 'code_39'];
  function checkDigitOk(v, fmt) {
    var len = { ean13: 13, ean8: 8, upca: 12 }[fmt];
    if (!len) return true;
    if (!new RegExp('^\\d{' + len + '}$').test(v)) return false;
    var sum = 0;
    for (var i = v.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += +v[i] * w;
    return (10 - sum % 10) % 10 === +v[v.length - 1];
  }
  function stopCamera() {
    var st = camState; camState = null;
    if (st) {
      clearTimeout(st.loopT); clearTimeout(st.tipT);
      if (st.stream) st.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { } });
    }
    if (cam) { var c = cam; cam = null; try { c.stop().catch(function () { }).then(function () { try { c.clear(); } catch (e) { } }); } catch (e) { } }
    var s = $('.scanner'); if (s) s.remove();
    camOpen = false;
  }
  function openCamera(kind, onCode, opts) {
    opts = opts || {};
    var label = opts.label || BC.filter(function (b) { return b[0] === kind; })[0][2];
    var wrap = document.createElement('div');
    wrap.className = 'scanner';
    wrap.innerHTML = '<div class="top"><span>扫描：' + label + '</span><span id="camMsg" class="hint"></span></div>' +
      '<div class="camview"><video id="camVideo" playsinline muted autoplay></video><div class="aim"><i></i></div><div id="reader"></div></div>' +
      '<div class="camtip" id="camTip">把条码横着放进框里，离手机 10–20 厘米，拿稳</div>' +
      '<div class="bottom"><button class="btn ghost" id="camClose">取消</button><button class="btn ghost" id="camTorch" hidden>🔦 手电筒</button><button class="btn ghost" id="camZoom" hidden>🔍 放大</button></div>';
    document.body.appendChild(wrap);
    camOpen = true;
    var st = camState = { done: false, last: '', lastT: 0, torch: false, zoomed: false };
    $('#camClose').onclick = stopCamera;
    function accept(text, fmt) {
      if (st.done || camState !== st) return;
      var v = String(text || '').replace(/[\r\n\t]/g, '').trim();
      if (!v) return;
      var f = String(fmt || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (/^(ean13|ean8|upca|upce)$/.test(f)) { if (!checkDigitOk(v, f)) return; }
      else { var now = Date.now(); if (v !== st.last || now - st.lastT > 1500) { st.last = v; st.lastT = now; return; } }
      st.done = true; beep(); stopCamera(); onCode(v);
    }
    function fail(err) {
      if (camState !== st) return;
      var r = $('.scanner .camview'); if (r) r.innerHTML = '<p style="color:#fff;padding:20px">无法打开摄像头：' + esc(err && (err.message || err.name) || err) +
        '<br><br>请在 Chrome 网站设置里允许本网站使用相机；或改用扫描头 / 手动输入。</p>';
    }
    // 手电筒 / 放大（手机支持才显示）
    function setupControls(getCaps, apply) {
      var caps = {}; try { caps = getCaps() || {}; } catch (e) { }
      if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) apply({ advanced: [{ focusMode: 'continuous' }] }).catch(function () { });
      if (caps.torch) {
        var tb = $('#camTorch'); tb.hidden = false;
        tb.onclick = function () { st.torch = !st.torch; apply({ advanced: [{ torch: st.torch }] }).catch(function () { }); tb.classList.toggle('on', st.torch); };
      }
      if (caps.zoom && caps.zoom.max >= 1.5) {
        var zb = $('#camZoom'), z2 = Math.min(2, caps.zoom.max); zb.hidden = false;
        zb.onclick = function () { st.zoomed = !st.zoomed; apply({ advanced: [{ zoom: st.zoomed ? z2 : (caps.zoom.min || 1) }] }).catch(function () { }); zb.classList.toggle('on', st.zoomed); };
      }
    }
    st.tipT = setTimeout(function () {
      var t = $('#camTip'); if (t && camState === st) t.textContent = '还没扫到？光线暗→开手电筒；条码小→点放大或靠近一点；反光→手机稍微斜一点';
    }, 8000);
    var video = $('#camVideo');
    var hi = { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    function startNative(formats) {
      var det = new BarcodeDetector({ formats: formats });
      navigator.mediaDevices.getUserMedia({ audio: false, video: hi }).then(function (stream) {
        if (camState !== st) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        st.stream = stream; video.srcObject = stream;
        var track = stream.getVideoTracks()[0];
        setupControls(function () { return track.getCapabilities ? track.getCapabilities() : {}; }, function (c) { return track.applyConstraints(c); });
        return video.play();
      }).then(function () {
        (function loop() {
          if (camState !== st) return;
          if (video.readyState < 2) { st.loopT = setTimeout(loop, 80); return; }
          det.detect(video).then(function (rs) {
            (rs || []).forEach(function (r) { accept(r.rawValue, r.format); });
          }).catch(function () { }).then(function () { if (camState === st && !st.done) st.loopT = setTimeout(loop, 40); });
        })();
      }).catch(fail);
    }
    function startZxing() {
      if (!window.Html5Qrcode) { stopCamera(); toast('扫码组件未加载，请联网后刷新一次'); return; }
      wrap.classList.add('zx');
      var F = Html5QrcodeSupportedFormats;
      cam = new Html5Qrcode('reader', {
        verbose: false,
        formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.ITF, F.CODE_39].concat(opts.qr ? [F.QR_CODE] : []),
        experimentalFeatures: { useBarCodeDetectorIfSupported: true }
      });
      var c = cam;
      c.start({ facingMode: 'environment' }, {
        fps: 20, videoConstraints: hi,
        qrbox: function (vw, vh) { return { width: Math.floor(vw * 0.92), height: Math.max(80, Math.floor(Math.min(vh * 0.45, vw * 0.5))) }; }
      }, function (text, res) {
        accept(text, res && res.result && res.result.format && res.result.format.formatName);
      }, function () { }).then(function () {
        if (cam !== c) return;
        setupControls(function () { return c.getRunningTrackCapabilities(); }, function (x) { return c.applyVideoConstraints(x); });
      }).catch(fail);
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { fail('这个浏览器不支持摄像头（请用 Chrome，网址必须是 https）'); return; }
    if ('BarcodeDetector' in window && BarcodeDetector.getSupportedFormats) {
      BarcodeDetector.getSupportedFormats().then(function (all) {
        if (camState !== st) return;
        var f = RETAIL_FORMATS.concat(opts.qr ? ['qr_code'] : []).filter(function (x) { return all.indexOf(x) >= 0; });
        if (f.indexOf('ean_13') >= 0) startNative(f); else startZxing();
      }, startZxing);
    } else startZxing();
  }
  function beep() {
    try { if (navigator.vibrate) navigator.vibrate(80); } catch (e) { }
    try {
      var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      var ctx = beep.ctx || (beep.ctx = new A()); var o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 1800; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.09);
    } catch (e) { }
  }
  // ---------------- Service Worker（离线打开 APP） ----------------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    var hadCtl = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      // v1.6.2 回到 APP 时 / 每 30 分钟检查新版本
      var chk = function () { try { reg.update().catch(function () { }); } catch (e) { } };
      document.addEventListener('visibilitychange', function () { if (!document.hidden) chk(); });
      setInterval(chk, 30 * 60e3);
    }).catch(function () { });
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadCtl) showUpdateBar(); hadCtl = true; });
  }
  /** v1.6.2 有新版本：顶部一条“点这里更新”（不用清浏览器数据，也不会丢资料） */
  function showUpdateBar() {
    if ($('#updBar')) return;
    var b = document.createElement('button'); b.id = 'updBar'; b.className = 'updbar'; b.textContent = '有新版本，点这里更新';
    b.onclick = function () {
      if (leaveGuard && leaveGuard()) return toast('请先确认或清空本次数量，再点更新', 3000);
      b.textContent = '更新中…'; location.reload();
    };
    document.body.appendChild(b);
  }

  renderNet();
  (cfg ? Promise.resolve(null) : CFGK.restore()).then(function (c) {
    if (c && !cfg) { cfg = c; CFGK.save(c); toast('已从本机备份找回设备设置', 2500); }
    route();
  });
  if (outbox.length) flush();
  window.__app = { flush: flush, outbox: function () { return outbox; }, version: VERSION };
})();

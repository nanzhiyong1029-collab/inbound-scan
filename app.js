/* 入库条码采集 + 库位转移 PWA  v1.4.7
 * 页面：#/ 任务列表 → #/job/<JobID> 商品清单 → #/p/<JobID>/<ProductID> 条码采集
 * 原则：只采集原始资料，不做任何核对。先存手机（离线队列），再上传云端。 */
(function () {
  'use strict';
  var VERSION = '1.5.3';
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
        cfg = { u: o.u, d: o.d, r: o.r === 'up' ? 'up' : '' }; LS.set('cfg', cfg); authMsg = '';
        setSession(null); toast(cfg.r === 'up' ? '设置已保存：这台电脑用来上传 DO' : '设置已保存，请登录');
      } else if (o.k) { authMsg = '这是旧版设置链接，已停用。请找办公室在【PDA 设备管理】生成本设备的新链接。'; toast('旧版链接已停用', 3000); }
      else toast('设置链接无效');
    } catch (e) { toast('设置链接无效'); }
    history.replaceState(null, '', location.pathname + '#/');
    return true;
  }
  readSetupLink();

  // ---------------- 网络 ----------------
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
        if (d.error === 'DEVICE') authLost('device', e.message);
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
  var ALL_MODS = [['in', '#/'], ['t', '#/t'], ['ld', '#/ld'], ['pk', '#/pk']];
  function myMods() { return sess && Array.isArray(sess.mods) ? sess.mods : ['in', 't', 'ld', 'pk']; }
  function hashMod(h) { h = h || '#/'; return h === '#/t' ? 't' : /^#\/ld(\/|$)/.test(h) ? 'ld' : /^#\/pk(\/|$)/.test(h) ? 'pk' : 'in'; }
  function modHome() { var m = myMods(); return (ALL_MODS.filter(function (x) { return m.indexOf(x[0]) >= 0; })[0] || [])[1] || ''; }
  function updateMods(mods) {
    if (!sess || !Array.isArray(mods) || mods.join() === myMods().join()) return;
    sess.mods = mods; LS.set('sess', sess);
    if (myMods().indexOf(hashMod(location.hash)) < 0 && !(leaveGuard && leaveGuard())) setTimeout(route, 0);
  }
  /** 后台说设备被撤销 / 登录失效：清掉凭据，回到设置或登录页（未上传的资料保留在本机） */
  function authLost(kind, msg) {
    if (kind === 'device') { cfg = null; LS.del('cfg'); authMsg = msg + '（未上传的资料仍保存在本机）'; }
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
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { }); } catch (e) { }   // v1.5.3 尽量不让浏览器清掉手机里的资料
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
    leaveGuard = null;
    currentRedraw = null;
    app.onclick = null;
    curHash = location.hash;
    if (!cfg) return viewSetup(false);
    if (cfg.r === 'up') return viewUpload();          // 装车点货：办公室上传电脑，不用员工登录
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
      '<button class="btn save" id="sSave" style="width:100%">保存并测试连接</button><p id="sMsg" class="hint"></p></div>';
    $('#sSave').onclick = function () {
      var u = $('#sU').value.trim(), k = $('#sK').value.trim();
      if (!/^https:\/\//.test(u) || !TOKEN_RE.test(k)) { $('#sMsg').textContent = '网址必须以 https:// 开头，设备凭据格式不对'; return; }
      cfg = { u: u, d: k }; LS.set('cfg', cfg); setSession(null); authMsg = '';
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
    var my = myMods(), tabs = [['in', '📦 入库'], ['t', '🔁 库位转移'], ['ld', '🚚 装车点货'], ['pk', '📋 仓库拣货']].filter(function (x) { return my.indexOf(x[0]) >= 0; });
    if (tabs.length < 2) return '';                 // 只有一个模块就不显示切换标签
    return '<div class="mods' + (tabs.length > 3 ? ' m4' : '') + '">' + tabs.map(function (x) { return '<button class="mod' + (active === x[0] ? ' on' : '') + '" data-mod="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
  }
  function bindModTabs() {
    Array.prototype.forEach.call(app.querySelectorAll('[data-mod]'), function (b) {
      b.onclick = function () {
        var to = b.dataset.mod === 't' ? '#/t' : b.dataset.mod === 'ld' ? '#/ld' : b.dataset.mod === 'pk' ? '#/pk' : '#/';
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
    (m.barcodes || []).forEach(function (x) { byB[x[0]] = x; if (!byI[x[1]]) byI[x[1]] = x; });
    var re; try { re = new RegExp(m.locPattern || LOC_DEFAULT); } catch (e) { re = new RegExp(LOC_DEFAULT); }
    return { version: m.version, byBarcode: byB, byItem: byI, locRe: re, count: (m.barcodes || []).length, raw: m };
  }
  function loadMasters() {
    var local = masters ? Promise.resolve(masters) : IDB.get('masters').then(function (m) { if (m) masters = buildMasters(m); return masters; }, function () { return null; });
    return local.then(function () {
      return api({ action: 'masters', version: masters ? masters.version : '' }, true).then(function (d) {
        if (d.same) { if (masters && masters.raw.locPattern !== d.locPattern) { masters.raw.locPattern = d.locPattern; masters = buildMasters(masters.raw); IDB.set('masters', masters.raw).catch(function () { }); } return masters; }
        var m = { version: d.version, barcodes: d.barcodes, locPattern: d.locPattern, at: new Date().toISOString() };
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
    var x = masters.byBarcode[code];
    if (x) return { itemCode: x[1], desc: x[2], match: '箱码' };
    x = masters.byItem[code];
    if (x) return { itemCode: x[1], desc: x[2], match: 'Item Code' };
    return null;
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
    var st = tState || (tState = Object.assign({ src: '', srcSkip: false, bc: '', item: '', desc: '', match: '', dst: '', qty: '', photo: '', edit: '' }, LS.get('tdraft', {})));
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
    var STEPS = [['src', '1. 来源库位', '扫描原来的库位条码'], ['bc', '2. 商品箱码', '扫描箱子上的条码'], ['dst', '3. 目的库位', '扫描新的库位条码'], ['photo', '4. 拍照确认', '拍下货物在新库位的照片']];
    // 提交前检查（v1.3.9）：必须有 商品箱码、目的库位、照片；来源库位选填
    var NEED = { bc: ['商品箱码', '还没扫', '扫描箱子上的条码'], dst: ['目的库位', '还没扫', '扫描新库位（放货的货架）上的库位条码'], photo: ['拍照确认', '还没拍', '拍一张货物放在新库位的照片'] };
    var photoBusy = false, showNeed = false;
    function missing() { return ['bc', 'dst', 'photo'].filter(function (k) { return !st[k]; }); }
    function goFix(k) {
      closeModal();
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
        ['bc', 'dst', 'photo'].map(function (k) {
          if (st[k]) return li('ok', '✓', NEED[k][0], k === 'photo' ? '已拍好' : esc(k === 'bc' ? (st.item ? st.item + ' · ' + st.bc : st.bc) : st[k]));
          return li('bad', '✗', NEED[k][0] + ' · ' + NEED[k][1], NEED[k][2], k);
        }).join('');
      modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic">!</span><div><h3>还不能提交</h3>' +
        '<div class="hint">还差 <b>' + miss.length + '</b> 项，补齐后再点“提交”</div></div></div>' +
        '<ul class="tmiss-list">' + items + '</ul>' +
        '<div class="row"><button class="btn ghost" id="mxOk">知道了</button><button class="btn save" id="mxGo">去补：' + NEED[miss[0]][0] + '</button></div></div>', function (m) {
          $('#mxOk', m).onclick = function () { closeModal(); showNeed = true; draw(); };
          $('#mxGo', m).onclick = function () { goFix(miss[0]); };
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
      for (var i = 1; i < STEPS.length; i++) if (!st[STEPS[i][0]]) return STEPS[i][0];
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
    function saveDraft() { LS.set('tdraft', { src: st.src, srcSkip: !!st.srcSkip, bc: st.bc, item: st.item, desc: st.desc, match: st.match, dst: st.dst, qty: st.qty || '' }); }
    function draw() {
      saveDraft();
      var keepIn = $('#tIn'), keepVal = keepIn ? keepIn.value : '', keepStep = keepIn ? keepIn.getAttribute('data-step') : '';
      var qOld = $('#tQty'), qFocus = !!qOld && document.activeElement === qOld, qVal = qOld ? qOld.value : null;   // 重画时数量框正在输入：保留内容和光标
      var cur = step(), im = prefs.pda ? 'none' : 'text';
      var rows = STEPS.map(function (s) {
        var k = s[0], v = st[k], val;
        if (k === 'bc') val = !v ? '' : st.item ? '<b class="tv">' + esc(st.item) + '</b><div class="td">' + esc(st.desc || '') + '</div><div class="hint">箱码 ' + esc(v) + (st.match === 'Item Code' ? '（按 Item Code 识别）' : '') + '</div>'
          : '<b class="tv loc">' + esc(v) + '</b>';
        else if (k === 'photo') val = v ? '<img class="tphoto" src="' + v + '" alt="照片">' : '';
        else if (k === 'src' && !v && srcOptional() && cur !== 'src') val = '<span class="tp" style="color:var(--mute)">不填（选填）</span>';
        else val = v ? '<b class="tv loc">' + esc(v) + '</b>' : '';
        return '<button class="tstep' + (cur === k ? ' cur' : '') + (showNeed && k !== 'src' && !v ? ' need' : '') + (v ? ' ok' : '') + '" data-edit="' + k + '"><span class="tl">' + s[1] + '</span>' +
          (val || '<span class="tp">' + (cur === k ? '👉 ' + s[2] : '—') + '</span>') + '</button>';
      }).join('');
      var scanning = cur === 'src' || cur === 'bc' || cur === 'dst';
      app.innerHTML = modTabs('t') +
        '<div class="topline"><span>员工：' + esc(operator) + '</span><span class="hint">' + (masters && masters.count ? '商品主档 ' + masters.count + ' 个条码' : '') + '</span></div>' +
        '<div class="card tcard">' + rows +
        '<div class="tqty"><label for="tQty"><span class="tl">数量 <small>（选填：新货入库核对用；托盘转移不用填）</small></span></label>' +
        '<input id="tQty" class="tqtyin" inputmode="decimal" autocomplete="off" maxlength="64" enterkeyhint="done" placeholder="不填" value="' + esc(st.qty || '') + '"></div></div>' +
        (msg.text ? '<div class="tmsg ' + msg.cls + '">' + esc(msg.text) + '</div>' : '') +
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
      Array.prototype.forEach.call(app.querySelectorAll('[data-edit]'), function (b) {
        b.onclick = function () {          // 任何一栏随时可点：先扫哪个都行，点了已填的就是重扫
          var k = b.dataset.edit; if (step() === k) return;
          st.edit = k; msg = { cls: '', text: (st[k] ? '重新' : '') + (k === 'photo' ? '拍照' : '扫描') + '：' + STEPS.filter(function (s) { return s[0] === k; })[0][1] }; draw();
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
        st.bc = code; st.item = it.itemCode; st.desc = it.desc; st.match = it.match;
      } else return;
      beep(); st.edit = ''; msg = { cls: 'good', text: '✓ ' + (k === 'bc' ? (st.item ? st.item + ' ' + (st.desc || '') : st.bc) : normLoc(raw)) };
      draw();
    }
    /** v1.4.6 修改已提交的记录（不能删除）：来源 / 箱码 / 目的 / 数量。还没上传的直接改手机里的；已上传的要联网，后台记录修改前后 */
    function editRecent(r) {
      var pendRec = null;
      IDB.all().catch(function () { return []; }).then(function (all) {
        pendRec = (all || []).filter(function (q) { return q.transferId === r.id && !q.rejected; })[0] || null;
        var cur = pendRec ? { src: pendRec.source, bc: pendRec.barcode, dst: pendRec.dest, qty: pendRec.qty || '' } : { src: r.src || '', bc: r.bc || '', dst: r.dst || '', qty: r.qty === '' || r.qty == null ? '' : String(r.qty) };
        if (!cur.bc && !pendRec) cur.bc = r.bc || r.item || '';
        var f = function (id, label, val, im, ph) { return '<label class="tef"><span>' + label + '</span><input id="' + id + '" inputmode="' + im + '" autocomplete="off" autocapitalize="characters" spellcheck="false" value="' + esc(val) + '" placeholder="' + ph + '"></label>'; };
        modal('<div class="tmiss"><div class="tmiss-h"><span class="tmiss-ic" style="background:#e6eefb;color:#1f3864">✎</span><div><h3>修改这笔移库位</h3><div class="hint">' + esc(r.t || '') + ' · ' + esc(r.status || '') + (pendRec ? ' · 还没上传' : '') + '</div></div></div>' +
          f('teSrc', '来源库位（选填）', cur.src, 'text', '不填') + f('teBc', '商品箱码', cur.bc, 'text', '扫描或输入') + f('teDst', '目的库位', cur.dst, 'text', '扫描或输入') + f('teQty', '数量（选填）', cur.qty, 'decimal', '不填') +
          '<p class="hint">照片不变。修改会记录修改前后，记录不能删除。</p><div id="teMsg" class="err"></div>' +
          '<div class="row"><button class="btn ghost" id="teNo">取消</button><button class="btn save" id="teOk">保存修改</button></div></div>', function (m) {
            var ids = ['teSrc', 'teBc', 'teDst', 'teQty'];
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
              if (e.length) { out.textContent = e.join('；'); errBeep(); return; }
              if (src === cur.src && bc === normCode(cur.bc) && dst === cur.dst && qty === String(cur.qty)) { closeModal(); return; }
              var btn = $('#teOk', m); btn.disabled = true;
              var it = lookupItem(bc) || { itemCode: '', desc: '' };
              var after = function (item, desc, status) {
                r.src = src; r.dst = dst; r.bc = bc; r.item = item || bc; r.desc = item ? desc : ''; r.qty = qty === '' ? '' : Number(qty); if (status) r.status = status; if (!pendRec) r.edits = (r.edits || 0) + 1;
                LS.set('trecent', recent.slice(0, 20)); closeModal(); beep();
                msg = { cls: 'good', text: '✓ 已修改：' + (r.item || bc) + '  ' + (src || '（无来源）') + ' → ' + dst + (qty ? ' · 数量 ' + qty : '') }; draw();
              };
              if (pendRec && tqFlushing) { btn.disabled = false; out.textContent = '这笔正在上传，请等几秒再改'; return; }
              if (pendRec) {          // 还没上传：直接改手机里的这笔，上传时就是新资料
                Object.assign(pendRec, { source: src, barcode: bc, dest: dst, qty: qty, itemCode: it.itemCode, desc: it.desc });
                return IDB.put(pendRec).then(function () { after(it.itemCode, it.desc); }, function (x) { btn.disabled = false; out.textContent = '保存失败：' + x.message; });
              }
              api({ action: 'transferEdit', transfer: { transferId: r.id, source: src, barcode: bc, dest: dst, qty: qty } }, true).then(function (d) {
                if (d.status === 'saved') { after(d.itemCode, d.description, d.recStatus); return refreshRecent(); }
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
      st = tState = { src: keep ? src : '', srcSkip: false, bc: '', item: '', desc: '', match: '', dst: keep ? dst : '', qty: '', photo: '', edit: '' };
      LS.del('tdraft'); showNeed = false;
      msg = { cls: '', text: '' }; draw();
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
      var r = { transferId: uuid(), source: st.src, dest: st.dst, barcode: st.bc, itemCode: st.item, desc: st.desc, photo: st.photo, qty: st.qty || '',
        clientTime: new Date().toISOString(), operator: operator };
      IDB.put(r).then(function () {
        recent.unshift({ id: r.transferId, src: r.source, dst: r.dest, bc: r.barcode, item: r.itemCode || r.barcode, desc: r.itemCode ? r.desc : '', qty: r.qty, t: hhmm(r.clientTime), status: '待上传' });
        LS.set('trecent', recent.slice(0, 20));
        beep(); toast(navigator.onLine === false ? '✓ 已保存到手机，联网后自动上传' : '✓ 已提交');
        busy = false;
        var done = '✓ 已提交：' + (r.itemCode || r.barcode) + '  ' + (r.source || '（无来源）') + ' → ' + r.dest + (r.qty ? ' · 数量 ' + r.qty : '');
        reset(false);
        msg = { cls: 'good', text: done }; draw();
        return refreshTq().then(flushTransfers).then(refreshRecent);
      }, function (e) { busy = false; draw(); infoBox('提交失败', '保存到手机失败（' + e.message + '）。请再点一次“提交”；如果一直这样，请清理手机空间后再试。已扫的资料还在。'); });
    }
    currentRedraw = function () { if (location.hash === '#/t') draw(); };
    draw();
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
  function xlsxRead(buf) {
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
      var sheet = kids(xml(a[0]), 'sheet')[0], rid = sheet && (sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
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
          qty: typeof o.qty === 'number' ? o.qty : Number(cellText(o.qty).replace(/,/g, '')), qtyRaw: cellText(o.qty), uom: cellText(o.uom), fromDoc: cellText(o.fromDoc), batch: cellText(o.batch) });
      }
      return { kind: 'listing', lines: lines, hasUom: has('uom'), hasBatch: has('batch'), extra: extra.filter(function (t) { return !/^(page|date|user id)/i.test(t); }) };
    }
    return null;
  }
  var PRINT_FIELDS = [['seq', /^序号$/], ['batch', /^批次号$/], ['barcode', /^条码$/], ['desc', /^商品名称$/], ['qty', /^数量$/], ['spec', /^规格$/], ['uom', /^单位$/]];
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
    var blocks = [], cur = null, docNo = '';
    for (var rr = 1; rr <= sh.maxRow; rr++) {
      var cs = rowCells(sh, rr), texts = cs.map(function (x) { return cellText(x.v); });
      var dn = texts.join(' ').match(/\b[A-Z]{1,6}DO-\d{4,}\b/); if (dn && rr < hr || dn && !cur) docNo = dn[0];
      if (texts.some(function (t) { return /拣货人签字/.test(t); })) { if (cur) blocks.push(cur); cur = null; docNo = ''; continue; }
      if (rr <= hr + 1) continue;
      var o = assignCols(heads, cs);
      if (!/^\d+\.?$/.test(cellText(o.seq))) continue;
      if (!cur) cur = { doNo: docNo, lines: [] };
      cur.lines.push({ barcode: cellText(o.barcode), desc: cellText(o.desc), qty: Number(cellText(o.qty)), spec: cellText(o.spec), uom: cellText(o.uom), batch: cellText(o.batch) });
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
    var TK = { list: null, err: '', busy: '' };
    function loadTasks() {
      var m = UPM;
      return api({ action: 'ldPortalTasks', mod: m }, true).then(function (d) { if (m !== UPM) return; TK.list = d.tasks || []; TK.err = ''; draw(); },
        function (e) { if (m !== UPM) return; TK.err = e.network ? '网络不可用，任务列表没有更新' : e.message; draw(); });
    }
    setInterval(function () { if (!document.hidden && $('#modal').hidden && !st.busy && !TK.busy) loadTasks(); }, 60000);
    function tasksHtml() {
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
      st.done = null; st.lines = null; st.errors = []; st.warns = []; st.infos = []; st.importId = uuid();
      var arr = Array.prototype.slice.call(list || []);
      if (!arr.length) return draw();
      st.fileName = arr.map(function (f) { return f.name; }).join(' + ');
      draw('读取中…');
      Promise.all(arr.map(function (f) {
        if (/\.xls$/i.test(f.name)) return Promise.reject(new Error(f.name + '：是旧版 .xls，请在 AutoCount 导出为 .xlsx'));
        return f.arrayBuffer().then(xlsxRead).then(function (sh) { return { name: f.name, listing: parseListing(sh), printed: parsePrinted(sh) }; });
      })).then(function (res) {
        var L = res.filter(function (x) { return x.listing; }), P = res.filter(function (x) { return !x.listing && x.printed; });
        res.forEach(function (x) { if (!x.listing && !x.printed) st.errors.push(x.name + '：认不出格式（需要 Delivery Order Detail Listing）'); });
        if (!L.length) st.errors.push('需要 AutoCount 的「Delivery Order Detail Listing」（每行带 DO 号和条码 / Item Code）。只有送货单不能建任务，因为送货单里只有第一张 DO 有单号。');
        if (L.length > 1) st.errors.push('一次只能上传一份 Delivery Order Detail Listing');
        if (st.errors.length) return draw();
        var li = L[0].listing, lines = li.lines;
        if (PKU() && !li.hasBatch) { st.errors.push('仓库拣货需要带「Batch No.」（批次号）列的 Delivery Order Detail Listing——库位是从批次号里读出来的。请在 AutoCount 报表加上 Batch No. 列再导出。'); return draw(); }
        if (li.extra.length) st.infos.push('没用到的列：' + li.extra.join('、'));
        if (P.length) {
          var rep = supplement(lines, P[0].printed);
          st.infos.push('送货单 ' + rep.blocks + ' 段，对上 ' + rep.matched + ' 张 DO（补上单位 / 规格 / 批次号）');
          if (rep.missingDo.length) st.warns.push('这些 DO 在送货单里没找到对应的一段，单位会是空的：' + rep.missingDo.join('、'));
        }
        var noUom = lines.filter(function (l) { return !l.uom; }).length;
        if (noUom) st.warns.push(noUom + ' 行没有单位（UOM）。' + (P.length ? '' : '可以同时选择「送货单」Excel，系统会自动补上单位。'));
        var seen = {};
        lines.forEach(function (l) {
          var e = [];
          if (!l.doNo) e.push('缺 DO 号'); if (!l.itemCode && !l.barcode && !l.desc) e.push('缺条码 / Item Code / 品名');
          if (!(l.qty > 0)) e.push('数量不对（' + (l.qtyRaw || '空') + '）');
          if (e.length) st.errors.push('Excel 第 ' + l.row + ' 行：' + e.join('，'));
          if (!l.barcode && l.itemCode) st.infos.push('Excel 第 ' + l.row + ' 行没有条码（' + l.desc + '），PDA 上可用 Item Code 或搜索');
          if (!l.barcode && !l.itemCode && l.desc) st.warns.push('Excel 第 ' + l.row + ' 行没有条码（' + l.doNo + ' ' + l.desc + ' ×' + l.qty + '），PDA 上只能按品名搜索');
          var k = [l.doNo, l.itemCode, l.barcode, l.qty, l.uom].join('|');
          if (seen[k]) st.warns.push('Excel 第 ' + seen[k] + ' 行和第 ' + l.row + ' 行完全一样（' + l.doNo + ' ' + l.desc + ' ×' + l.qty + '），会相加，请确认不是重复导出');
          else seen[k] = l.row;
        });
        if (!lines.length) st.errors.push('文件里没有商品行');
        if (PKU()) {      // 批次号缺失 / 没有库位 / 格式异常 → 提醒（不挡上传），这些商品在 PDA 上排在最后并标黄
          var noB = [], noL = [];
          lines.forEach(function (l) { var x = pkLoc(l.batch); if (x.flag) (l.batch ? noL : noB).push('第 ' + l.row + ' 行 ' + l.desc + (l.batch ? '（' + l.batch + '：' + x.flag + '）' : '')); });
          if (noB.length) st.warns.push(noB.length + ' 行没有批次号，PDA 上会排在最后（标黄）：' + noB.join('；'));
          if (noL.length) st.warns.push(noL.length + ' 行批次号读不出库位，PDA 上会标黄' + '：' + noL.join('；'));
        }
        st.lines = lines;
        draw();
        loadCarry();
      }, function (e) { st.errors.push(e.message); draw(); });
    }
    function loadCarry() {
      if (PKU()) { st.carry = []; return draw(); }       // 拣货没有“之前未装”
      api({ action: 'ldCarry' }, true).then(function (d) { st.carry = d.items || []; st.carry.forEach(function (c) { if (st.pick[c.ref] === undefined) st.pick[c.ref] = true; }); draw(); },
        function (e) { st.carry = []; st.warns.push('读不到之前未装的商品：' + e.message); draw(); });
    }
    function merged() {
      var m = {}, order = [];
      (st.lines || []).forEach(function (l) {
        var k = ldLineKey(l, PKU());
        if (!m[k]) { m[k] = { code: l.itemCode, desc: l.desc, uom: l.uom, spec: l.spec || '', batch: l.batch || '', bc: [], qty: 0, src: [], i: order.length }; order.push(k); }
        var it = m[k]; it.qty = Math.round((it.qty + l.qty) * 1000) / 1000; it.src.push(l.doNo + '×' + l.qty);
        if (l.barcode && it.bc.indexOf(l.barcode) < 0) it.bc.push(l.barcode);
      });
      var out = order.map(function (k) { return m[k]; });
      if (PKU()) out.forEach(function (it) { var x = pkLoc(it.batch); it.loc = x.loc; it.key = x.key; it.flag = x.flag; });
      if (PKU()) out.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i; });    // 和 PDA 一样的库位顺序
      return out;
    }
    function upload(force) {
      if (st.busy) return;
      st.busy = true; draw();
      var refs = Object.keys(st.pick).filter(function (k) { return st.pick[k] && (st.carry || []).some(function (c) { return c.ref === k; }); });
      api({ action: 'ldImport', mod: UPM, importId: st.importId, fileName: st.fileName, force: !!force, carry: PKU() ? [] : refs,
        lines: st.lines.map(function (l) { return { doNo: l.doNo, doDate: l.doDate, itemCode: l.itemCode, desc: l.desc, barcode: l.barcode, qty: l.qty, uom: l.uom, spec: l.spec || '', batch: l.batch || '', fromDoc: l.fromDoc }; }) }, true)
        .then(function (d) {
          st.busy = false;
          if (d.status === 'created' || d.status === 'duplicate') { st.done = d; beep(); draw(); return loadTasks(); }
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
        h = '<div class="card upok"><div class="upok-ic">✓</div><h2>已建立装车任务 ' + esc(st.done.taskId) + '</h2><p>' +
          (st.done.status === 'duplicate' ? '（这个文件刚才已经上传过，没有重复建立）' : 'DO ' + st.done.doCount + ' 张 · ' + st.done.lineCount + ' 行 · 商品 ' + st.done.itemCount + ' 项' + (st.done.carryCount ? '（含之前未装 ' + st.done.carryCount + ' 项）' : '')) +
          '</p>' + (st.done.badLoc ? '<p class="err">其中 ' + st.done.badLoc + ' 项批次号没有库位 / 格式异常，PDA 上排在最后并标黄。</p>' : '') +
          '<p class="hint">PDA 打开「🚚 装车点货」就能看到这个任务。</p><button class="btn save" id="upNew">上传下一个</button></div>';
      } else {
        h = '<div class="card"><h3 style="margin-top:0">选择 AutoCount 导出的 Excel</h3>' +
          '<ol class="hint upsteps">' + (PKU() ? '<li><b>Delivery Order Detail Listing（带 Batch No. 列）</b>（必需：每行有 DO 号、条码、数量、<b>批次号</b>；批次号结尾就是库位，如 2701-AB-07-J01 → 07-J-01）</li>' : '<li><b>Delivery Order Detail Listing</b>（必需：每行有 DO 号、条码或 Item Code、数量；有没有 Item Code 列都可以）</li>') + '<li><b>送货单</b>（可选：一起选上，自动补上单位 / 规格 / 批次号）</li></ol>' +
          '<button class="btn save upfile" id="upPick">📂 选择 Excel 文件（可多选）</button><input id="upF" class="vh" type="file" accept=".xlsx,.xls" multiple tabindex="-1">' +
          (st.fileName ? '<p class="hint">已选：' + esc(st.fileName) + '</p>' : '') + (note ? '<p>' + esc(note) + '</p>' : '') + '</div>';
        if (st.errors.length) h += '<div class="card upbad"><b>不能上传：</b><ul>' + st.errors.slice(0, 40).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
        if (st.lines && !st.errors.length) {
          h += '<div class="card"><div class="upsum"><div><b>' + Object.keys(dos).length + '</b><span>张 DO</span></div><div><b>' + st.lines.length + '</b><span>行</span></div><div><b>' + items.length + '</b><span>个商品（合并后）</span></div>' +
            (PKU() ? '<div><b>' + items.filter(function (it) { return it.flag; }).length + '</b><span>没有库位</span></div>' : '<div><b>' + (st.carry ? picked.length : '…') + '</b><span>之前未装</span></div>') + '</div>' +
            '<p class="hint">需求合计：' + Object.keys(units).map(function (u) { return units[u] + ' ' + esc(u); }).join(' · ') + '</p>' +
            '<p class="hint">DO：' + esc(Object.keys(dos).join('、')) + '</p></div>';
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
              return '<tr' + (it.flag ? ' class="pkflagrow"' : '') + '><td class="hint">' + (i + 1) + '</td>' + (PKU() ? '<td><b>' + esc(it.loc || '—') + '</b>' + (it.flag ? '<div class="hint">' + esc(it.flag) + '</div>' : '') + '</td><td>' + esc(it.batch) + '</td>' : '') + '<td>' + esc(it.code || '—') + '</td><td>' + esc(it.bc.join(' / ')) + '</td><td>' + esc(it.desc) + '</td><td>' + esc(it.uom) + '</td><td class="hint">' + esc(it.spec) +
                '</td><td class="n"><b>' + it.qty + '</b></td><td class="hint">' + esc(it.src.join('; ')) + '</td></tr>';
            }).join('') + '</tbody></table></div></div>';
          h += tasksHtml();
          h += '<div id="dock" class="dock"><button class="btn save" id="upGo"' + (st.busy || !st.carry ? ' disabled' : '') + '>' + (st.busy ? '上传中…' : '⬆ 上传并建立装车任务') + '</button></div>';
        }
      }
      if (!(st.lines && !st.errors.length && !st.done)) h += tasksHtml();
      app.innerHTML = '<div class="mods upmods">' + [['ld', '🚚 司机装车点货'], ['pk', '📋 仓库拣货']].map(function (x) { return '<button class="mod' + (UPM === x[0] ? ' on' : '') + '" data-um="' + x[0] + '"' + (st.busy ? ' disabled' : '') + '>' + x[1] + '</button>'; }).join('') + '</div>' + upW(h);
      Array.prototype.forEach.call(app.querySelectorAll('[data-um]'), function (b) {
        b.onclick = function () { if (st.busy || b.dataset.um === UPM) return; UPM = b.dataset.um; LS.set('upMod', UPM); st = newSt(); TK = { list: null, err: '', busy: '' }; draw(); loadTasks(); };
      });
      var tr = $('#tkR'); if (tr) tr.onclick = function () { TK.list = TK.list || null; loadTasks(); };
      Array.prototype.forEach.call(app.querySelectorAll('[data-del]'), function (b) {
        b.onclick = function () { var t = (TK.list || []).filter(function (x) { return x.id === b.dataset.del; })[0]; if (t) askDelete(t, false); };
      });
      var f = $('#upF'); if (f) { f.onchange = function () { readFiles(f.files); f.value = ''; }; $('#upPick').onclick = function () { f.click(); }; }
      var n = $('#upNew'); if (n) n.onclick = function () { st = newSt(); draw(); };
      var g = $('#upGo'); if (g) g.onclick = function () { upload(false); };
      Array.prototype.forEach.call(app.querySelectorAll('[data-ref]'), function (c) { c.onchange = function () { st.pick[c.dataset.ref] = c.checked; draw(); }; });
      var ca = $('#cAll'), cn = $('#cNone');
      if (ca) ca.onclick = function () { st.carry.forEach(function (c) { st.pick[c.ref] = true; }); draw(); };
      if (cn) cn.onclick = function () { st.carry.forEach(function (c) { st.pick[c.ref] = false; }); draw(); };
    }
    draw(); loadTasks();
  }

  // ---------- PDA：本机存储 + 离线队列 ----------
  var LDQ = null, ldMem = {}, ldFlushing = null, ldPendN = 0, ldLastErr = '';
  function ldLoadQ() {
    if (LDQ) return Promise.resolve(LDQ);
    return IDB.get('ld:q').then(function (q) { LDQ = LDQ || q || []; ldPendN = LDQ.length; renderNet(); return LDQ; }, function () { LDQ = LDQ || []; return LDQ; });
  }
  function ldSaveQ() { ldPendN = LDQ.length; renderNet(); return IDB.set('ld:q', LDQ); }
  function ldGet(id) { if (ldMem[id]) return Promise.resolve(ldMem[id]); return IDB.get('ld:' + id).then(function (s) { if (s) ldMem[id] = s; return s || null; }, function () { return null; }); }
  function ldPut(s) { ldMem[s.task.id] = s; pkLocalSave(s); return IDB.set('ld:' + s.task.id, s); }
  /** v1.5.3 拣货：手机里已下载的任务摘要（任务列表断网时用，不会变空白） */
  function pkLocalSave(s) {
    var t = s && s.task; if (!t || !/^PK-/i.test(t.id)) return;
    var c = ldCounts(s), cnt = 0; s.items.forEach(function (it) { cnt = r3(cnt + (c[it.key] || 0)); });
    var all = LS.get('pkLocal', {});
    all[t.id] = { id: t.id, date: t.date, doCount: t.doCount, itemCount: s.items.length, required: t.required, counted: cnt,
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
  function ldPending(id) { return (LDQ || []).filter(function (o) { return o.taskId === id; }).length; }
  function ldFlush() {
    if (ldFlushing) return ldFlushing;
    if (!cfg || !sess || cfg.r === 'up') return Promise.resolve();
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
  function ldGone(id) { return ldModOf(id) === 'pk' ? '这个拣货任务已被删除或取消' : LD_GONE; }
  var ldOnGone = null;      // 正在看的任务被删除时，页面要做的事
  /** v1.4.5 任务已被删除：清掉手机上的这个任务和它还没上传的记录（其他任务不受影响） */
  function ldPurge(tid) {
    delete ldMem[tid]; LDQ = (LDQ || []).filter(function (o) { return o.taskId !== tid; });
    ['ldTasks', 'pkTasks'].forEach(function (ck) { var ts = LS.get(ck, null); if (ts) LS.set(ck, ts.filter(function (t) { return t.id !== tid; })); });
    var pl = LS.get('pkLocal', null); if (pl && pl[tid]) { delete pl[tid]; LS.set('pkLocal', pl); }
    return Promise.all([IDB.kdel('ld:' + tid).catch(function () { }), ldSaveQ()]).then(function () { if (ldOnGone) ldOnGone(tid); });
  }
  /** 有修改被退回（别人已经改过 / 任务已删除）→ 重新下载这个任务，手机上显示最新的数量 */
  function ldRefetch(ids) {
    return Promise.all(ids.map(function (tid) {
      return api({ action: 'ldTask', taskId: tid }, true).then(function (d) {
        if (d.error === 'NOTASK') return ldPurge(tid);
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
      app.innerHTML = modTabs(mod) + ldW('<div class="topline"><span>员工：' + esc(operator) + '</span><button class="link" id="lr">刷新</button></div>' +
        (note ? '<p class="hint">' + esc(note) + '</p>' : '') +
        (!list ? '<div class="empty">加载中…</div>' : list.length ? '' : '<div class="empty">' + (mod === 'pk' && offline ? '现在没有网络，手机里也还没有下载过的拣货任务。<br>联网后打开任务一次，之后断网也能继续。' : '没有装车任务。办公室上传 DO 后会出现在这里。') + '</div>') +
        (list || []).map(function (t) {
          var pct = t.required ? Math.min(100, t.counted / t.required * 100) : 0, pend = ldPending(t.id);
          var dl = mod === 'pk' ? (t.local ? '<span class="pkdl">📥 已下载，可离线</span>' : offline ? '<span class="pkdl no">未下载，需联网打开一次</span>' : '') : '';
          return '<button class="card job ldtask' + (mod === 'pk' && offline && !t.local ? ' nodl' : '') + '" data-id="' + esc(t.id) + '"><div class="id">' + esc(t.id) + ' ' + ldBadge(t.status) + dl + '</div>' +
            '<div class="meta"><span>日期</span><b>' + esc(t.date) + '</b><span>DO</span><b>' + t.doCount + ' 张' + (t.carry ? ' + 之前未装 ' + t.carry + ' 项' : '') + '</b>' +
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
    function itemName(it) { return esc(it.desc) + (it.origin === '之前' ? ' <span class="ldold">之前 ' + esc(it.originDate) + '</span>' : ''); }
    /** 拣货：库位 + 批次号（大字） */
    function pkTag(it) { return PK ? '<i class="pkb' + (it.loc ? '' : ' no') + '">' + esc(it.loc || '无库位') + '</i> ' + esc(it.batch || '（没有批次号）') + ' · ' : ''; }
    function itemRow(it) {
      var diff = r3(it._c - it.req);
      if (PK) return '<button class="ldi pki ' + ({ '未点': 's0', '点货中': 's1', '已点齐': 's2', '超出': 's3', '短少': 's4' }[it._st]) + (it.flag ? ' pkflag' : '') + '" data-k="' + esc(it.key) + '">' +
        '<div class="pkloc' + (it.loc ? '' : ' no') + '" data-fl="' + esc(it.loc) + '">' + (it.loc ? esc(it.loc) : '无库位') + '</div>' +
        '<div class="ldi-t"><div class="pkbatch" data-fb="' + esc(it.batch) + '">' + esc(it.batch || '（没有批次号）') + '</div><b>' + itemName(it) + '</b><span>' + esc(ldId(it, '')) + (it.spec ? ' · ' + esc(it.spec) : '') + (it.flag ? '</span><span class="pkwarn">⚠ ' + esc(it.flag) : '') + '</span></div>' +
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
        return (pq.trim() ? '<p class="hint">搜索“' + esc(pq.trim()) + '”：' + list.length + ' 项（所有状态）</p>' : '') +
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
        if (PK) { head = hhmm(t.time); sub = [t.staff || '']; }
        if (t.code && !PK) sub.push('码 ' + t.code);
        if (t.reason) sub.push('原因：' + t.reason);
        st.edits.forEach(function (e) { sub.push('改 ' + e.orig + '→' + e.to + '（' + (e.staff || '') + ' ' + hhmm(e.time) + '）'); });
        if (v) sub.push('已撤销（' + (v.staff || '') + ' ' + hhmm(v.time) + '）');
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
    function kpPad(id) {
      return '<div class="kp" id="' + id + '">' + ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'b'].map(function (k) {
        return '<button type="button" tabindex="-1" data-k="' + k + '"' + (k === 'b' ? ' aria-label="退格"' : '') + '>' + (k === 'b' ? '⌫' : k) + '</button>';
      }).join('') + '</div>';
    }
    function drawItem() {
      var it = s.items[IT];
      if (!it) { location.replace(ldHash(id)); return; }
      var ro = done(), rem = r3(it.req - it._c), d = r3(it._c - it.req), nx = pkNext(IT), H = histRows(it, ro);
      if (ent && ent.key === it.key && ent.method === 'BARCODE' && !ent.shown && !msg) { ent.shown = true; msg = { cls: 'good', text: '✓ 扫码识别：' + it.desc + '，请输入本次数量' }; }
      setBar((it.loc || '无库位') + ' · 第 ' + (IT + 1) + ' / ' + s.items.length + ' 项', true);
      app.innerHTML = ldW('<div class="pks">' +
        (ro ? '<div class="card lddone">✓ 任务已完成，不能再修改。需要更正请找办公室重新打开。</div>' :
          '<div class="pks-scan"><input id="ldIn" inputmode="none" maxlength="64" autocomplete="off" spellcheck="false" placeholder="扫码 / 搜索商品"><button class="btn cam" id="ldCam" aria-label="摄像头扫码">📷</button></div>') +
        '<div class="pks-it' + (it.flag ? ' pkflag' : '') + '"><div class="pks-top"><div class="pkloc big' + (it.loc ? '' : ' no') + '">' + (it.loc ? esc(it.loc) : '无库位') + '</div>' +
        '<div class="pkit-b"><span>批次号</span><b>' + esc(it.batch || '（没有批次号）') + '</b></div></div>' +
        '<div class="pks-desc">' + itemName(it) + '</div>' +
        '<div class="pks-code">' + esc(ldId(it, '条码 ')) + ' · ' + esc(it.uom || '') + (it.flag ? ' · <span class="pkwarn">⚠ ' + esc(it.flag) + '</span>' : '') + '</div></div>' +
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
        (!ro && rem > 0 && !it._so ? '<button type="button" class="tbtn pkshort" id="pkShort">找不到更多？确认拣完（短少 ' + rem + '）</button>' : '') +
        '</div>');
      bindHist(it);
      $('#pkBack').onclick = function () { pkLeave(function () { location.hash = ldHash(id); }); };
      var nb = $('#pkNext'); if (nb) nb.onclick = function () { pkLeave(function () { openIt(nx, 'SEARCH', ''); }); };
      var rb = $('#pkRev'); if (rb) rb.onclick = function () { pkLeave(function () { location.hash = ldHash(id) + '/review'; }); };
      var sh = $('#pkShort'); if (sh) sh.onclick = function () {
        pkLeave(function () {
          confirmBox('确认“' + it.desc + '”拣完了？已拣 ' + it._c + ' / 应拣 ' + it.req + '，短少 ' + rem + '。之后还可以继续加数量，或取消确认。', '确认拣完', function () {
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
        $('#ldCam').onclick = function () { openCamera('ld', function (code) { pkItemScan(code); }, { label: '商品条码' }); };
      }
    }
    function pkSave() {
      var it = s.items[IT]; if (!it || done()) return false;
      var raw = kpv, v = Number(raw), FB = $('#pkFb');
      if (!(v > 0) || v > 100000) { if (FB) { FB.className = 'pks-fb err'; FB.textContent = raw ? '数量不对，请重新输入' : '请先输入本次数量'; } errBeep(); return false; }
      kpv = '';
      var m = ent && ent.key === it.key ? ent : { method: 'SEARCH', code: '' };
      add(it, v, m.method, m.code);
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
      modal('<div class="ldq"><div class="ldq-h">修改这一笔</div><div class="hint">' + esc(it.desc) + ' · ' + hhmm(t.time) + ' · 原来 ' + cur + '</div>' +
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
      if (exact.indexOf(it) >= 0) {
        beep(); ent = { key: it.key, method: 'BARCODE', code: raw };
        msg = { cls: 'good', text: '✓ 条码正确（就是这个商品）' + (exact.length > 1 ? '，这个条码还有其它批次' : '') + '，请输入本次数量' }; ent.shown = true; draw(); return;
      }
      if (exact.length) return pkLeave(function () { if (exact.length === 1) openIt(exact[0], 'BARCODE', raw); else pick(exact, '这个条码对应 ' + exact.length + ' 行（不同批次），请选择', '', raw); });
      if (/^\d{8,}$/.test(q)) return handle(raw, 'BARCODE');
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
        (ok.length ? '<details class="card"><summary><b>已点齐 ' + ok.length + ' 项</b></summary><table class="ldrt"><tbody>' + ok.map(tr).join('') + '</tbody></table></details>' : '') +
        (done() ? '' : PK ? '<p class="hint">提交的是实际点到的数量，不需要改成和 DO 一样。没点够的会记为<b>短少</b>。</p>' : '<p class="hint">提交的是实际点到的数量，不需要改成和 DO 一样。没点够的会记为<b>未装</b>，下次上传 DO 时可以带进新任务（会注明今天的日期）。</p>') +
        '<div id="dock" class="dock"><button class="btn ghost" id="ldBack" style="flex:0 0 36%">‹ 继续点货</button>' +
        (done() ? '' : '<button class="btn save" id="ldSubmit">✓ 确认完成点货</button>') + '</div>');
      $('#ldBack').onclick = function () { location.hash = ldHash(id); };
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
        res = s.items.filter(function (it) { return (it.desc + ' ' + it.code + ' ' + it.bc + ' ' + it.spec + ' ' + (it.batch || '') + ' ' + (it.loc || '') + ' ' + String(it.loc || '').replace(/-/g, '')).toLowerCase().indexOf(low) >= 0; });
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
        '<label class="ldq-l">这次点了多少 <b>' + esc(it.uom || '') + '</b>？</label><input id="ldQn" class="ldq-in" inputmode="decimal" autocomplete="off" maxlength="9">' +
        '<div id="ldQm" class="ldq-m"></div><div class="row"><button class="btn ghost" id="ldQc">取消</button><button class="btn save" id="ldQo">＋ 确认累加</button></div></div>', function (m) {
          var inp = $('#ldQn', m), out = $('#ldQm', m);
          inp.oninput = function () {
            var v = Number(inp.value);
            out.className = 'ldq-m';
            out.textContent = inp.value && v > 0 ? '累加后：' + r3(it._c + v) + ' / ' + it.req + (r3(it._c + v) > it.req ? '（超出 ' + r3(it._c + v - it.req) + '）' : '') : '';
          };
          var ok = function () {
            var raw = inp.value.trim(), v = Number(raw);
            if (/^\d{7,}$/.test(raw)) { out.className = 'ldq-m err'; out.textContent = '数量太大——是不是扫到了条码？请输入数量'; inp.value = ''; errBeep(); return; }
            if (!(v > 0) || v > 100000) { out.className = 'ldq-m err'; out.textContent = '请输入点到的数量（大于 0）'; errBeep(); inp.focus(); return; }
            closeModal(); add(it, v, method, code);
          };
          inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
          $('#ldQo', m).onclick = ok; $('#ldQc', m).onclick = function () { closeModal(); draw(); };
          setTimeout(function () { inp.focus(); }, 50);
        });
    }
    function add(it, v, method, code) {
      var tid = uuid(), now = new Date().toISOString();
      s.txns[tid] = { id: tid, key: it.key, qty: v, method: method, staff: operator, time: now, rev: '', code: code || '', synced: false };
      LDQ.push({ op: 'txn', taskId: id, txn: { txnId: tid, taskId: id, key: it.key, qty: v, method: method, code: code || '', clientTime: now } });
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
      LDQ.push({ op: 'txn', taskId: id, txn: { txnId: tid, taskId: id, key: it.key, qty: delta, method: method, reverses: rec.rev, orig: rec.orig, to: rec.to, reason: rec.reason, clientTime: now } });
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
        '<div class="ldq-l"><b>点货记录</b>（' + list.length + ' 笔）' + (ro ? '' : '<span class="hint"> 点错了可以修改或撤销，原记录会保留</span>') + '</div>' +
        '<div class="pkl" id="dtL">' + (rows.join('') || '<div class="empty">还没有点货记录</div>') + '</div>' +
        (ro ? '<p class="hint">任务已完成，不能修改。需要更正请找办公室重新打开。</p><div class="row"><button class="btn ghost" id="dtX">关闭</button></div>' :
          '<div class="row"><button class="btn ghost" id="dtX">关闭</button><button class="btn ghost" id="dtA">调整数量</button><button class="btn save" id="dtP">＋ 再点</button></div>') + '</div>', function (m) {
          $('#dtX', m).onclick = function () { dKey = null; closeModal(); draw(); };
          if (ro) return;
          $('#dtP', m).onclick = function () { qty(it, 'SEARCH', ''); };
          $('#dtA', m).onclick = function () { adjust(it); };
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
      var list = Object.keys(s.txns).map(function (k) { return s.txns[k]; }).sort(function (a, b) { return byTime(b, a); });
      var voided = {}; list.forEach(function (t) { if (t.method === 'VOID' || t.method === 'REVERSAL') voided[t.rev] = 1; });
      var name = function (k) { var it = byKey(k); return it ? it.desc + (it.uom ? '（' + it.uom + '）' : '') : k; };
      modal('<h3 style="margin-top:0">点货记录（' + list.length + ' 笔）</h3><p class="hint" style="margin-top:-6px">点一行可以修改 / 撤销。修改、撤销、调整都会另记一笔，原记录保留。</p><div class="pkl">' + (list.length ? list.map(function (t) {
        var d = t.method === 'EDIT' ? '把 ' + t.orig + ' 改成 ' + t.to : t.method === 'ADJUST' ? '累计 ' + t.orig + ' → ' + t.to : '';
        return '<div class="ldh ldhc' + (voided[t.id] ? ' gone' : '') + '" data-hk="' + esc(t.key) + '"><span class="t"><b>' + esc(name(t.key)) + '</b><span>' + esc(hhmm(t.time)) + ' · ' + esc(t.staff || '') + ' · ' +
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
        if (d.error === 'NOTASK') return ldPurge(id);        // 任务已被删除 → 清掉本机资料和待上传
        if (d.error) { if (!s) { msg = { cls: 'bad', text: d.message }; draw(); } return; }
        return ldGet(id).then(function (cur) { s = ldFromServer(d, cur); return ldPut(s); }).then(function () { if ($('#modal').hidden) draw(); ldFlush(); });
      }, function (e) {
        if (!s) { msg = { cls: 'bad', text: e.network ? '离线：这个任务还没下载到手机。第一次打开需要联网。' : e.message }; draw(); }
      });
    });
    draw();
  }
  // 焦点不在输入框时，扫描头的按键送到点货扫描框
  document.addEventListener('keydown', function (e) {
    if (!camOpen && /^#\/pk\/[^/]+\/i\/\d+$/.test(location.hash) && kpKey(e)) return;     // v1.5.2 拣货 SKU 页：数字键 / 扫描枪
    if (!/^#\/(ld|pk)\/[^/]+(\/i\/\d+)?$/.test(location.hash) || !$('#modal').hidden || camOpen) return;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { var t = $('#ldIn'); if (t) t.focus(); }
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
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }

  renderNet();
  route();
  if (outbox.length) flush();
  window.__app = { flush: flush, outbox: function () { return outbox; }, version: VERSION };
})();

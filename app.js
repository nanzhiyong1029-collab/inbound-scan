/* 入库条码采集 + 库位转移 PWA  v1.3.6
 * 页面：#/ 任务列表 → #/job/<JobID> 商品清单 → #/p/<JobID>/<ProductID> 条码采集
 * 原则：只采集原始资料，不做任何核对。先存手机（离线队列），再上传云端。 */
(function () {
  'use strict';
  var VERSION = '1.3.6';
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
        cfg = { u: o.u, d: o.d }; LS.set('cfg', cfg); authMsg = '';
        setSession(null); toast('设置已保存，请登录');
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
        if (d.error === 'DEVICE') authLost('device', e.message);
        else if (d.error === 'SESSION') authLost('session', e.message);
        throw e;
      }
      return d;
    }, function (err) {
      clearTimeout(timer);
      setOnline(false);
      var e = new Error('网络不可用'); e.network = true; throw e;
    });
  }

  function setSession(s) { sess = s; operator = s ? s.name : ''; if (s) LS.set('sess', s); else LS.del('sess'); }
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
    var pend = outbox.length + (typeof tqCount === 'number' ? tqCount : 0);
    if (!n) return;
    n.className = !online ? 'off' : (pend ? 'sync' : '');
    t.textContent = (!online ? '离线' : '在线') + (pend ? ' · 待上传 ' + pend : '');
  }
  window.addEventListener('online', function () { setOnline(true); flush(); flushTransfers(); });
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
  setInterval(function () { if (outbox.length && sess) flush(); if (tqCount && sess) flushTransfers(); }, 15000);
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
      '<button id="mSync">立即上传（待上传 ' + (outbox.length + tqCount) + '）</button>' +
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
        $('#mSync', m).onclick = function () { closeModal(); toast('上传中…'); flushTransfers(); flush().then(function () { toast(outbox.length ? '还有 ' + outbox.length + ' 条未上传（网络不可用）' : '全部已上传 ✓'); }); };
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
    leaveGuard = null;
    currentRedraw = null;
    app.onclick = null;
    curHash = location.hash;
    if (!cfg) return viewSetup(false);
    if (!sess) return viewLogin();
    var h = location.hash || '#/';
    var m;
    if ((m = h.match(/^#\/job\/([^/]+)$/))) return viewProducts(decodeURIComponent(m[1]));
    if ((m = h.match(/^#\/p\/([^/]+)\/([^/]+)$/))) return viewCollect(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if (h === '#/t') return viewTransfer();
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
          authMsg = ''; setSession({ t: d.session, name: d.name, dev: d.device });
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
          '<span class="tools"><button class="tbtn" data-kbd="' + b[0] + '">⌨ 手输</button><button class="tbtn" data-clr="' + b[0] + '">✕ 清除</button></span></label>' +
          '<div class="bcrow"><input id="f_' + b[0] + '" data-k="' + b[0] + '" inputmode="' + im + '" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" value="' + esc(orig[b[0]]) + '" placeholder="扫描或输入">' +
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
      if (t.dataset.kbd) { var f = F[t.dataset.kbd]; f.setAttribute('inputmode', 'text'); f.blur(); setTimeout(function () { f.focus(); }, 30); }
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
    return '<div class="mods"><button class="mod' + (active === 'in' ? ' on' : '') + '" data-mod="in">📦 入库</button>' +
      '<button class="mod' + (active === 't' ? ' on' : '') + '" data-mod="t">🔁 库位转移</button></div>';
  }
  function bindModTabs() {
    Array.prototype.forEach.call(app.querySelectorAll('[data-mod]'), function (b) {
      b.onclick = function () {
        var to = b.dataset.mod === 't' ? '#/t' : '#/';
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
      del: function (id) { return tx('tq', 'readwrite', function (s) { return s.delete(id); }); }
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
  var tqCount = 0, tqFlushing = null, tqRejected = [];
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
    if (tqFlushing) return tqFlushing;
    if (!cfg || !sess) return Promise.resolve();
    tqFlushing = refreshTq().then(function (list) {
      var mine = list.filter(function (r) { return !r.rejected && r.operator === operator; })
        .sort(function (a, b) { return String(a.clientTime).localeCompare(String(b.clientTime)); });
      var done = 0;
      function next(i) {
        if (i >= mine.length) return Promise.resolve();
        var r = mine[i];
        var body = { transferId: r.transferId, source: r.source, dest: r.dest, barcode: r.barcode, photo: r.photo, clientTime: r.clientTime };
        return api({ action: 'transfer', transfer: body }, true).then(function (d) {
          if (d.status === 'saved' || d.status === 'duplicate') { done++; return IDB.del(r.transferId); }
          r.rejected = d.message || '被服务器退回'; toast('有一笔库位转移被退回：' + r.rejected, 4000);
          return IDB.put(r);
        }).then(function () { return next(i + 1); });
      }
      return next(0).then(function () { return done; });
    }).then(function (n) { tqFlushing = null; refreshTq().then(function () { if (currentRedraw) currentRedraw(); if (n && refreshRecentNow && location.hash === '#/t') refreshRecentNow(); }); return n; },
      function (e) { tqFlushing = null; lastSyncError = e.message; refreshTq(); });
    return tqFlushing;
  }
  refreshTq();

  // —— 照片压缩：长边 1600 像素、JPEG，一般 200–400 KB
  function compressPhoto(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, 1600 / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var q = 0.72, d = c.toDataURL('image/jpeg', q);
        while (d.length > 700000 && q > 0.35) { q -= 0.12; d = c.toDataURL('image/jpeg', q); }
        res(d);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('照片读取失败，请重拍')); };
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
    var st = tState || (tState = { src: '', bc: '', item: '', desc: '', match: '', dst: '', photo: '', edit: '' });
    var msg = { cls: '', text: '' }, recent = LS.get('trecent', []).filter(function (r) { return r.id; }), busy = false;
    var TST = { '待上传': 't0', '待处理': 't1', '有问题': 't2', '已完成': 't3' };
    // 最近提交以后台为准：办公室删除的记录在这里也消失，状态（已完成 / 有问题）同步；还没上传的留在最上面
    function refreshRecent() {
      if (!cfg || !sess) return Promise.resolve();
      return Promise.all([api({ action: 'transfers' }, true), IDB.all().catch(function () { return []; })]).then(function (x) {
        var server = (x[0] && x[0].list) || [], pend = {};
        (x[1] || []).forEach(function (q) { if (!q.rejected) pend[q.transferId] = 1; });
        var local = recent.filter(function (r) { return pend[r.id]; });
        recent = local.concat(server.filter(function (r) { return !pend[r.id]; })).slice(0, 10);
        LS.set('trecent', recent);
        if (location.hash === '#/t') draw();
      }, function () { /* 离线：继续显示上次的列表 */ });
    }
    refreshRecentNow = refreshRecent;
    var STEPS = [['src', '1. 来源库位', '扫描原来的库位条码'], ['bc', '2. 商品箱码', '扫描箱子上的条码'], ['dst', '3. 目的库位', '扫描新的库位条码'], ['photo', '4. 拍照确认', '拍下货物在新库位的照片']];
    function step() { if (st.edit) return st.edit; for (var i = 0; i < STEPS.length; i++) if (!st[STEPS[i][0]]) return STEPS[i][0]; return 'submit'; }
    // 这一笔的资料在切换页面时会保留（tState），所以不需要“未保存离开”提示
    function draw() {
      var cur = step(), im = prefs.pda ? 'none' : 'text';
      var rows = STEPS.map(function (s) {
        var k = s[0], v = st[k], val;
        if (k === 'bc') val = !v ? '' : st.item ? '<b class="tv">' + esc(st.item) + '</b><div class="td">' + esc(st.desc || '') + '</div><div class="hint">箱码 ' + esc(v) + (st.match === 'Item Code' ? '（按 Item Code 识别）' : '') + '</div>'
          : '<b class="tv loc">' + esc(v) + '</b>';
        else if (k === 'photo') val = v ? '<img class="tphoto" src="' + v + '" alt="照片">' : '';
        else val = v ? '<b class="tv loc">' + esc(v) + '</b>' : '';
        return '<button class="tstep' + (cur === k ? ' cur' : '') + (v ? ' ok' : '') + '" data-edit="' + k + '"><span class="tl">' + s[1] + '</span>' +
          (val || '<span class="tp">' + (cur === k ? '👉 ' + s[2] : '—') + '</span>') + '</button>';
      }).join('');
      var scanning = cur === 'src' || cur === 'bc' || cur === 'dst';
      app.innerHTML = modTabs('t') +
        '<div class="topline"><span>员工：' + esc(operator) + '</span><span class="hint">' + (masters && masters.count ? '商品主档 ' + masters.count + ' 个条码' : '') + '</span></div>' +
        '<div class="card tcard">' + rows + '</div>' +
        (msg.text ? '<div class="tmsg ' + msg.cls + '">' + esc(msg.text) + '</div>' : '') +
        (scanning ? '<div class="bcrow tscan"><input id="tIn" inputmode="' + im + '" maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="' +
          esc(STEPS.filter(function (s) { return s[0] === cur; })[0][2]) + '"><button class="btn cam" id="tCam">📷 扫描</button></div>' +
          '<div class="row tsub"><button class="tbtn" id="tKbd">⌨ 手输</button>' + (st.edit ? '<button class="tbtn" id="tCancelEdit">取消修改</button>' : '') + '</div>' : '') +
        (cur === 'photo' ? '<label class="btn save tphotobtn">📸 拍照<input id="tPhoto" type="file" accept="image/*" capture="environment" hidden></label>' : '') +
        (tqCount ? '<p class="hint">待上传 ' + tqCount + ' 笔（联网后自动上传）</p>' : '') +
        (tqRejected.length ? '<div class="card"><b class="err">被退回 ' + tqRejected.length + ' 笔（请检查后删除）</b>' + tqRejected.map(function (r) {
          return '<div class="trow"><div>' + esc(r.source) + ' → ' + esc(r.dest) + ' · ' + esc(r.itemCode || r.barcode) + '<div class="err hint">' + esc(r.rejected) + '</div></div><button class="tbtn" data-tdel="' + esc(r.transferId) + '">删除</button></div>';
        }).join('') + '</div>' : '') +
        (recent.length ? '<div class="card"><b>最近提交</b>' + recent.slice(0, 10).map(function (r) {
          return '<div class="trow" data-rid="' + esc(r.id || '') + '"><div>' + esc(r.src) + ' → ' + esc(r.dst) + ' · <b>' + esc(r.item || r.bc || '') + '</b> ' + esc(r.desc || '') + '</div>' +
            '<span class="hint">' + (r.status ? '<span class="tst ' + (TST[r.status] || '') + '">' + esc(r.status) + '</span> ' : '') + esc(r.t) + '</span></div>';
        }).join('') + '</div>' : '') +
        '<div id="dock" class="dock"><button class="btn ghost" id="tReset" style="flex:0 0 32%">重新开始</button><button class="btn save" id="tSubmit"' + (cur === 'submit' && !busy ? '' : ' disabled') + '>提交</button></div>';
      bindModTabs();
      var inp = $('#tIn');
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
        setTimeout(function () { var x = $('#tIn'); if (x) x.focus(); }, 30);
        $('#tCam').onclick = function () {
          var k = step();
          openCamera(k, function (code) { accept(code); }, { label: STEPS.filter(function (s) { return s[0] === k; })[0][1], qr: k !== 'bc' });
        };
        $('#tKbd').onclick = function () { inp.setAttribute('inputmode', 'text'); inp.blur(); setTimeout(function () { inp.focus(); }, 30); };
        var ce = $('#tCancelEdit'); if (ce) ce.onclick = function () { st.edit = ''; msg = { cls: '', text: '' }; draw(); };
      }
      var ph = $('#tPhoto');
      if (ph) ph.onchange = function () {
        var f = ph.files && ph.files[0]; if (!f) return;
        msg = { cls: '', text: '处理照片中…' }; draw();
        compressPhoto(f).then(function (d) { st.photo = d; st.edit = ''; msg = { cls: 'good', text: '照片已拍好，确认无误后点“提交”' }; draw(); },
          function (e) { msg = { cls: 'bad', text: e.message }; errBeep(); draw(); });
      };
      $('#tReset').onclick = function () { confirmBox('清空这一笔，重新开始？', '重新开始', function () { reset(false); }); };
      $('#tSubmit').onclick = submit;
      Array.prototype.forEach.call(app.querySelectorAll('[data-edit]'), function (b) {
        b.onclick = function () {          // 任何一栏随时可点：先扫哪个都行，点了已填的就是重扫
          var k = b.dataset.edit; if (step() === k) return;
          st.edit = k; msg = { cls: '', text: (st[k] ? '重新' : '') + (k === 'photo' ? '拍照' : '扫描') + '：' + STEPS.filter(function (s) { return s[0] === k; })[0][1] }; draw();
        };
      });
      Array.prototype.forEach.call(app.querySelectorAll('[data-tdel]'), function (b) {
        b.onclick = function () { confirmBox('删除这笔被退回的记录？', '删除', function () { IDB.del(b.dataset.tdel).then(refreshTq).then(draw); }); };
      });
    }
    function fail(text) { msg = { cls: 'bad', text: text }; errBeep(); draw(); }
    function accept(raw) {
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
    function reset(keep) {
      var src = st.src, dst = st.dst;
      st = tState = { src: keep ? src : '', bc: '', item: '', desc: '', match: '', dst: keep ? dst : '', photo: '', edit: '' };
      msg = { cls: '', text: '' }; draw();
    }
    function submit() {
      if (busy || step() !== 'submit') return;
      busy = true;
      var r = { transferId: uuid(), source: st.src, dest: st.dst, barcode: st.bc, itemCode: st.item, desc: st.desc, photo: st.photo,
        clientTime: new Date().toISOString(), operator: operator };
      IDB.put(r).then(function () {
        recent.unshift({ id: r.transferId, src: r.source, dst: r.dest, item: r.itemCode || r.barcode, desc: r.itemCode ? r.desc : '', t: hhmm(r.clientTime), status: '待上传' });
        recent = recent.slice(0, 10); LS.set('trecent', recent);
        beep(); toast('✓ 已提交');
        busy = false;
        var done = '✓ 已提交：' + (r.itemCode || r.barcode) + '  ' + r.source + ' → ' + r.dest;
        reset(false);
        msg = { cls: 'good', text: done }; draw();
        return refreshTq().then(flushTransfers).then(refreshRecent);
      }, function (e) { busy = false; fail('保存到手机失败：' + e.message); });
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
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }

  renderNet();
  route();
  if (outbox.length) flush();
  window.__app = { flush: flush, outbox: function () { return outbox; }, version: VERSION };
})();

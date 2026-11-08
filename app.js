/* 入库条码采集 PWA  v1.0.0
 * 页面：#/ 任务列表 → #/job/<JobID> 商品清单 → #/p/<JobID>/<ProductID> 条码采集
 * 原则：只采集原始资料，不做任何核对。先存手机（离线队列），再上传云端。 */
(function () {
  'use strict';
  var VERSION = '1.1.2';
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var app = $('#app');

  // ---------------- 本地存储（全部 try/catch） ----------------
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { } }
  };
  var cfg = LS.get('cfg', null);               // {u: WebApp URL, k: key}
  var operator = LS.get('operator', '');
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
      if (o.u && o.k) { cfg = { u: o.u, k: o.k }; LS.set('cfg', cfg); toast('设置已保存'); }
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
    var body = Object.assign({}, params, { key: cfg.k });
    var req;
    if (post) {
      req = fetch(cfg.u, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl && ctl.signal });
    } else {
      var q = Object.keys(body).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(body[k]); }).join('&');
      req = fetch(cfg.u + (cfg.u.indexOf('?') >= 0 ? '&' : '?') + q, { redirect: 'follow', signal: ctl && ctl.signal });
    }
    return req.then(function (r) { return r.json(); }).then(function (d) {
      clearTimeout(timer);
      setOnline(true);
      if (!d.ok) { var e = new Error(d.message || d.error || '服务器错误'); e.server = true; e.code = d.error; throw e; }
      return d;
    }, function (err) {
      clearTimeout(timer);
      setOnline(false);
      var e = new Error('网络不可用'); e.network = true; throw e;
    });
  }

  var online = navigator.onLine !== false;
  function setOnline(v) { online = v; renderNet(); }
  function renderNet() {
    var n = $('#net'), t = $('#netText');
    var pend = outbox.length;
    n.className = !online ? 'off' : (pend ? 'sync' : '');
    t.textContent = (!online ? '离线' : '在线') + (pend ? ' · 待上传 ' + pend : '');
  }
  window.addEventListener('online', function () { setOnline(true); flush(); });
  window.addEventListener('offline', function () { setOnline(false); });

  // ---------------- 离线队列：上传 ----------------
  var flushing = null;
  function flush() {
    if (flushing) return flushing;
    if (!outbox.length || !cfg) { renderNet(); return Promise.resolve(); }
    var batch = outbox.slice(0, 40);
    flushing = api({ action: 'saveBatch', saves: batch }, true).then(function (d) {
      var done = {};
      (d.results || []).forEach(function (r) {
        if (r.status === 'saved' || r.status === 'duplicate' || r.status === 'stale' || r.status === 'error') done[r.saveId] = r;
        if (r.status === 'error') {
          var failed = LS.get('failed', []); failed.push({ r: r, at: new Date().toISOString() }); LS.set('failed', failed.slice(-200));
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
      if (outbox.length) return flush();
    }, function (e) {
      lastSyncError = e.message;
      flushing = null;
      renderNet();
    });
    return flushing;
  }
  setInterval(function () { if (outbox.length) flush(); }, 15000);
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
      '<div class="hint">员工：<b>' + esc(operator || '未登录') + '</b> · 设备 ' + esc(device) + ' · v' + VERSION + '</div>' +
      '<button id="mSync">立即上传（待上传 ' + outbox.length + '）</button>' +
      '<button id="mOp">切换员工</button>' +
      '<button id="mPda">PDA 扫描头模式：' + (prefs.pda ? '开（不弹出键盘）' : '关（手机键盘输入）') + '</button>' +
      '<button id="mNext">扫完箱码后自动跳到 SAVE：' + (prefs.autoNext ? '开' : '关') + '</button>' +
      '<button id="mTest">扫描头测试</button>' +
      '<button id="mCfg">服务器设置</button>' +
      '<button id="mClear">清除商品缓存（不会删除待上传资料）</button>' +
      (lastSyncError ? '<div class="err hint">上次上传失败：' + esc(lastSyncError) + '</div>' : '') +
      '</div>', function (m) {
        $('#mSync', m).onclick = function () { closeModal(); toast('上传中…'); flush().then(function () { toast(outbox.length ? '还有 ' + outbox.length + ' 条未上传（网络不可用）' : '全部已上传 ✓'); }); };
        $('#mOp', m).onclick = function () { closeModal(); guardLeave(function () { operator = ''; LS.set('operator', ''); route(); }); };
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
    if (!operator) return viewLogin();
    var h = location.hash || '#/';
    var m;
    if ((m = h.match(/^#\/job\/([^/]+)$/))) return viewProducts(decodeURIComponent(m[1]));
    if ((m = h.match(/^#\/p\/([^/]+)\/([^/]+)$/))) return viewCollect(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    return viewJobs();
  }

  // ---------------- 设置 & 登录 ----------------
  function viewSetup(editing) {
    setBar('服务器设置', editing);
    app.innerHTML = '<div class="card"><p>请用办公室发来的<b>设置链接</b>打开本页面（会自动完成设置）。也可以手动填写：</p>' +
      '<div class="field"><label>服务器网址 (Web App URL)</label><input id="sU" value="' + esc(cfg ? cfg.u : '') + '"></div>' +
      '<div class="field"><label>访问密钥</label><input id="sK" value="' + esc(cfg ? cfg.k : '') + '"></div>' +
      '<button class="btn save" id="sSave" style="width:100%">保存并测试连接</button><p id="sMsg" class="hint"></p></div>';
    $('#sSave').onclick = function () {
      var u = $('#sU').value.trim(), k = $('#sK').value.trim();
      if (!u || !k) { $('#sMsg').textContent = '请填写完整'; return; }
      cfg = { u: u, k: k }; LS.set('cfg', cfg);
      $('#sMsg').textContent = '测试中…';
      api({ action: 'ping' }).then(function () { toast('连接成功'); location.hash = '#/'; route(); },
        function (e) { $('#sMsg').innerHTML = '<span class="err">连接失败：' + esc(e.message) + '</span>（已保存，可稍后再试）'; });
    };
  }

  function viewLogin() {
    setBar('选择员工', false);
    var cached = LS.get('staff', []);
    var chosen = null;
    function draw(list, msg) {
      app.innerHTML = '<div class="card"><h3 style="margin-top:0">请选择你的名字</h3><div class="staff">' +
        list.map(function (s, i) { return '<button data-i="' + i + '">' + esc(s.name) + '</button>'; }).join('') +
        '</div><div id="pinBox" hidden class="field" style="margin-top:12px"><label>PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="off"></div>' +
        '<button class="btn save" id="lgo" style="width:100%;margin-top:12px" disabled>进入</button>' +
        '<p class="hint" id="lmsg">' + esc(msg || '') + '</p></div>';
      Array.prototype.forEach.call(app.querySelectorAll('.staff button'), function (b) {
        b.onclick = function () {
          Array.prototype.forEach.call(app.querySelectorAll('.staff button'), function (x) { x.classList.remove('on'); });
          b.classList.add('on'); chosen = list[+b.dataset.i];
          $('#pinBox').hidden = !chosen.pin; $('#lgo').disabled = false; if (chosen.pin) $('#pin').focus();
        };
      });
      $('#lgo').onclick = function () {
        if (!chosen) return;
        $('#lgo').disabled = true;
        api({ action: 'login', name: chosen.name, pin: chosen.pin ? $('#pin').value : '' }).then(function (d) {
          if (!d.login) { $('#lmsg').innerHTML = '<span class="err">' + esc(d.message) + '</span>'; $('#lgo').disabled = false; return; }
          operator = d.name; LS.set('operator', operator); location.hash = '#/'; route();
        }, function (e) {
          if (e.network && !chosen.pin) { operator = chosen.name; LS.set('operator', operator); route(); return; }
          $('#lmsg').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; $('#lgo').disabled = false;
        });
      };
    }
    draw(cached, cached.length ? '' : '加载员工名单…');
    api({ action: 'staff' }).then(function (d) { LS.set('staff', d.staff); draw(d.staff); },
      function (e) { if (!cached.length) draw([], '无法加载员工名单：' + e.message); });
  }

  // ---------------- 页面 1：入库任务列表 ----------------
  function viewJobs() {
    setBar('入库任务', false);
    var cached = LS.get('jobs', null);
    function draw(jobs, note) {
      if (!jobs) { app.innerHTML = '<div class="empty">加载中…</div>'; return; }
      app.innerHTML = '<div class="topline"><span>员工：' + esc(operator) + '</span><button class="link" id="jr">刷新</button></div>' +
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
      (p.op ? '<div class="hint" style="margin-top:4px">上次：' + esc(p.op) + ' ' + esc(p.time) + '</div>' : '') + '</div>' +
      BC.map(function (b, i) {
        return '<div class="bc" id="w_' + b[0] + '"><label><span>' + (i + 1) + '. ' + b[2] + ' <small id="t_' + b[0] + '">' + b[1] + '</small></span>' +
          '<span class="tools"><button class="tbtn" data-kbd="' + b[0] + '">⌨ 手输</button><button class="tbtn" data-clr="' + b[0] + '">✕ 清除</button></span></label>' +
          '<div class="bcrow"><input id="f_' + b[0] + '" data-k="' + b[0] + '" inputmode="' + im + '" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" value="' + esc(orig[b[0]]) + '" placeholder="扫描或输入">' +
          '<button class="btn cam" data-cam="' + b[0] + '">📷 扫描</button></div></div>';
      }).join('') +
      '<div class="bc" id="w_qty"><label><span>4. 实收数量 <small>按供应商单位（' + esc(unit) + '）清点</small></span></label>' +
      '<div class="bcrow qtyrow"><button class="btn clr" data-step="-1" aria-label="减1">−</button>' +
      '<input id="f_qty" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="' + esc(orig.qty) + '" placeholder="数量">' +
      '<span class="unit">' + esc(unit) + '</span><button class="btn clr" data-step="1" aria-label="加1">+</button></div></div>' +
      '<div class="bc" id="w_spec"><label class="chk"><input type="checkbox" id="f_specBad"' + (orig.specBad ? ' checked' : '') + '><span>5. 规格不符</span><small>（与上面规格不一致时勾选）</small></label>' +
      '<div id="specBox"' + (orig.specBad ? '' : ' hidden') + '><input id="f_specActual" class="search" autocomplete="off" placeholder="实际规格（选填），如 1箱=24包" value="' + esc(orig.specActual) + '"></div></div>' +
      '<div class="bc" id="w_remark"><label><span>6. 备注（选填）</span></label><textarea id="f_remark" class="remark" rows="2" placeholder="例：外箱破损2箱 / 少1件 / 条码模糊">' + esc(orig.remark) + '</textarea></div>' +
      '<details class="more"' + (moreOpen ? ' open' : '') + '><summary>更多资料（选填）：无条码原因 / 日期 / 保质期</summary><div class="grid2">' +
      '<div class="full"><label>无条码原因</label><select id="f_reason"><option value=""></option>' + REASONS.map(function (r) { return '<option' + (orig.reason === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') +
      (orig.reason && REASONS.indexOf(orig.reason) < 0 ? '<option selected>' + esc(orig.reason) + '</option>' : '') + '</select></div>' +
      '<div class="full"><label>保质期（月）</label><input id="f_shelf" inputmode="numeric" value="' + esc(orig.shelf) + '"></div>' +
      '<div><label>生产日期（日/月/年）</label><input id="f_mfg" class="dt" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="例 22092026" value="' + esc(isoToDmy(orig.mfg)) + '"></div>' +
      '<div><label>有效期（日/月/年）</label><input id="f_exp" class="dt" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="例 21032028" value="' + esc(isoToDmy(orig.exp)) + '"></div>' +
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
    function markHas() { BC.concat([['qty']]).forEach(function (b) { F[b[0]].classList.toggle('has', !!F[b[0]].value.trim()); }); var s = statusOf(values()); $('#pst').innerHTML = '<span class="badge ' + ({ '已采集': 'b-done', '部分采集': 'b-part', '未采集': 'b-todo' })[s] + '">' + s + '</span>'; }
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
      if (force !== true && force !== 'date' && badDates.length) {
        modal('<h3>日期看不懂</h3><p class="hint">' + badDates.map(function (x) { return x[1] + '：' + esc(F[x[0]].value); }).join('<br>') + '<br><br>请按 日/月/年 输入数字，例如 22092026 或 220926。</p><div class="row"><button class="btn ghost" id="dGo">去修改</button><button class="btn save" id="dSave">仍然保存</button></div>', function (m) {
          $('#dGo', m).onclick = function () { closeModal(); var d = $('details.more'); if (d) d.open = true; F[badDates[0][0]].focus(); };
          $('#dSave', m).onclick = function () { closeModal(); doSave('date'); };
        });
        return;
      }
      if (force !== true && !cur.qty && cur.reason !== '货没收到不知道实际码') {
        modal('<h3>实收数量还没填</h3><p class="hint">这个商品会显示为“部分采集”。</p><div class="row"><button class="btn ghost" id="qGo">去填写</button><button class="btn save" id="qSave">仍然保存</button></div>', function (m) {
          $('#qGo', m).onclick = function () { closeModal(); F.qty.focus(); };
          $('#qSave', m).onclick = function () { closeModal(); doSave(true); };
          setTimeout(function () { $('#qGo', m).focus(); }, 30);
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

  // ---------------- 摄像头扫码 ----------------
  var cam = null, camOpen = false;
  function stopCamera() {
    if (cam) { var c = cam; cam = null; try { c.stop().catch(function () { }).then(function () { try { c.clear(); } catch (e) { } }); } catch (e) { } }
    var s = $('.scanner'); if (s) s.remove();
    camOpen = false;
  }
  function beep() {
    try { if (navigator.vibrate) navigator.vibrate(80); } catch (e) { }
    try {
      var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      var ctx = beep.ctx || (beep.ctx = new A()); var o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 1800; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.09);
    } catch (e) { }
  }
  function openCamera(kind, onCode) {
    if (!window.Html5Qrcode) { toast('扫码组件未加载，请联网后刷新一次'); return; }
    var label = BC.filter(function (b) { return b[0] === kind; })[0][2];
    var wrap = document.createElement('div');
    wrap.className = 'scanner';
    wrap.innerHTML = '<div class="top"><span>扫描：' + label + '</span><span id="camMsg" class="hint" style="color:#ccc"></span></div><div id="reader"></div>' +
      '<div class="bottom"><button class="btn ghost" id="camClose">取消</button></div>';
    document.body.appendChild(wrap);
    camOpen = true;
    $('#camClose').onclick = stopCamera;
    var F = Html5QrcodeSupportedFormats;
    cam = new Html5Qrcode('reader', {
      verbose: false,
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    });
    var w = Math.min(window.innerWidth - 40, 360);
    var done = false;
    cam.start({ facingMode: 'environment' }, { fps: 15, qrbox: { width: w, height: Math.round(w * 0.5) } },
      function (text) {
        if (done) return; done = true;
        beep();
        stopCamera();
        onCode(String(text).replace(/[\r\n\t]/g, '').trim());
      }, function () { }).catch(function (err) {
        var m = $('#camMsg'); if (m) m.textContent = '';
        var r = $('#reader'); if (r) r.innerHTML = '<p style="color:#fff;padding:20px">无法打开摄像头：' + esc(err && err.message || err) +
          '<br><br>请在 Chrome 网站设置里允许本网站使用相机；或改用扫描头 / 手动输入。</p>';
      });
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

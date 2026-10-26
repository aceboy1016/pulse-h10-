/*
 * PULSE — 画面と状態の管理
 * 表示する文字列はすべて textContent で入れ、読み込んだデータをHTMLとして実行しない。
 */
(function () {
  'use strict';
  const P = window.PulsePhysio, DB = window.PulseDB, B = window.PulseBackup;
  const Chart = window.PulseChart, Fig = window.PulseFigures;
  const $ = function (id) { return document.getElementById(id); };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const LIVE_KEEP_MS = 10 * 60 * 1000;
  const AUTOSAVE_MS = 15000;
  const SOURCE_LABEL = { h10: '実測', demo: 'デモ' };

  const S = {
    view: 'pre',
    customers: [],
    customer: null,
    sessions: [],        // 選択中の顧客の保存済みセッション
    source: null,        // 受信中の入力源 'h10' | 'demo'
    live: [],            // 受信した実測値 [[t,bpm]]（表示用）
    last: null,          // 最後の実測 {t,bpm}
    contactLost: false,
    session: null,       // 進行中のセッション
    recovery: null,      // 進行中の回復計測
    dirty: false,
    saving: null,
    resultSessionId: null,
    editingId: null,     // 編集中の顧客ID（新規は ''）
    dbOk: true
  };
  const hrm = new window.HeartRateMonitor();
  const demo = new window.DemoSource();

  // ---------- 小物 ----------
  function now() { return Date.now(); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDur(ms) {
    if (ms == null || ms < 0) return '--';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
  }
  function fmtTime(t) { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtDate(t) { const d = new Date(t); return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + fmtTime(t); }
  function isToday(t) { const a = new Date(t), b = new Date(); return a.toDateString() === b.toDateString(); }
  function signed(n) { return (n > 0 ? '＋' : n < 0 ? '−' : '±') + Math.abs(n); }
  function dropText(d) { return d >= 0 ? d + ' bpm低下' : Math.abs(d) + ' bpm上昇'; }
  function isStale(t) { return !S.last || (t || now()) - S.last.t > P.STALE_MS || S.contactLost; }
  function currentBpm() { return isStale() ? null : S.last.bpm; }
  function setText(el, text) { if (typeof el === 'string') el = $(el); if (el && el.textContent !== text) el.textContent = text; }
  function setNum(el, text) {
    if (el.textContent === text) return;
    el.textContent = text;
    if (!reduceMotion.matches) { el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); }
  }
  function mk(tag, text, cls) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function numInput(id) { const v = $(id).value.trim(); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 保存できなくても動作する */ } }

  let toastTimer = null;
  function toast(text, isError) {
    const t = $('toast');
    setText('toastText', text);
    t.classList.toggle('error', !!isError);
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, isError ? 5000 : 2200);
  }
  function banner(text) { const b = $('msgBanner'); b.hidden = !text; b.textContent = text || ''; }

  // buttons: [{label, value, cls}]
  function ask(title, body, buttons) {
    const dlg = $('dialog');
    setText('dlgTitle', title); setText('dlgBody', body || '');
    const box = $('dlgButtons'); box.textContent = '';
    buttons.forEach(function (b) {
      const btn = mk('button', b.label, 'btn ' + (b.cls || ''));
      btn.value = b.value; btn.type = 'submit';
      box.appendChild(btn);
    });
    return new Promise(function (resolve) {
      dlg.returnValue = '';
      dlg.addEventListener('close', function onClose() { dlg.removeEventListener('close', onClose); resolve(dlg.returnValue || 'cancel'); });
      dlg.showModal();
    });
  }

  // ---------- 保存 ----------
  function sessionSnapshot() {
    const s = S.session;
    return Object.assign({}, s, { activeRecovery: S.recovery ? Object.assign({}, S.recovery, readConditions()) : null });
  }
  async function saveSession() {
    if (!S.session) return;
    const snap = sessionSnapshot();
    S.dirty = false;
    try {
      S.saving = DB.put('sessions', snap);
      await S.saving;
      if (!S.dbOk) { S.dbOk = true; banner(''); }
    } catch (e) {
      S.dirty = true; S.dbOk = false;
      banner('保存に失敗しました：' + (e && e.message ? e.message : '不明なエラー') + '。この画面を閉じずにJSONバックアップを保存してください。');
      throw e;
    } finally { S.saving = null; }
  }
  setInterval(function () { if (S.dirty && S.session) saveSession().catch(function () {}); }, AUTOSAVE_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && S.dirty && S.session) saveSession().catch(function () {});
    if (!document.hidden) scheduleFrame();
  });
  window.addEventListener('pagehide', function () { if (S.dirty && S.session) saveSession().catch(function () {}); });
  window.addEventListener('beforeunload', function (e) {
    if (S.session) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- 入力源 ----------
  function onHr(source, d) {
    if (S.source !== source) return;
    const sess = S.session && S.session.source === source ? S.session : null;
    if (d.contact === false) {
      if (!S.contactLost && sess) { sess.events.push({ t: d.t, type: 'contact-lost' }); S.dirty = true; }
      S.contactLost = true;
      return;
    }
    if (!P.isValidBpm(d.bpm)) return;
    S.contactLost = false;
    S.last = { t: d.t, bpm: d.bpm };
    S.live.push([d.t, d.bpm]);
    while (S.live.length && S.live[0][0] < d.t - LIVE_KEEP_MS) S.live.shift();
    if (sess) { sess.samples.push([d.t, d.bpm]); S.dirty = true; }
    renderLive();
  }
  function onDisconnect(source, d) {
    if (S.session && S.session.source === source && S.session.status === 'active') {
      S.session.events.push({ t: d.t, type: 'disconnect' }); S.dirty = true;
    }
    renderLive();
  }
  hrm.addEventListener('hr', function (e) { onHr('h10', e.detail); });
  hrm.addEventListener('disconnect', function (e) { onDisconnect('h10', e.detail); });
  hrm.addEventListener('state', function (e) {
    const st = e.detail.state;
    if (st === 'connected') { setSource('h10'); }
    if (e.detail.message && (st === 'error' || st === 'lost' || st === 'idle' && /キャンセル/.test(e.detail.message))) banner(e.detail.message);
    else if (st === 'connected') banner('');
    renderConn();
  });
  demo.addEventListener('hr', function (e) { onHr('demo', e.detail); });
  demo.addEventListener('disconnect', function (e) { onDisconnect('demo', e.detail); });
  demo.addEventListener('state', renderConn);

  function setSource(src) {
    if (S.source !== src) { S.source = src; S.live = []; S.last = null; S.contactLost = false; }
    renderConn();
  }

  async function toggleConnect() {
    if (hrm.state === 'connected' || hrm.state === 'reconnecting' || hrm.state === 'connecting') {
      await hrm.disconnect();
      if (S.source === 'h10') setSource(null);
      return;
    }
    if (demo.timer) {
      demo.stop();
      setSource(null);
    }
    try { await hrm.connect(); } catch (_) { /* 状態表示で案内する */ }
  }

  async function toggleDemo() {
    if (demo.timer) { demo.stop(); setSource(null); return; }
    if (hrm.state === 'connected' || hrm.state === 'reconnecting') {
      const r = await ask('デモ信号に切り替えますか？', 'H10を切断し、模擬信号を表示します。デモの心拍は実測ではなく、記録には「デモ」と区別して保存されます。',
        [{ label: 'キャンセル', value: 'cancel', cls: 'ghost' }, { label: '切り替える', value: 'ok', cls: 'primary' }]);
      if (r !== 'ok') return;
      await hrm.disconnect();
    }
    setSource('demo');
    demo.setMode(S.recovery ? 'recovery' : S.session ? 'exercise' : 'rest');
    demo.start();
  }

  function renderConn() {
    const pill = $('connPill');
    const stale = isStale();
    let state = 'idle', text = '未接続';
    if (S.source === 'demo' && demo.timer) { state = 'demo'; text = 'デモ信号'; }
    else if (hrm.state === 'connected') {
      state = 'connected'; text = (hrm.device && hrm.device.name) || '接続中';
    } else if (hrm.state === 'connecting' || hrm.state === 'requesting') { state = 'connecting'; text = '接続中…'; }
    else if (hrm.state === 'reconnecting') { state = 'reconnecting'; text = '再接続中…'; }
    else if (hrm.state === 'lost') { state = 'lost'; text = '切断'; }
    else if (hrm.state === 'error') { state = 'error'; text = '接続エラー'; }
    if ((state === 'connected' || state === 'demo') && stale) {
      state = 'stale'; text = S.contactLost ? 'センサー接触なし' : (S.last ? '受信途絶' : '受信待ち');
    }
    pill.dataset.state = state;
    setText('connText', text);
    const connected = ['connected', 'connecting', 'reconnecting', 'requesting'].indexOf(hrm.state) >= 0;
    setText('btnConnect', connected ? '切断' : 'H10に接続');
    $('btnConnect').classList.toggle('primary', !connected);
    setText('btnDemo', demo.timer ? 'デモ停止' : 'デモ');
  }

  // ---------- 画面切り替え ----------
  function setView(v) {
    S.view = v;
    document.querySelectorAll('.tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.view === v)); });
    document.querySelectorAll('.view').forEach(function (s) { s.classList.toggle('active', s.dataset.view === v); });
    if (v === 'results') renderResults();
    if (v === 'recovery') { fillConditions(); renderRecovery(); }
    renderAll();
    scheduleFrame();
  }

  // ---------- 顧客 ----------
  async function loadCustomers() {
    S.customers = (await DB.getAll('customers')) || [];
    S.customers.sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });
    renderCustomerSelect();
  }
  function renderCustomerSelect() {
    const sel = $('customerSelect');
    sel.textContent = '';
    const o0 = mk('option', S.customers.length ? '顧客を選択' : '顧客が未登録です（「新規」から登録）'); o0.value = '';
    sel.appendChild(o0);
    S.customers.forEach(function (c) {
      const o = mk('option', c.name + (c.isDemo ? '（デモ）' : '')); o.value = c.id; sel.appendChild(o);
    });
    sel.value = S.customer ? S.customer.id : '';
  }
  async function selectCustomer(id) {
    if (S.customer && S.customer.id === id) return true;
    if (S.session) {
      const r = await ask('進行中のセッションがあります', '「' + S.customer.name + '」のセッションを保存して終了してから切り替えますか？',
        [{ label: 'キャンセル', value: 'cancel', cls: 'ghost' }, { label: '保存して切り替える', value: 'ok', cls: 'primary' }]);
      if (r !== 'ok' || !(await endSession(true))) { renderCustomerSelect(); return false; }
    }
    S.customer = S.customers.find(function (c) { return c.id === id; }) || null;
    S.resultSessionId = null;
    if (S.customer) lsSet('pulse-h10:lastCustomer', S.customer.id);
    await loadSessions();
    closeCustomerForm();
    renderCustomerSelect();
    renderAll();
    if (S.view === 'results') renderResults();
    return true;
  }
  async function loadSessions() {
    S.sessions = S.customer ? ((await DB.sessionsByCustomer(S.customer.id)) || []) : [];
    S.sessions.sort(function (a, b) { return b.startedAt - a.startedAt; });
  }

  function openCustomerForm(c) {
    S.editingId = c ? c.id : '';
    $('customerForm').hidden = false;
    $('btnEditCustomer').hidden = true;
    $('cName').value = c ? c.name : '';
    $('cAge').value = c && c.age != null ? c.age : '';
    $('cResting').value = c && c.restingHr != null ? c.restingHr : '';
    $('cMaxMeasured').value = c && c.maxHrMeasured != null ? c.maxHrMeasured : '';
    $('cUseMeasured').checked = !!(c && c.useMeasuredMax);
    $('cMemo').value = c ? c.memo || '' : '';
    $('cIsDemo').checked = !!(c && c.isDemo);
    $('btnDeleteCustomer').hidden = !c;
    $('cName').focus();
  }
  function closeCustomerForm() { $('customerForm').hidden = true; S.editingId = null; renderCustomerFacts(); }

  async function saveCustomer(ev) {
    ev.preventDefault();
    const name = $('cName').value.trim();
    const age = numInput('cAge'), rest = numInput('cResting'), mx = numInput('cMaxMeasured');
    if (!name) { toast('氏名を入力してください', true); return; }
    if (Number.isNaN(age) || (age != null && (age < 5 || age > 110))) { toast('年齢は5〜110で入力してください', true); return; }
    if (Number.isNaN(rest) || (rest != null && (rest < 20 || rest > 200))) { toast('安静時心拍は20〜200で入力してください', true); return; }
    if (Number.isNaN(mx) || (mx != null && (mx < 80 || mx > 260))) { toast('最大心拍は80〜260で入力してください', true); return; }
    const prev = S.editingId ? S.customers.find(function (c) { return c.id === S.editingId; }) : null;
    const c = Object.assign({}, prev || { id: B.uid(), createdAt: now(), todayPre: null }, {
      name: name, age: age, restingHr: rest, maxHrMeasured: mx,
      useMeasuredMax: $('cUseMeasured').checked && mx != null,
      memo: $('cMemo').value.slice(0, 2000), isDemo: $('cIsDemo').checked, updatedAt: now()
    });
    try {
      await DB.put('customers', c);
    } catch (e) { toast('保存に失敗しました：' + (e.message || ''), true); return; }
    await loadCustomers();
    if (!prev) await selectCustomer(c.id);
    else { S.customer = S.customers.find(function (x) { return x.id === c.id; }); }
    closeCustomerForm();
    renderAll();
    toast('顧客情報を保存しました');
  }

  async function deleteCustomer() {
    const c = S.customer;
    if (!c || S.editingId !== c.id) return;
    if (S.session) { toast('セッションを終了してから削除してください', true); return; }
    const nRec = S.sessions.reduce(function (a, s) { return a + s.recoveries.length; }, 0);
    const r = await ask('顧客を削除しますか？', '「' + c.name + '」と、セッション' + S.sessions.length + '件・回復記録' + nRec + '件を削除します。元に戻せません。必要ならJSONバックアップを先に保存してください。',
      [{ label: 'キャンセル', value: 'cancel', cls: 'ghost' }, { label: '削除する', value: 'ok', cls: 'danger solid' }]);
    if (r !== 'ok') return;
    try { await DB.deleteCustomer(c.id); } catch (e) { toast('削除に失敗しました：' + (e.message || ''), true); return; }
    S.customer = null; S.sessions = [];
    await loadCustomers();
    closeCustomerForm();
    renderAll();
    toast('削除しました');
  }

  function renderCustomerFacts() {
    const dl = $('customerFacts'); dl.textContent = '';
    const c = S.customer;
    $('btnEditCustomer').hidden = !c || !$('customerForm').hidden;
    setText('whoLabel', c ? c.name + (c.isDemo ? '（デモ）' : '') : '顧客未選択');
    if (!c) return;
    const mx = P.resolveMaxHr(c);
    const rows = [
      ['年齢', c.age != null ? c.age + '歳' : '未設定'],
      ['推定最大心拍', c.age != null ? P.estimateMaxHr(c.age) + ' bpm（208 − 0.7 × 年齢）' : '年齢を設定すると表示'],
      ['測定済み最大心拍', c.maxHrMeasured != null ? c.maxHrMeasured + ' bpm' + (c.useMeasuredMax ? '（優先して使用）' : '（未使用）') : '未設定'],
      ['使用する最大心拍', mx ? mx.value + ' bpm' + (mx.source === 'measured' ? '（測定値）' : '（推定）') : '未設定'],
      ['普段の安静時心拍', c.restingHr != null ? c.restingHr + ' bpm' : '未設定'],
      ['メモ', c.memo || '—']
    ];
    rows.forEach(function (r) { dl.appendChild(mk('dt', r[0])); dl.appendChild(mk('dd', r[1])); });
    if (c.isDemo) { const dd = mk('dd'); dd.appendChild(mk('span', 'デモ用の顧客', 'badge')); dl.appendChild(mk('dt', '区分')); dl.appendChild(dd); }
  }

  // ---------- 運動前 ----------
  function todayPre() {
    const c = S.customer;
    return c && c.todayPre && isToday(c.todayPre.t) ? c.todayPre : null;
  }
  async function registerPre() {
    if (!S.customer) { toast('先に顧客を選択してください', true); return; }
    const bpm = currentBpm();
    if (bpm == null) { toast('心拍を受信していません', true); return; }
    const c = Object.assign({}, S.customer, { todayPre: { bpm: bpm, t: now(), source: S.source }, updatedAt: now() });
    try { await DB.put('customers', c); } catch (e) { toast('保存に失敗しました：' + (e.message || ''), true); return; }
    S.customer = c;
    S.customers = S.customers.map(function (x) { return x.id === c.id ? c : x; });
    if (S.session && !S.session.preHr && S.session.source === S.source) { S.session.preHr = { bpm: bpm, t: c.todayPre.t }; S.dirty = true; }
    renderPre();
    toast('今日の運動前心拍を登録しました（' + bpm + ' bpm）');
  }

  function renderPre() {
    const bpm = currentBpm();
    setNum($('preLive'), bpm == null ? '--' : String(bpm));
    const t = now();
    const recent = S.live.filter(function (s) { return s[0] >= t - 30000; });
    if (bpm == null) setText('preStability', S.source ? '心拍を受信していません。センサーの装着と接続を確認してください。' : '「H10に接続」を押して心拍計に接続してください。');
    else if (recent.length >= 15) {
      const vals = recent.map(function (s) { return s[1]; });
      const range = Math.max.apply(null, vals) - Math.min.apply(null, vals);
      setText('preStability', '直近30秒の変動幅 ' + range + ' bpm' + (range <= 5 ? '：安定しています' : '：落ち着くまで少し待ってください'));
    } else setText('preStability', '座るなど落ち着いた状態で、数値が安定してから登録してください。');
    const pre = todayPre();
    setText('preRegistered', pre ? '登録済み：' + pre.bpm + ' bpm（' + fmtTime(pre.t) + (pre.source === 'demo' ? '・デモ' : '') + '）' : '未登録');
    $('btnRegisterPre').disabled = !S.customer || bpm == null;
    $('btnStartSession').disabled = !S.customer || !!S.session;
    let hint = '';
    if (S.session) hint = 'セッションを記録中です（' + fmtTime(S.session.startedAt) + '開始）。';
    else if (!S.customer) hint = '顧客を選択すると開始できます。';
    else if (!S.source) hint = '心拍計に接続するか「デモ」を押してください。';
    setText('startHint', hint);
  }

  async function startSession() {
    if (!S.customer || S.session) return;
    if (!S.source || isStale()) { toast('心拍を受信してから開始してください', true); return; }
    let pre = todayPre();
    if (pre && pre.source !== S.source) pre = null; // デモと実測を混ぜない
    if (!pre) {
      const r = await ask('運動前心拍が未登録です', '今日の運動前心拍を登録せずに開始しますか？（回復画面の「運動前の基準との差」は表示されません）',
        [{ label: '戻る', value: 'cancel', cls: 'ghost' }, { label: '登録せずに開始', value: 'ok', cls: 'primary' }]);
      if (r !== 'ok') return;
    }
    const mx = P.resolveMaxHr(S.customer);
    S.session = {
      id: B.uid(), customerId: S.customer.id, source: S.source, status: 'active',
      startedAt: now(), endedAt: null,
      maxHr: mx ? mx.value : null, maxHrSource: mx ? mx.source : null,
      preHr: pre ? { bpm: pre.bpm, t: pre.t } : null,
      samples: [], events: [{ t: now(), type: 'start' }], recoveries: [], activeRecovery: null
    };
    try { await saveSession(); } catch (_) { /* バナーで表示済み。記録は続ける */ }
    if (S.source === 'demo') demo.setMode('exercise');
    setView('exercise');
  }

  async function endSession(silent) {
    if (!S.session) return true;
    if (S.recovery) {
      const r = await ask('回復計測中です', '回復記録を保存してからセッションを終了しますか？',
        [{ label: 'キャンセル', value: 'cancel', cls: 'ghost' }, { label: '記録せず終了', value: 'drop', cls: 'ghost danger' }, { label: '記録して終了', value: 'ok', cls: 'primary' }]);
      if (r === 'cancel') return false;
      if (r === 'ok') { if (!(await finishRecovery(true))) return false; }
      else S.recovery = null;
    }
    S.session.status = 'complete';
    S.session.endedAt = now();
    S.session.events.push({ t: S.session.endedAt, type: 'end' });
    try { await saveSession(); } catch (_) {
      S.session.status = 'active'; S.session.endedAt = null; S.session.events.pop();
      toast('セッションを保存できませんでした', true);
      return false;
    }
    const id = S.session.id;
    S.session = null;
    if (demo.timer) demo.setMode('rest');
    await loadSessions();
    S.resultSessionId = id;
    if (!silent) { setView('results'); toast('セッションを保存しました'); }
    return true;
  }

  async function discardSession() {
    if (!S.session) return;
    const r = await ask('このセッションを破棄しますか？', '記録中の心拍と回復記録' + S.session.recoveries.length + '件を削除します。元に戻せません。',
      [{ label: 'キャンセル', value: 'cancel', cls: 'ghost' }, { label: '破棄する', value: 'ok', cls: 'danger solid' }]);
    if (r !== 'ok') return;
    try { await DB.remove('sessions', S.session.id); } catch (e) { toast('削除に失敗しました：' + (e.message || ''), true); return; }
    S.session = null; S.recovery = null; S.dirty = false;
    if (demo.timer) demo.setMode('rest');
    await loadSessions();
    setView('pre');
    toast('セッションを破棄しました');
  }

  // ---------- 運動中 ----------
  function maxHrNow() {
    if (S.session && S.session.maxHr) return { value: S.session.maxHr, source: S.session.maxHrSource };
    return P.resolveMaxHr(S.customer);
  }
  function renderExercise() {
    const bpm = currentBpm();
    const hrEl = $('exHr');
    setNum(hrEl, bpm == null ? '--' : String(bpm));
    hrEl.parentElement.classList.toggle('stale', bpm == null);
    const mx = maxHrNow();
    const pct = mx ? P.percentOfMax(bpm, mx.value) : null;
    setText('exPct', pct == null ? '' : pct + '%');
    $('exRing').style.strokeDashoffset = String(100 - Math.min(100, pct || 0));
    const z = P.zoneFor(pct);
    const label = $('exZoneLabel');
    label.textContent = '';
    if (bpm == null) {
      label.textContent = S.source ? (S.contactLost ? 'センサー接触なし' : '受信なし') : '未接続';
      setText('exZoneSummary', S.source ? (S.contactLost ? 'ベルトの電極を湿らせ、胸にしっかり装着してください。' : '5秒以上心拍を受信していません。接続と装着を確認してください。') : '「H10に接続」を押して心拍計に接続してください。');
      setText('exZoneTalk', ''); setText('exZoneExample', ''); Fig.render($('exFigure'), null);
    } else if (!z) {
      label.textContent = '強度：未設定';
      setText('exZoneSummary', '年齢または最大心拍を設定すると、強度の目安を表示します。');
      setText('exZoneTalk', ''); setText('exZoneExample', ''); Fig.render($('exFigure'), null);
    } else {
      label.appendChild(document.createTextNode(z.label));
      label.appendChild(mk('small', '最大心拍の' + z.range));
      setText('exZoneSummary', z.summary);
      setText('exZoneTalk', '会話の目安：' + z.talk);
      const ex = $('exZoneExample'); ex.textContent = '参考イメージ：';
      ex.appendChild(mk('b', z.example));
      ex.appendChild(document.createTextNode('（きつさの感じ方の例。同じ運動量・消費カロリーという意味ではありません）'));
      Fig.render($('exFigure'), z.figure);
    }
    let info = '';
    if (mx) {
      info = '最大心拍 ' + mx.value + ' bpm（' + (mx.source === 'measured' ? '測定値' : '推定：208 − 0.7 × 年齢') + '）';
      if (pct != null && pct > 100) info += '。' + (mx.source === 'measured' ? '設定値' : '推定値') + 'を上回っていますが、推定式には個人差があり、それだけで異常とは判断しません。';
    }
    setText('exMaxInfo', info);
    renderStats();
  }
  function renderStats() {
    const s = S.session;
    const st = s ? P.stats(s.samples) : null;
    setText('stAvg', st && st.avg != null ? String(st.avg) : '--');
    setText('stMax', st && st.max != null ? String(st.max) : '--');
    setText('stMin', st && st.min != null ? String(st.min) : '--');
    setText('stTime', s ? fmtDur(now() - s.startedAt) : '--');
    let info;
    if (!s) info = 'セッション未開始：心拍は表示のみで、記録されていません。「運動前」から開始してください。';
    else {
      info = '記録中 · ' + (s.source === 'demo' ? 'デモ信号（実測ではありません）' : '実測') + ' · 回復記録 ' + s.recoveries.length + '件';
      if (S.source !== s.source) info += ' · 現在の入力源はこのセッションと異なるため記録されていません';
    }
    setText('exSessionInfo', info);
    $('btnStartRecovery').disabled = !s;
    $('btnEndSession').disabled = !s;
    $('btnDiscardSession').disabled = !s;
  }

  // ---------- 回復 ----------
  function readConditions() {
    const m = document.querySelector('#recMethod input:checked');
    const w = numInput('rWeight'), r = numInput('rReps');
    return {
      method: m ? m.value : '',
      exercise: $('rExercise').value.trim().slice(0, 80),
      weight: Number.isFinite(w) && w >= 0 ? w : null,
      reps: Number.isFinite(r) && r >= 0 ? Math.round(r) : null,
      note: $('rNote').value.slice(0, 500)
    };
  }
  function fillConditions() {
    const c = S.recovery || {};
    document.querySelectorAll('#recMethod input').forEach(function (i) { i.checked = i.value === c.method; });
    $('rExercise').value = c.exercise || '';
    $('rWeight').value = c.weight != null ? c.weight : '';
    $('rReps').value = c.reps != null ? c.reps : '';
    $('rNote').value = c.note || '';
  }
  function startRecovery() {
    if (!S.session) return;
    if (!S.recovery) {
      const prev = S.session.recoveries[S.session.recoveries.length - 1];
      S.recovery = {
        id: B.uid(), startAt: now(),
        method: prev ? prev.method : '', exercise: prev ? prev.exercise : '',
        weight: prev ? prev.weight : null, reps: prev ? prev.reps : null, note: '',
        preHr: S.session.preHr ? S.session.preHr.bpm : null
      };
      S.dirty = true;
      if (S.source === 'demo') demo.setMode('recovery');
    }
    setView('recovery');
  }
  function historyRecoveries() {
    const list = [];
    const sessions = S.sessions.filter(function (s) { return !S.session || s.id !== S.session.id; });
    if (S.session) sessions.push(S.session);
    sessions.forEach(function (s) { s.recoveries.forEach(function (r) { list.push({ recovery: r, session: s }); }); });
    return list;
  }
  function compareText(cur, curSource, cur60) {
    if (!cur.method || !cur.exercise) return { text: '回復方法と種目を入力すると、過去の記録と比較できます。' };
    const cmp = P.compareRecovery(cur, curSource, historyRecoveries());
    const box = document.createDocumentFragment();
    function line(prefix, sum, note) {
      const p = mk('div');
      p.appendChild(document.createTextNode(prefix));
      p.appendChild(mk('b', sum.n + '件・平均 ' + dropText(sum.mean) + '・前回 ' + dropText(sum.last)));
      if (cur60 && cur60.status === 'ok') p.appendChild(document.createTextNode('　今回は' + dropText(cur60.drop) + '（前回との差 ' + signed(cur60.drop - sum.last) + '）'));
      if (note) p.appendChild(mk('div', note, 'small'));
      box.appendChild(p);
    }
    if (cmp.same) line('同条件（方法・種目・重量・回数が一致）の60秒値：', cmp.same);
    else if (cmp.partial) line('方法・種目が一致する60秒値：', cmp.partial, '重量または回数が未入力のため「同条件」とは断定していません。');
    else box.appendChild(mk('div', '比較できる過去の記録はありません（同じ顧客・回復方法・種目、' + (curSource === 'demo' ? 'デモ' : '実測') + 'のみ）。'));
    if (cur60 && (cur60.status === 'insufficient' || cur60.status === 'invalid' || cur60.status === 'no-start')) {
      box.appendChild(mk('div', '今回の60秒値は' + B.STATUS_LABEL[cur60.status] + 'のため、比較には使えません。', 'small'));
    }
    return { node: box };
  }
  function pointText(p) {
    if (!p) return ['--', ''];
    if (p.status === 'ok') return ['−' + p.drop + ' → ' + p.bpm, 'ok'];
    if (p.status === 'pending') return ['計測中', ''];
    return [B.STATUS_LABEL[p.status], 'bad'];
  }
  function renderRecovery() {
    const R = S.recovery;
    const t = now();
    $('btnFinishRecovery').disabled = !R;
    $('btnCancelRecovery').disabled = !R;
    $('recForm').classList.toggle('disabled', !R);
    const bpm = currentBpm();
    setNum($('recHr'), bpm == null ? '--' : String(bpm));
    $('recHr').parentElement.classList.toggle('stale', bpm == null);
    if (!R || !S.session) {
      setText('recHeadline', S.session ? '「運動中」の「セット終了・回復を測る」で計測を始めます。' : 'セッションを開始すると回復を計測できます。');
      setText('recSub', ''); setText('recPre', ''); setText('recElapsed', '');
      $('recCompare').textContent = '';
      ['30', '60', '120'].forEach(function (k) { setText('rp' + k, '--'); $('rp' + k).className = 'v'; });
      $('recRing').style.strokeDashoffset = '100';
      return;
    }
    const res = P.computeRecovery(S.session.samples, R.startAt, S.session.events, t);
    const el = t - R.startAt;
    setText('recElapsed', Math.floor(el / 1000) + '秒');
    $('recRing').style.strokeDashoffset = String(100 - Math.min(100, el / 600));
    const p60 = res.points[60];
    let head, sub = '';
    if (res.startHr == null) {
      head = '開始時の心拍がありません';
      sub = 'ボタンを押した時点で心拍を受信していなかったため、低下幅は測定不足です。';
    } else if (p60.status === 'ok') {
      head = '60秒間で' + dropText(p60.drop);
      sub = '回復開始 ' + res.startHr + ' bpm → 60秒後 ' + p60.bpm + ' bpm';
    } else if (p60.status === 'pending') {
      head = bpm == null ? '受信なし' : Math.floor(el / 1000) + '秒で' + dropText(res.startHr - bpm);
      sub = '回復開始 ' + res.startHr + ' bpm → 現在 ' + (bpm == null ? '--' : bpm + ' bpm');
    } else {
      head = '60秒値：' + B.STATUS_LABEL[p60.status];
      sub = '回復開始 ' + res.startHr + ' bpm。60秒前後2秒以内の実測がないか、途中で欠測・切断がありました。';
    }
    setText('recHeadline', head);
    setText('recSub', sub);
    [30, 60, 120].forEach(function (k) { const pt = pointText(res.points[k]); setText('rp' + k, pt[0]); $('rp' + k).className = 'v ' + pt[1]; });
    const pre = R.preHr;
    if (pre == null) setText('recPre', '運動前心拍：未登録');
    else {
      const ref = p60.status === 'ok' ? p60.bpm : bpm;
      setText('recPre', ref == null ? '運動前の基準 ' + pre + ' bpm' : '運動前の基準（' + pre + ' bpm）より ' + signed(ref - pre) + ' bpm' + (p60.status === 'ok' ? '（60秒後）' : '（現在）'));
    }
    const cond = Object.assign({ id: R.id }, readConditions());
    const c = compareText(cond, S.session.source, p60.status === 'pending' ? null : p60);
    const box = $('recCompare'); box.textContent = '';
    if (c.node) box.appendChild(c.node); else box.textContent = c.text;
  }

  async function finishRecovery(fromEnd) {
    const R = S.recovery;
    if (!R || !S.session) return false;
    const t = now();
    if (t - R.startAt < 60000 + P.RECOVERY.tolMs) {
      const r = await ask('60秒に達していません', 'このまま記録すると60秒値は「測定不足」になります。',
        [{ label: '計測を続ける', value: 'cancel', cls: 'ghost' }, { label: 'このまま記録', value: 'ok', cls: 'primary' }]);
      if (r !== 'ok') return false;
    }
    const res = P.computeRecovery(S.session.samples, R.startAt, S.session.events, t);
    Object.keys(res.points).forEach(function (k) { if (res.points[k].status === 'pending') res.points[k] = { status: 'insufficient' }; });
    const rec = Object.assign({}, R, readConditions(), { endAt: t, result: res });
    S.session.recoveries.push(rec);
    S.recovery = null;
    S.dirty = true;
    try { await saveSession(); } catch (_) { toast('回復記録を保存できませんでした（画面上には保持しています）', true); return true; }
    if (!fromEnd) {
      if (S.source === 'demo') demo.setMode('exercise');
      setView('exercise');
      toast('回復記録を保存しました' + (res.points[60].status === 'ok' ? '：60秒で' + dropText(res.points[60].drop) : ''));
    }
    return true;
  }
  async function cancelRecovery() {
    if (!S.recovery) return;
    const r = await ask('回復記録を破棄しますか？', 'この回復計測は保存されません（心拍の時系列はセッションに残ります）。',
      [{ label: 'キャンセル', value: 'cancel', cls: 'ghost' }, { label: '破棄して戻る', value: 'ok', cls: 'danger solid' }]);
    if (r !== 'ok') return;
    S.recovery = null; S.dirty = true;
    if (S.source === 'demo') demo.setMode('exercise');
    setView('exercise');
  }

  // ---------- 結果 ----------
  function allSessions() {
    const list = S.sessions.filter(function (s) { return !S.session || s.id !== S.session.id; });
    if (S.session) list.unshift(S.session);
    return list.sort(function (a, b) { return b.startedAt - a.startedAt; });
  }
  function statusLabel(s) { return s.status === 'active' ? '記録中' : s.status === 'interrupted' ? '中断' : '完了'; }
  function sessionLabel(s) {
    return fmtDate(s.startedAt) + '　' + SOURCE_LABEL[s.source] + (s.status !== 'complete' ? '・' + statusLabel(s) : '') + (s.importedFrom ? '・旧データ' : '');
  }
  function pointCell(p) {
    const td = mk('td');
    if (!p) return td;
    if (p.status === 'ok') { td.textContent = '−' + p.drop + '（' + p.bpm + '）'; td.className = 'ok'; }
    else { td.textContent = B.STATUS_LABEL[p.status] || '—'; td.className = 'bad'; }
    return td;
  }
  function tableHead(table, cols) {
    const tr = mk('tr'); cols.forEach(function (c) { tr.appendChild(mk('th', c)); });
    const thead = mk('thead'); thead.appendChild(tr); table.appendChild(thead);
  }

  function renderResults() {
    const list = allSessions();
    const sel = $('sessionSelect'); sel.textContent = '';
    list.forEach(function (s) { const o = mk('option', sessionLabel(s)); o.value = s.id; sel.appendChild(o); });
    if (!list.find(function (s) { return s.id === S.resultSessionId; })) S.resultSessionId = list[0] ? list[0].id : null;
    sel.value = S.resultSessionId || '';
    sel.hidden = !list.length;
    $('resultEmpty').hidden = !!list.length;
    $('resultEmpty').textContent = S.customer ? 'この顧客のセッションはまだありません。' : '「運動前」で顧客を選択してください。';
    $('resultBody').hidden = !list.length;
    const s = list.find(function (x) { return x.id === S.resultSessionId; });
    if (s) renderSessionDetail(s);
    renderHistory(list);
    renderStorageInfo();
  }

  function renderSessionDetail(s) {
    const end = s.endedAt || now();
    const meta = [fmtDate(s.startedAt) + '〜' + fmtTime(end), s.source === 'demo' ? 'デモ信号（実測ではありません）' : '実測（H10）', statusLabel(s)];
    if (s.maxHr) meta.push('最大心拍 ' + s.maxHr + ' bpm（' + (s.maxHrSource === 'measured' ? '測定値' : '推定') + '）');
    meta.push('運動前 ' + (s.preHr ? s.preHr.bpm + ' bpm' : '未登録'));
    if (s.importedFrom) meta.push('旧サイトから読み込み');
    setText('resultMeta', meta.join(' · '));
    const st = P.stats(s.samples);
    setText('rsAvg', st.avg != null ? String(st.avg) : '--');
    setText('rsMax', st.max != null ? String(st.max) : '--');
    setText('rsMin', st.min != null ? String(st.min) : '--');
    setText('rsTime', fmtDur(end - s.startedAt) + (st.gapMs > 0 ? '（欠測 ' + fmtDur(st.gapMs) + '）' : ''));
    $('btnDeleteSession').disabled = s.status === 'active';
    drawResultChart();

    const table = $('recTable'); table.textContent = '';
    if (!s.recoveries.length) { const tb = mk('tbody'); const tr = mk('tr'); const td = mk('td', '回復記録はありません', 'muted'); tr.appendChild(td); tb.appendChild(tr); table.appendChild(tb); return; }
    tableHead(table, ['セット', '開始', '方法', '種目', '重量', '回数', '開始時', '30秒', '60秒', '120秒', '運動前差(60秒後)', '過去との比較(60秒)']);
    const tb = mk('tbody');
    s.recoveries.forEach(function (r, i) {
      const tr = mk('tr');
      const pts = r.result.points;
      tr.appendChild(mk('td', String(i + 1)));
      tr.appendChild(mk('td', fmtTime(r.startAt)));
      tr.appendChild(mk('td', B.METHOD_LABEL[r.method] || '未入力'));
      tr.appendChild(mk('td', r.exercise || '未入力', 'wrap'));
      tr.appendChild(mk('td', r.weight != null ? r.weight + 'kg' : '—'));
      tr.appendChild(mk('td', r.reps != null ? String(r.reps) : '—'));
      tr.appendChild(mk('td', r.result.startHr != null ? String(r.result.startHr) : '測定不足'));
      tr.appendChild(pointCell(pts[30])); tr.appendChild(pointCell(pts[60])); tr.appendChild(pointCell(pts[120]));
      const pre = r.preHr != null ? r.preHr : (s.preHr && s.preHr.bpm);
      tr.appendChild(mk('td', pre != null && pts[60] && pts[60].status === 'ok' ? signed(pts[60].bpm - pre) + ' bpm' : '—'));
      let cmpTxt = '—';
      if (r.method && r.exercise) {
        const hist = historyRecoveries().filter(function (h) { return h.recovery.startAt < r.startAt; });
        const cmp = P.compareRecovery(r, s.source, hist);
        const sum = cmp.same || cmp.partial;
        if (sum) cmpTxt = (cmp.same ? '同条件' : '方法・種目一致（負荷未確認）') + ' ' + sum.n + '件・平均' + dropText(sum.mean) + (pts[60] && pts[60].status === 'ok' ? '／平均との差 ' + signed(pts[60].drop - sum.mean) : '');
        else cmpTxt = '一致なし';
        if (pts[60] && pts[60].status !== 'ok') cmpTxt += '（今回は測定不足）';
      } else cmpTxt = '条件未入力';
      tr.appendChild(mk('td', cmpTxt, 'wrap'));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
  }

  function renderHistory(list) {
    const table = $('historyTable'); table.textContent = '';
    if (!list.length) { const tb = mk('tbody'); const tr = mk('tr'); tr.appendChild(mk('td', '履歴はありません', 'muted')); tb.appendChild(tr); table.appendChild(tb); return; }
    tableHead(table, ['日時', '種別', '状態', '時間', '平均', '最大', '最小', '回復記録', '60秒低下（有効分の平均）']);
    const tb = mk('tbody');
    list.forEach(function (s) {
      const tr = mk('tr', null, 'clickable' + (s.id === S.resultSessionId ? ' current' : ''));
      const st = P.stats(s.samples);
      const ok = s.recoveries.map(function (r) { return r.result.points[60]; }).filter(function (p) { return p && p.status === 'ok'; });
      tr.appendChild(mk('td', fmtDate(s.startedAt)));
      tr.appendChild(mk('td', SOURCE_LABEL[s.source] + (s.importedFrom ? '（旧）' : '')));
      tr.appendChild(mk('td', statusLabel(s)));
      tr.appendChild(mk('td', fmtDur((s.endedAt || now()) - s.startedAt)));
      tr.appendChild(mk('td', st.avg != null ? String(st.avg) : '--'));
      tr.appendChild(mk('td', st.max != null ? String(st.max) : '--'));
      tr.appendChild(mk('td', st.min != null ? String(st.min) : '--'));
      tr.appendChild(mk('td', String(s.recoveries.length)));
      tr.appendChild(mk('td', ok.length ? '−' + Math.round(ok.reduce(function (a, p) { return a + p.drop; }, 0) / ok.length) + ' bpm（' + ok.length + '件）' : '—'));
      tr.addEventListener('click', function () { S.resultSessionId = s.id; renderResults(); });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
  }

  async function renderStorageInfo() {
    let txt = '';
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        txt = 'このサイトの使用量 約' + (e.usage / 1048576).toFixed(1) + ' MB';
      }
      if (navigator.storage && navigator.storage.persisted) {
        txt += (await navigator.storage.persisted()) ? ' · 永続保存：有効' : ' · 永続保存：未許可（ブラウザが容量不足時に削除する可能性があります）';
      }
    } catch (_) { /* 表示しないだけ */ }
    setText('storageInfo', txt);
  }

  function currentResultSession() { return allSessions().find(function (x) { return x.id === S.resultSessionId; }); }

  async function deleteSessionFromResults() {
    const s = currentResultSession();
    if (!s || s.status === 'active') return;
    const r = await ask('セッションを削除しますか？', sessionLabel(s) + ' の心拍と回復記録' + s.recoveries.length + '件を削除します。元に戻せません。',
      [{ label: 'キャンセル', value: 'cancel', cls: 'ghost' }, { label: '削除する', value: 'ok', cls: 'danger solid' }]);
    if (r !== 'ok') return;
    try { await DB.remove('sessions', s.id); } catch (e) { toast('削除に失敗しました：' + (e.message || ''), true); return; }
    await loadSessions();
    S.resultSessionId = null;
    renderResults();
    toast('削除しました');
  }

  function fileStamp() { const d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); }
  function safeName(s) { return s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'customer'; }

  function csvSession() {
    const s = currentResultSession(); if (!s || !S.customer) return;
    B.download('pulse-' + safeName(S.customer.name) + '-' + s.id.slice(0, 8) + '-hr.csv', B.samplesCsv(S.customer, [s]), 'text/csv;charset=utf-8');
    if (s.recoveries.length) B.download('pulse-' + safeName(S.customer.name) + '-' + s.id.slice(0, 8) + '-recovery.csv', B.recoveriesCsv(S.customer, [s]), 'text/csv;charset=utf-8');
  }
  function csvAll(kind) {
    if (!S.customer) { toast('顧客を選択してください', true); return; }
    const list = allSessions().slice().reverse();
    const text = kind === 'samples' ? B.samplesCsv(S.customer, list) : B.recoveriesCsv(S.customer, list);
    B.download('pulse-' + safeName(S.customer.name) + '-' + (kind === 'samples' ? 'hr' : 'recovery') + '-' + fileStamp() + '.csv', text, 'text/csv;charset=utf-8');
  }

  async function backup() {
    try {
      if (S.session && S.dirty) await saveSession();
      const customers = await DB.getAll('customers');
      const sessions = await DB.getAll('sessions');
      const json = JSON.stringify(B.buildBackup(customers, sessions));
      B.download('pulse-backup-' + fileStamp() + '.json', json, 'application/json');
      toast('バックアップを書き出しました（顧客' + customers.length + '名・セッション' + sessions.length + '件）');
    } catch (e) { toast('バックアップに失敗しました：' + (e.message || ''), true); }
  }

  async function restore(file) {
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type && file.type.indexOf('json') < 0) { toast('JSONファイルを選択してください', true); return; }
    if (file.size > B.MAX_FILE_BYTES) { toast('ファイルが大きすぎます（上限50MB）', true); return; }
    if (file.size === 0) { toast('ファイルが空です', true); return; }
    let parsed;
    try { parsed = B.parseBackup(await file.text()); } catch (e) { toast('復元できません：' + e.message, true); return; }
    const rp = parsed.report;
    if (!parsed.customers.length) { toast('有効な顧客データがありません', true); return; }
    const body = '顧客 ' + rp.customersValid + '名（読込 ' + rp.customersRead + '）・セッション ' + rp.sessionsValid + '件（読込 ' + rp.sessionsRead + '）を追加します。\n既存のデータは削除しません。同じIDのデータはスキップします。' +
      (rp.customersValid < rp.customersRead || rp.sessionsValid < rp.sessionsRead ? '\n形式が不正なデータは読み込みません。' : '') +
      (parsed.legacy ? '\n旧サイト（pulse-v2）の形式として変換しました。復元後に内容を確認してください。' : '');
    const r = await ask('バックアップを復元しますか？', body, [{ label: 'キャンセル', value: 'cancel', cls: 'ghost' }, { label: '追加して復元', value: 'ok', cls: 'primary' }]);
    if (r !== 'ok') return;
    let counts;
    try { counts = await DB.importMerge(parsed.customers, parsed.sessions); } catch (e) { toast('復元に失敗しました：' + (e.message || ''), true); return; }
    await loadCustomers();
    if (S.customer) await loadSessions();
    renderAll();
    if (S.view === 'results') renderResults();
    toast('復元しました：顧客' + counts.customersAdded + '名・セッション' + counts.sessionsAdded + '件を追加' + (counts.customersSkipped + counts.sessionsSkipped ? '（重複' + (counts.customersSkipped + counts.sessionsSkipped) + '件はスキップ）' : ''));
  }

  // ---------- グラフ ----------
  function drawLiveChart() {
    const t = now();
    const pre = S.session && S.session.preHr ? S.session.preHr.bpm : null;
    Chart.draw($('exChart'), {
      from: t - 180000, to: t, samples: S.live, origin: t, xUnit: 'm', xStep: 30000,
      refLines: pre != null ? [{ bpm: pre, label: '運動前 ' + pre }] : [],
      emptyText: '心拍を受信するとグラフを表示します'
    });
  }
  function drawRecoveryChart() {
    const R = S.recovery;
    if (!R || !S.session) {
      Chart.draw($('recChart'), { from: 0, to: 120000, samples: [], xUnit: 's', xStep: 30000, color: getMint(), emptyText: '回復計測中に表示します' });
      return;
    }
    const t = now();
    const res = P.computeRecovery(S.session.samples, R.startAt, S.session.events, t);
    const refs = [];
    if (res.startHr != null) refs.push({ bpm: res.startHr, label: '開始 ' + res.startHr });
    if (R.preHr != null) refs.push({ bpm: R.preHr, label: '運動前 ' + R.preHr });
    const samples = S.session.samples.filter(function (s) { return s[0] >= R.startAt - 3000; });
    Chart.draw($('recChart'), {
      from: R.startAt - 3000, to: Math.max(R.startAt + 125000, t + 3000), origin: R.startAt,
      samples: samples.filter(function (s) { return s[0] <= t; }), xUnit: 's', xStep: 30000, color: getMint(),
      markers: [30, 60, 120].map(function (k) { return { t: R.startAt + k * 1000, label: k + '秒' }; }),
      refLines: refs
    });
  }
  let mintCache = null;
  function getMint() { return mintCache || (mintCache = getComputedStyle(document.documentElement).getPropertyValue('--mint').trim()); }
  function drawResultChart() {
    const s = currentResultSession();
    if (!s || S.view !== 'results') return;
    Chart.draw($('resChart'), {
      from: s.startedAt, to: s.endedAt || now(), samples: s.samples, origin: s.startedAt, xUnit: 'm',
      bands: s.recoveries.map(function (r) { return { from: r.startAt, to: r.endAt }; }),
      refLines: s.preHr ? [{ bpm: s.preHr.bpm, label: '運動前 ' + s.preHr.bpm }] : [],
      emptyText: '心拍データがありません'
    });
  }

  // 描画ループ：表示中の画面だけ、タブが見えているときだけ描く
  let rafId = null, lastDraw = 0;
  function frame(ts) {
    rafId = null;
    if (document.hidden) return;
    if (ts - lastDraw >= 33) {
      lastDraw = ts;
      if (S.view === 'exercise') drawLiveChart();
      else if (S.view === 'recovery') drawRecoveryChart();
    }
    if (!reduceMotion.matches && (S.view === 'exercise' || S.view === 'recovery')) rafId = requestAnimationFrame(frame);
  }
  function scheduleFrame() { if (!rafId && !document.hidden) rafId = requestAnimationFrame(frame); }

  // ---------- 全体 ----------
  function renderLive() {
    renderConn();
    if (S.view === 'pre') renderPre();
    else if (S.view === 'exercise') renderExercise();
    else if (S.view === 'recovery') renderRecovery();
  }
  function renderAll() {
    renderConn(); renderCustomerFacts(); renderPre(); renderExercise(); renderRecovery();
  }

  let lastStale = null;
  setInterval(function () {
    if (document.hidden) return;
    const stale = isStale();
    if (stale !== lastStale) { lastStale = stale; renderLive(); }
    if (S.view === 'recovery') renderRecovery();
    if (S.view === 'exercise') renderStats();
    if (S.view === 'pre') renderPre();
    if (reduceMotion.matches) scheduleFrame();
  }, 500);
  window.addEventListener('resize', function () { if (S.view === 'results') drawResultChart(); scheduleFrame(); });

  // ---------- 起動 ----------
  function checkSupport() {
    const sup = window.HeartRateMonitor.support();
    const b = $('supportBanner');
    if (!sup.ok) {
      b.hidden = false;
      b.textContent = sup.reason === 'insecure'
        ? 'HTTPSで開いたページでのみ心拍計に接続できます。'
        : 'このブラウザはWeb Bluetoothに対応していません。MacのGoogle Chrome（最新版）で開いてください（Safari・Firefoxでは接続できません）。デモ表示と履歴の閲覧は利用できます。';
      $('btnConnect').disabled = true;
      return;
    }
    if (navigator.bluetooth.getAvailability) {
      navigator.bluetooth.getAvailability().then(function (ok) {
        if (!ok) { b.hidden = false; b.textContent = 'Bluetoothを利用できません。MacのBluetoothがオンか、システム設定 > プライバシーとセキュリティ > Bluetooth でChromeが許可されているか確認してください。'; }
      }).catch(function () {});
    }
  }

  async function recoverInterrupted() {
    const all = await DB.getAll('sessions');
    const active = all.filter(function (s) { return s.status === 'active'; });
    for (const s of active) {
      const last = s.samples.length ? s.samples[s.samples.length - 1][0] : s.startedAt;
      if (s.activeRecovery && s.activeRecovery.startAt) {
        const res = P.computeRecovery(s.samples, s.activeRecovery.startAt, s.events, last + P.RECOVERY.tolMs);
        Object.keys(res.points).forEach(function (k) { if (res.points[k].status === 'pending') res.points[k] = { status: 'insufficient' }; });
        s.recoveries.push(Object.assign({}, s.activeRecovery, { endAt: last, result: res, note: ((s.activeRecovery.note || '') + ' [中断]').trim() }));
      }
      s.activeRecovery = null;
      s.status = 'interrupted';
      s.endedAt = last;
      await DB.put('sessions', s);
    }
    if (active.length) banner('前回終了していなかったセッション' + active.length + '件を「中断」として保存しました。結果画面で確認できます。');
  }

  function bind() {
    document.querySelectorAll('.tab').forEach(function (t) { t.addEventListener('click', function () { setView(t.dataset.view); }); });
    $('btnConnect').addEventListener('click', toggleConnect);
    $('btnDemo').addEventListener('click', toggleDemo);
    $('customerSelect').addEventListener('change', function (e) { selectCustomer(e.target.value || null); });
    $('btnNewCustomer').addEventListener('click', function () { openCustomerForm(null); });
    $('btnEditCustomer').addEventListener('click', function () { if (S.customer) openCustomerForm(S.customer); });
    $('btnCancelCustomer').addEventListener('click', closeCustomerForm);
    $('btnDeleteCustomer').addEventListener('click', deleteCustomer);
    $('customerForm').addEventListener('submit', saveCustomer);
    $('btnRegisterPre').addEventListener('click', registerPre);
    $('btnStartSession').addEventListener('click', startSession);
    $('btnStartRecovery').addEventListener('click', startRecovery);
    $('btnEndSession').addEventListener('click', function () { endSession(false); });
    $('btnDiscardSession').addEventListener('click', discardSession);
    $('btnFinishRecovery').addEventListener('click', function () { finishRecovery(false); });
    $('btnCancelRecovery').addEventListener('click', cancelRecovery);
    $('recForm').addEventListener('input', function () { if (S.recovery) { Object.assign(S.recovery, readConditions()); S.dirty = true; renderRecovery(); } });
    $('recForm').addEventListener('submit', function (e) { e.preventDefault(); });
    $('sessionSelect').addEventListener('change', function (e) { S.resultSessionId = e.target.value; renderResults(); });
    $('btnCsvSession').addEventListener('click', csvSession);
    $('btnCsvSamples').addEventListener('click', function () { csvAll('samples'); });
    $('btnCsvRecoveries').addEventListener('click', function () { csvAll('recoveries'); });
    $('btnDeleteSession').addEventListener('click', deleteSessionFromResults);
    $('btnBackup').addEventListener('click', backup);
    $('restoreFile').addEventListener('change', function (e) { const f = e.target.files[0]; e.target.value = ''; restore(f); });
  }

  async function init() {
    bind();
    checkSupport();
    setView('pre');
    try {
      await DB.open();
      await recoverInterrupted();
      await loadCustomers();
      const last = lsGet('pulse-h10:lastCustomer');
      if (last && S.customers.some(function (c) { return c.id === last; })) await selectCustomer(last);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    } catch (e) {
      S.dbOk = false;
      banner('保存領域を開けません（' + (e && e.message ? e.message : '不明なエラー') + '）。プライベートウィンドウでは保存できない場合があります。');
    }
    renderAll();
  }

  // テスト・確認用（データ内容には触れない）
  window.__pulse = { state: S, demo: demo };
  init();
})();

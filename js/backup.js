/*
 * PULSE — JSONバックアップ／復元・CSV出力
 * 復元は既存データを消さず「追加」のみ。読み込んだ文字列はHTMLとして扱わない（表示は textContent）。
 */
(function (root) {
  'use strict';
  const P = root.PulsePhysio;
  const FORMAT = 'pulse-h10-backup';
  const VERSION = 1;
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_TEXT = { name: 80, memo: 2000, exercise: 80, note: 500 };
  const METHODS = ['sitting', 'standing', 'walking'];

  function uid() {
    if (root.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function buildBackup(customers, sessions) {
    return {
      format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
      app: 'PULSE', customers: customers, sessions: sessions
    };
  }

  // ---- 検証ヘルパー ----
  function str(v, max) {
    if (v == null) return '';
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    return s.slice(0, max);
  }
  function num(v, lo, hi) {
    if (v == null || v === '') return null;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) return null;
    return n;
  }
  function time(v) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 946684800000 && v < 4102444800000) return Math.round(v); // 2000–2100年
    if (typeof v === 'string') { const t = Date.parse(v); if (Number.isFinite(t)) return time(t); }
    return null;
  }
  function idOf(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string' && v.length > 0 && v.length <= 100) return v;
    return null;
  }

  function cleanCustomer(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const id = idOf(c.id);
    const name = str(c.name, MAX_TEXT.name);
    if (!id || !name || !name.trim()) return null;
    const pre = c.todayPre && typeof c.todayPre === 'object' ? {
      bpm: num(c.todayPre.bpm, P.BPM_MIN, P.BPM_MAX), t: time(c.todayPre.t),
      source: c.todayPre.source === 'demo' ? 'demo' : 'h10'
    } : null;
    return {
      id: id, name: name.trim(),
      age: num(c.age, 5, 110),
      memo: str(c.memo, MAX_TEXT.memo) || '',
      restingHr: num(c.restingHr, P.BPM_MIN, 200),
      maxHrMeasured: num(c.maxHrMeasured, 80, P.BPM_MAX),
      useMeasuredMax: c.useMeasuredMax === true,
      isDemo: c.isDemo === true,
      todayPre: pre && pre.bpm != null && pre.t != null ? pre : null,
      createdAt: time(c.createdAt) || Date.now(),
      updatedAt: time(c.updatedAt) || Date.now(),
      importedFrom: typeof c.importedFrom === 'string' ? c.importedFrom.slice(0, 40) : undefined
    };
  }

  function cleanSamples(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const s of arr) {
      let t, b;
      if (Array.isArray(s)) { t = time(s[0]); b = num(s[1], P.BPM_MIN, P.BPM_MAX); }
      else if (s && typeof s === 'object') { t = time(s.t != null ? s.t : (s.time != null ? s.time : s.ts)); b = num(s.bpm != null ? s.bpm : (s.hr != null ? s.hr : s.value), P.BPM_MIN, P.BPM_MAX); }
      if (t != null && b != null) out.push([t, Math.round(b)]);
    }
    out.sort(function (a, b) { return a[0] - b[0]; });
    return out;
  }

  function cleanPoint(p) {
    if (!p || typeof p !== 'object') return { status: 'insufficient' };
    const st = ['ok', 'pending', 'insufficient', 'invalid', 'no-start'].indexOf(p.status) >= 0 ? p.status : 'insufficient';
    if (st !== 'ok') return { status: st === 'pending' ? 'insufficient' : st };
    const bpm = num(p.bpm, P.BPM_MIN, P.BPM_MAX), drop = num(p.drop, -200, 240);
    if (bpm == null || drop == null) return { status: 'insufficient' };
    return { status: 'ok', bpm: bpm, drop: drop, offsetMs: num(p.offsetMs, -5000, 5000) || 0 };
  }

  function cleanRecovery(r) {
    if (!r || typeof r !== 'object') return null;
    const startAt = time(r.startAt);
    if (startAt == null) return null;
    const res = r.result && typeof r.result === 'object' ? r.result : {};
    const points = {};
    P.RECOVERY.points.forEach(function (p) { points[p] = cleanPoint(res.points && res.points[p]); });
    return {
      id: idOf(r.id) || uid(), startAt: startAt, endAt: time(r.endAt) || startAt,
      method: METHODS.indexOf(r.method) >= 0 ? r.method : '',
      exercise: str(r.exercise, MAX_TEXT.exercise) || '',
      weight: num(r.weight, 0, 1000), reps: num(r.reps, 0, 1000),
      note: str(r.note, MAX_TEXT.note) || '',
      preHr: num(r.preHr, P.BPM_MIN, P.BPM_MAX),
      result: { startAt: startAt, startHr: num(res.startHr, P.BPM_MIN, P.BPM_MAX), startT: time(res.startT), points: points }
    };
  }

  function cleanSession(s, customerIds) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const id = idOf(s.id), cid = idOf(s.customerId);
    if (!id || !cid || !customerIds.has(cid)) return null;
    const samples = cleanSamples(s.samples);
    const startedAt = time(s.startedAt) || (samples[0] && samples[0][0]);
    if (!startedAt) return null;
    const recs = Array.isArray(s.recoveries) ? s.recoveries.map(cleanRecovery).filter(Boolean) : [];
    const events = Array.isArray(s.events) ? s.events.filter(function (e) {
      return e && typeof e === 'object' && typeof e.type === 'string' && time(e.t) != null;
    }).map(function (e) { return { t: time(e.t), type: e.type.slice(0, 30) }; }) : [];
    const pre = s.preHr && typeof s.preHr === 'object' ? { bpm: num(s.preHr.bpm, P.BPM_MIN, P.BPM_MAX), t: time(s.preHr.t) } : null;
    return {
      id: id, customerId: cid,
      source: s.source === 'demo' ? 'demo' : 'h10',
      status: s.status === 'complete' ? 'complete' : 'interrupted',
      startedAt: startedAt,
      endedAt: time(s.endedAt) || (samples.length ? samples[samples.length - 1][0] : startedAt),
      maxHr: num(s.maxHr, 80, P.BPM_MAX), maxHrSource: s.maxHrSource === 'measured' ? 'measured' : 'estimated',
      preHr: pre && pre.bpm != null ? pre : null,
      samples: samples, events: events, recoveries: recs,
      importedFrom: typeof s.importedFrom === 'string' ? s.importedFrom.slice(0, 40) : undefined
    };
  }

  // 旧サイト（pulse-v2）の形式は確認できていないため、よくある形を幅広く受け付けて変換する。
  // 受け付けたものには importedFrom='pulse-v2' を付けて区別する。
  function fromLegacy(obj) {
    let data = obj;
    if (data && typeof data['pulse-v2'] === 'string') { try { data = JSON.parse(data['pulse-v2']); } catch (_) { return null; } }
    else if (data && data['pulse-v2'] && typeof data['pulse-v2'] === 'object') data = data['pulse-v2'];
    if (!data || typeof data !== 'object') return null;
    const custArr = data.customers || data.clients || data.members || data.users || (data.state && data.state.customers);
    if (!Array.isArray(custArr)) return null;
    const customers = [], sessions = [];
    custArr.forEach(function (c, i) {
      if (!c || typeof c !== 'object') return;
      const id = idOf(c.id) || ('legacy-' + i);
      customers.push({
        id: id, name: c.name || c.displayName || c.fullName, age: c.age,
        memo: c.memo || c.note || c.notes || '',
        restingHr: c.restingHr != null ? c.restingHr : (c.resting != null ? c.resting : c.rhr),
        maxHrMeasured: c.maxHrMeasured != null ? c.maxHrMeasured : (c.maxHr != null ? c.maxHr : c.hrMax),
        useMeasuredMax: c.useMeasuredMax === true || c.maxHrManual === true,
        isDemo: c.isDemo === true || c.demo === true,
        createdAt: c.createdAt, updatedAt: c.updatedAt, importedFrom: 'pulse-v2'
      });
      const embedded = c.sessions || c.history || c.records;
      if (Array.isArray(embedded)) embedded.forEach(function (s) { sessions.push(Object.assign({ customerId: id }, s)); });
    });
    const sessArr = data.sessions || data.history || data.records;
    if (Array.isArray(sessArr)) sessArr.forEach(function (s) { sessions.push(s); });
    const mapped = sessions.map(function (s, i) {
      if (!s || typeof s !== 'object') return null;
      return {
        id: idOf(s.id) || ('legacy-s-' + i),
        customerId: idOf(s.customerId != null ? s.customerId : (s.clientId != null ? s.clientId : s.customer)),
        source: s.source === 'demo' || s.isDemo === true || s.demo === true ? 'demo' : 'h10',
        status: 'complete',
        startedAt: s.startedAt || s.start || s.date || s.createdAt,
        endedAt: s.endedAt || s.end,
        maxHr: s.maxHr, preHr: s.preHr != null && typeof s.preHr !== 'object' ? { bpm: s.preHr, t: s.startedAt || s.start } : s.preHr,
        samples: s.samples || s.series || s.hr || s.data || s.points,
        events: [],
        recoveries: (s.recoveries || s.recovery || []).map ? (s.recoveries || s.recovery || []).map(function (r) {
          if (!r || typeof r !== 'object') return null;
          const d60 = r.drop60 != null ? r.drop60 : (r.hrr60 != null ? r.hrr60 : r.drop);
          const st = r.startHr != null ? r.startHr : r.start;
          const pts = {};
          if (r.result && r.result.points) return r;
          if (d60 != null && st != null) pts[60] = { status: 'ok', drop: Number(d60), bpm: Number(st) - Number(d60) };
          return {
            id: r.id, startAt: r.startAt || r.time || r.t, endAt: r.endAt, method: r.method,
            exercise: r.exercise || r.event || r.name, weight: r.weight, reps: r.reps, note: r.note || r.memo,
            result: { startHr: st, points: pts }
          };
        }).filter(Boolean) : [],
        importedFrom: 'pulse-v2'
      };
    }).filter(Boolean);
    return { customers: customers, sessions: mapped, legacy: true };
  }

  // テキストを検証して { customers, sessions, report } を返す。問題があれば例外。
  function parseBackup(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (_) { throw new Error('JSONとして読み込めませんでした'); }
    if (!obj || typeof obj !== 'object') throw new Error('バックアップの形式ではありません');
    let src, legacy = false;
    if (obj.format === FORMAT) {
      if (typeof obj.version !== 'number' || obj.version > VERSION) throw new Error('このバージョンのバックアップには対応していません');
      if (!Array.isArray(obj.customers) || !Array.isArray(obj.sessions)) throw new Error('顧客またはセッションの一覧がありません');
      src = obj;
    } else {
      src = fromLegacy(obj);
      if (!src) throw new Error('PULSEのバックアップとして認識できませんでした');
      legacy = true;
    }
    const customers = src.customers.map(cleanCustomer).filter(Boolean);
    const ids = new Set(customers.map(function (c) { return c.id; }));
    const sessions = src.sessions.map(function (s) { return cleanSession(s, ids); }).filter(Boolean);
    return {
      customers: customers, sessions: sessions, legacy: legacy,
      report: {
        customersRead: src.customers.length, customersValid: customers.length,
        sessionsRead: src.sessions.length, sessionsValid: sessions.length
      }
    };
  }

  // ---- CSV ----
  function cell(v) {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // 数式として解釈されないように
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCsv(rows) { return '﻿' + rows.map(function (r) { return r.map(cell).join(','); }).join('\r\n') + '\r\n'; }
  function iso(t) { return t == null ? '' : new Date(t).toISOString(); }
  function local(t) {
    if (t == null) return '';
    const d = new Date(t), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  const METHOD_LABEL = { sitting: '座位', standing: '立位', walking: 'ゆっくり歩く' };
  const STATUS_LABEL = { ok: '確定', pending: '計測中', insufficient: '測定不足', invalid: '欠測・切断あり', 'no-start': '開始値なし' };

  function samplesCsv(customer, sessions) {
    const rows = [['customer', 'session_id', 'source', 'timestamp_local', 'timestamp_utc', 'elapsed_s', 'bpm', 'phase']];
    sessions.forEach(function (s) {
      s.samples.forEach(function (x) {
        let phase = 'exercise';
        s.recoveries.forEach(function (r, i) { if (x[0] >= r.startAt && x[0] <= r.endAt) phase = 'recovery' + (i + 1); });
        rows.push([customer.name, s.id, s.source, local(x[0]), iso(x[0]), ((x[0] - s.startedAt) / 1000).toFixed(1), x[1], phase]);
      });
    });
    return toCsv(rows);
  }

  function recoveriesCsv(customer, sessions) {
    const rows = [['customer', 'session_id', 'source', 'set', 'start_local', 'method', 'exercise', 'weight_kg', 'reps', 'note',
      'pre_exercise_bpm', 'start_bpm', 'bpm_30s', 'drop_30s', 'status_30s', 'bpm_60s', 'drop_60s', 'status_60s', 'bpm_120s', 'drop_120s', 'status_120s']];
    sessions.forEach(function (s) {
      s.recoveries.forEach(function (r, i) {
        const pt = function (p) { const x = r.result.points[p] || {}; return [x.bpm, x.drop, STATUS_LABEL[x.status] || '']; };
        rows.push([customer.name, s.id, s.source, i + 1, local(r.startAt), METHOD_LABEL[r.method] || '', r.exercise, r.weight, r.reps, r.note,
          r.preHr != null ? r.preHr : (s.preHr && s.preHr.bpm), r.result.startHr].concat(pt(30), pt(60), pt(120)));
      });
    });
    return toCsv(rows);
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  root.PulseBackup = {
    FORMAT: FORMAT, VERSION: VERSION, MAX_FILE_BYTES: MAX_FILE_BYTES, METHOD_LABEL: METHOD_LABEL, STATUS_LABEL: STATUS_LABEL,
    uid: uid, buildBackup: buildBackup, parseBackup: parseBackup, cleanCustomer: cleanCustomer,
    samplesCsv: samplesCsv, recoveriesCsv: recoveriesCsv, download: download, localTime: local
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PulseBackup;
})(typeof window !== 'undefined' ? window : globalThis);

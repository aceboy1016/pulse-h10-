/*
 * PULSE — 心拍の解析・強度区分・回復計算（DOM非依存。Nodeのテストからも読み込む）
 */
(function (root) {
  'use strict';

  // 強度区分：ACSM（Garber et al., 2011, MSSE 43:1334）の %HRmax による分類。
  // あくまで「強度の目安」であり、換気閾値・乳酸閾値などの生理学的閾値とは別物。
  // 境界は %HRmax を整数に丸めてから判定する（<57 / 57–63 / 64–76 / 77–95 / ≥96）。
  const ZONES = [
    { key: 'very-light', min: 0, max: 57, label: 'とても軽い', range: '57%未満',
      summary: 'ほぼ安静〜ごく軽い動きの目安', talk: '普通に会話でき、歌うこともできるくらい',
      example: 'ゆっくり歩く', figure: 'stand' },
    { key: 'light', min: 57, max: 64, label: '軽い', range: '57–63%',
      summary: '楽に続けられる強度の目安', talk: '楽に会話ができるくらい',
      example: 'ふつうの歩行', figure: 'walk' },
    { key: 'moderate', min: 64, max: 77, label: '中等度', range: '64–76%',
      summary: '呼吸が弾む強度の目安', talk: '会話はできるが、歌うのは難しいくらい',
      example: '速歩き・自転車', figure: 'bike' },
    { key: 'vigorous', min: 77, max: 96, label: '高い', range: '77–95%',
      summary: '息が上がる強度の目安', talk: '短い言葉なら話せるくらい',
      example: 'ジョギング・坂道の自転車', figure: 'run' },
    { key: 'near-max', min: 96, max: Infinity, label: '最大に近い', range: '96%以上',
      summary: '最大に近い強度の目安', talk: 'ほとんど話せないくらい',
      example: '全力に近いダッシュ', figure: 'sprint' }
  ];

  // 回復計測の取り決め
  const RECOVERY = {
    points: [30, 60, 120],   // 計測する経過秒
    tolMs: 2000,             // 目標秒 ±2秒以内の実測値を採用（最も近いもの）
    startMaxAgeMs: 2000,     // 開始時心拍は、ボタン押下前2秒以内の実測値
    gapMs: 5000              // 5秒以上データが空いたら欠測扱い
  };
  const STALE_MS = 5000;     // 5秒以上受信がなければ現在値を表示しない

  const BPM_MIN = 20, BPM_MAX = 260;

  function isValidBpm(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= BPM_MIN && v <= BPM_MAX;
  }

  // Heart Rate Measurement (0x2A37) の解析
  function parseHeartRate(dv) {
    if (!dv || dv.byteLength < 2) return null;
    const flags = dv.getUint8(0);
    const is16 = (flags & 0x01) !== 0;
    if (is16 && dv.byteLength < 3) return null;
    const bpm = is16 ? dv.getUint16(1, true) : dv.getUint8(1);
    const contactSupported = (flags & 0x04) !== 0;
    const contact = contactSupported ? (flags & 0x02) !== 0 : null;
    let offset = is16 ? 3 : 2;
    let energy = null;
    if (flags & 0x08) {
      if (dv.byteLength >= offset + 2) energy = dv.getUint16(offset, true);
      offset += 2;
    }
    const rr = [];
    if (flags & 0x10) {
      for (; offset + 1 < dv.byteLength; offset += 2) {
        rr.push(Math.round(dv.getUint16(offset, true) / 1024 * 1000));
      }
    }
    return { bpm: bpm, is16: is16, contact: contact, energy: energy, rr: rr, flags: flags };
  }

  function estimateMaxHr(age) {
    if (typeof age !== 'number' || !Number.isFinite(age) || age < 5 || age > 110) return null;
    return Math.round(208 - 0.7 * age); // Tanaka et al., 2001
  }

  function resolveMaxHr(customer) {
    if (!customer) return null;
    const est = estimateMaxHr(customer.age);
    if (customer.useMeasuredMax && isValidBpm(customer.maxHrMeasured)) {
      return { value: customer.maxHrMeasured, source: 'measured', estimated: est };
    }
    if (est) return { value: est, source: 'estimated', estimated: est };
    return null;
  }

  function percentOfMax(bpm, maxHr) {
    if (!isValidBpm(bpm) || !maxHr) return null;
    return Math.round(bpm / maxHr * 100);
  }

  function zoneFor(pct) {
    if (pct == null) return null;
    for (const z of ZONES) if (pct >= z.min && pct < z.max) return z;
    return ZONES[ZONES.length - 1];
  }

  // samples: [[t(ms), bpm], ...] 時刻昇順
  function stats(samples, from, to) {
    let n = 0, sum = 0, max = -Infinity, min = Infinity, gapMs = 0, prev = null;
    for (const s of samples) {
      if (from != null && s[0] < from) continue;
      if (to != null && s[0] > to) break;
      n++; sum += s[1];
      if (s[1] > max) max = s[1];
      if (s[1] < min) min = s[1];
      if (prev != null && s[0] - prev > RECOVERY.gapMs) gapMs += s[0] - prev;
      prev = s[0];
    }
    if (!n) return { count: 0, avg: null, max: null, min: null, gapMs: 0 };
    return { count: n, avg: Math.round(sum / n), max: max, min: min, gapMs: gapMs };
  }

  // 二分探索：t 以上の最初のインデックス
  function lowerBound(samples, t) {
    let lo = 0, hi = samples.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid][0] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function sampleNear(samples, t, tol) {
    const i = lowerBound(samples, t - tol);
    let best = null;
    for (let k = i; k < samples.length && samples[k][0] <= t + tol; k++) {
      if (!best || Math.abs(samples[k][0] - t) < Math.abs(best[0] - t)) best = samples[k];
    }
    return best;
  }

  function hasGap(samples, from, to, events) {
    let prev = from;
    for (let k = lowerBound(samples, from); k < samples.length && samples[k][0] <= to; k++) {
      if (samples[k][0] - prev > RECOVERY.gapMs) return true;
      prev = samples[k][0];
    }
    if (to - prev > RECOVERY.gapMs) return true;
    if (events && events.some(function (e) {
      return (e.type === 'disconnect' || e.type === 'contact-lost') && e.t >= from && e.t <= to;
    })) return true;
    return false;
  }

  // 回復の各時点の値を算出する。
  // status: ok / pending(まだ時刻に達していない) / insufficient(許容幅内に実測なし)
  //         / invalid(途中に欠測・切断) / no-start(開始時心拍なし)
  function computeRecovery(samples, startAt, events, now) {
    const startIdx = lowerBound(samples, startAt + 1) - 1;
    const startSample = startIdx >= 0 ? samples[startIdx] : null;
    const result = { startAt: startAt, startHr: null, startT: null, points: {} };
    const validStart = startSample && startAt - startSample[0] <= RECOVERY.startMaxAgeMs;
    if (validStart) { result.startHr = startSample[1]; result.startT = startSample[0]; }
    for (const p of RECOVERY.points) {
      const target = startAt + p * 1000;
      let r;
      if (!validStart) r = { status: 'no-start' };
      else if (now < target + RECOVERY.tolMs) {
        // 許容幅の終わりまで待つ。ただし既に途中で欠測していれば確定的に無効
        r = { status: 'pending' };
      } else {
        const s = sampleNear(samples, target, RECOVERY.tolMs);
        if (!s) r = { status: 'insufficient' };
        else if (hasGap(samples, startSample[0], s[0], events)) r = { status: 'invalid' };
        else r = { status: 'ok', bpm: s[1], drop: startSample[1] - s[1], offsetMs: s[0] - target };
      }
      result.points[p] = r;
    }
    return result;
  }

  function norm(s) {
    return (s == null ? '' : String(s)).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

  // 回復条件の一致度
  // same    : 回復方法・種目・重量・回数がすべて入力済みで一致
  // partial : 回復方法と種目が一致（重量・回数のどちらかが未入力）
  // none    : 比較しない
  function conditionMatch(a, b) {
    if (!a || !b || !a.method || a.method !== b.method) return 'none';
    const ea = norm(a.exercise), eb = norm(b.exercise);
    if (!ea || ea !== eb) return 'none';
    const wa = numOrNull(a.weight), wb = numOrNull(b.weight), ra = numOrNull(a.reps), rb = numOrNull(b.reps);
    if (wa != null && wb != null && wa !== wb) return 'none';
    if (ra != null && rb != null && ra !== rb) return 'none';
    if (wa != null && wb != null && ra != null && rb != null) return 'same';
    return 'partial';
  }

  // 過去の回復記録（{recovery, session}の配列）と比較する
  function compareRecovery(current, currentSource, history) {
    const out = { same: [], partial: [] };
    for (const h of history) {
      const r = h.recovery;
      if (r.id === current.id) continue;
      if ((h.session.source || 'h10') !== (currentSource || 'h10')) continue; // デモと実測を混ぜない
      const p = r.result && r.result.points && r.result.points[60];
      if (!p || p.status !== 'ok') continue;
      const lvl = conditionMatch(current, r);
      if (lvl === 'same') out.same.push(h);
      else if (lvl === 'partial') out.partial.push(h);
    }
    function summarize(list) {
      if (!list.length) return null;
      const drops = list.map(function (h) { return h.recovery.result.points[60].drop; });
      const sorted = list.slice().sort(function (x, y) { return y.recovery.startAt - x.recovery.startAt; });
      return {
        n: list.length,
        mean: Math.round(drops.reduce(function (a, b) { return a + b; }, 0) / drops.length),
        last: sorted[0].recovery.result.points[60].drop,
        lastAt: sorted[0].recovery.startAt
      };
    }
    return { same: summarize(out.same), partial: summarize(out.partial), sameList: out.same, partialList: out.partial };
  }

  const api = {
    ZONES: ZONES, RECOVERY: RECOVERY, STALE_MS: STALE_MS, BPM_MIN: BPM_MIN, BPM_MAX: BPM_MAX,
    isValidBpm: isValidBpm, parseHeartRate: parseHeartRate, estimateMaxHr: estimateMaxHr,
    resolveMaxHr: resolveMaxHr, percentOfMax: percentOfMax, zoneFor: zoneFor, stats: stats,
    sampleNear: sampleNear, hasGap: hasGap, computeRecovery: computeRecovery,
    conditionMatch: conditionMatch, compareRecovery: compareRecovery, norm: norm
  };
  root.PulsePhysio = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

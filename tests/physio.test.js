// node tests/physio.test.js
'use strict';
const assert = require('assert');
const P = require('../js/physio.js');
const B = require('../js/backup.js');

function dv(bytes) { return new DataView(new Uint8Array(bytes).buffer); }
let n = 0;
function t(name, fn) { fn(); n++; console.log('ok -', name); }

t('8bit値', () => assert.strictEqual(P.parseHeartRate(dv([0x00, 72])).bpm, 72));
t('16bit値（リトルエンディアン）', () => assert.strictEqual(P.parseHeartRate(dv([0x01, 0x2c, 0x01])).bpm, 300));
t('接触あり/なし', () => {
  assert.strictEqual(P.parseHeartRate(dv([0x06, 80])).contact, true);
  assert.strictEqual(P.parseHeartRate(dv([0x04, 80])).contact, false);
  assert.strictEqual(P.parseHeartRate(dv([0x00, 80])).contact, null);
});
t('RR間隔（H10の典型形式 0x10）', () => {
  const r = P.parseHeartRate(dv([0x10, 60, 0x00, 0x04, 0x00, 0x04]));
  assert.deepStrictEqual(r.rr, [1000, 1000]);
});
t('エネルギー消費フィールドを飛ばしてRRを読む', () => {
  const r = P.parseHeartRate(dv([0x18, 60, 0x10, 0x00, 0x00, 0x04]));
  assert.strictEqual(r.energy, 16); assert.deepStrictEqual(r.rr, [1000]);
});
t('短すぎるデータ', () => { assert.strictEqual(P.parseHeartRate(dv([0x01, 0x2c])), null); assert.strictEqual(P.parseHeartRate(dv([0])), null); });
t('推定最大心拍', () => { assert.strictEqual(P.estimateMaxHr(40), 180); assert.strictEqual(P.estimateMaxHr(null), null); });
t('測定値の優先', () => {
  assert.strictEqual(P.resolveMaxHr({ age: 40, maxHrMeasured: 190, useMeasuredMax: true }).value, 190);
  assert.strictEqual(P.resolveMaxHr({ age: 40, maxHrMeasured: 190, useMeasuredMax: false }).value, 180);
});
t('ゾーン境界（ACSM %HRmax）', () => {
  assert.strictEqual(P.zoneFor(56).key, 'very-light');
  assert.strictEqual(P.zoneFor(57).key, 'light');
  assert.strictEqual(P.zoneFor(63).key, 'light');
  assert.strictEqual(P.zoneFor(64).key, 'moderate');
  assert.strictEqual(P.zoneFor(76).key, 'moderate');
  assert.strictEqual(P.zoneFor(77).key, 'vigorous');
  assert.strictEqual(P.zoneFor(95).key, 'vigorous');
  assert.strictEqual(P.zoneFor(96).key, 'near-max');
  assert.strictEqual(P.zoneFor(120).key, 'near-max');
});

const T0 = Date.UTC(2026, 9, 26, 1, 0, 0);
function series(from, to, f, step = 1000) { const out = []; for (let t = from; t <= to; t += step) out.push([t, f(t)]); return out; }

t('回復：60秒値（±2秒以内の最も近い実測）', () => {
  const s = series(T0 - 10000, T0 + 130000, (t) => t <= T0 ? 150 : Math.round(150 - (t - T0) / 2000));
  const r = P.computeRecovery(s, T0 + 300, [], T0 + 130000);
  assert.strictEqual(r.startHr, 150);
  assert.strictEqual(r.points[60].status, 'ok');
  assert.strictEqual(r.points[60].bpm, 120);
  assert.strictEqual(r.points[60].drop, 30);
  assert.strictEqual(r.points[30].drop, 15);
  assert.strictEqual(r.points[120].status, 'ok');
});
t('回復：まだ時刻に達していなければ pending', () => {
  const s = series(T0 - 5000, T0 + 40000, () => 140);
  const r = P.computeRecovery(s, T0, [], T0 + 40000);
  assert.strictEqual(r.points[30].status, 'ok');
  assert.strictEqual(r.points[60].status, 'pending');
});
t('回復：60秒付近の欠測は測定不足', () => {
  const s = series(T0 - 5000, T0 + 130000, () => 140).filter(([t]) => t < T0 + 57000 || t > T0 + 63000);
  const r = P.computeRecovery(s, T0, [], T0 + 130000);
  assert.strictEqual(r.points[60].status, 'insufficient');
});
t('回復：途中の5秒超の欠測は無効', () => {
  const s = series(T0 - 5000, T0 + 130000, () => 140).filter(([t]) => t < T0 + 20000 || t > T0 + 27000);
  const r = P.computeRecovery(s, T0, [], T0 + 130000);
  assert.strictEqual(r.points[30].status, 'invalid');
  assert.strictEqual(r.points[60].status, 'invalid');
});
t('回復：切断イベントで無効', () => {
  const s = series(T0 - 5000, T0 + 130000, () => 140);
  const r = P.computeRecovery(s, T0, [{ t: T0 + 90000, type: 'disconnect' }], T0 + 130000);
  assert.strictEqual(r.points[60].status, 'ok');
  assert.strictEqual(r.points[120].status, 'invalid');
});
t('回復：開始前2秒以内に実測がなければ no-start', () => {
  const s = series(T0 - 20000, T0 - 5000, () => 140).concat(series(T0 + 1000, T0 + 130000, () => 120));
  assert.strictEqual(P.computeRecovery(s, T0, [], T0 + 130000).points[60].status, 'no-start');
});
t('条件一致', () => {
  const a = { method: 'sitting', exercise: 'スクワット', weight: 60, reps: 10 };
  assert.strictEqual(P.conditionMatch(a, { method: 'sitting', exercise: ' ｽｸﾜｯﾄ ', weight: 60, reps: 10 }), 'same');
  assert.strictEqual(P.conditionMatch(a, { method: 'sitting', exercise: 'スクワット', weight: null, reps: 10 }), 'partial');
  assert.strictEqual(P.conditionMatch(a, { method: 'sitting', exercise: 'スクワット', weight: 70, reps: 10 }), 'none');
  assert.strictEqual(P.conditionMatch(a, { method: 'standing', exercise: 'スクワット', weight: 60, reps: 10 }), 'none');
  assert.strictEqual(P.conditionMatch({ method: 'sitting', exercise: '' }, { method: 'sitting', exercise: '' }), 'none');
});
t('比較でデモと実測を混ぜない・無効値を除く', () => {
  const rec = (id, drop, status = 'ok') => ({ id, method: 'sitting', exercise: 'x', weight: 1, reps: 1, startAt: T0 + drop, result: { points: { 60: { status, drop, bpm: 100 } } } });
  const hist = [
    { recovery: rec('a', 30), session: { source: 'h10' } },
    { recovery: rec('b', 20), session: { source: 'demo' } },
    { recovery: rec('c', 99, 'invalid'), session: { source: 'h10' } }
  ];
  const c = P.compareRecovery(rec('cur', 0), 'h10', hist);
  assert.strictEqual(c.same.n, 1); assert.strictEqual(c.same.mean, 30);
});

// ---- バックアップ ----
t('バックアップの往復', () => {
  const cust = { id: 'c1', name: '<img src=x onerror=alert(1)>', age: 40, memo: 'm', createdAt: T0, updatedAt: T0 };
  const sess = { id: 's1', customerId: 'c1', source: 'demo', status: 'complete', startedAt: T0, endedAt: T0 + 1000, samples: [[T0, 100], [T0 + 1000, 999]], events: [], recoveries: [] };
  const out = B.parseBackup(JSON.stringify(B.buildBackup([cust], [sess])));
  assert.strictEqual(out.customers[0].name, cust.name); // 文字列として保持（表示側はtextContent）
  assert.strictEqual(out.sessions[0].source, 'demo');
  assert.deepStrictEqual(out.sessions[0].samples, [[T0, 100]]); // 範囲外の値は捨てる
});
t('不正なバックアップを拒否', () => {
  assert.throws(() => B.parseBackup('not json'));
  assert.throws(() => B.parseBackup('{"format":"pulse-h10-backup","version":99,"customers":[],"sessions":[]}'));
  assert.throws(() => B.parseBackup('{"foo":1}'));
  const r = B.parseBackup(JSON.stringify({ format: 'pulse-h10-backup', version: 1, customers: [{ id: 'a', name: 5 }, { id: {}, name: 'x' }, { name: 'noid' }], sessions: [{ id: 's', customerId: 'zzz', startedAt: T0 }] }));
  assert.strictEqual(r.customers.length, 1); assert.strictEqual(r.sessions.length, 0);
});
t('旧形式（pulse-v2 キー付き文字列）', () => {
  const legacy = { 'pulse-v2': JSON.stringify({ customers: [{ id: 1, name: '山田', age: 50 }], sessions: [{ id: 9, customerId: 1, startedAt: T0, samples: [{ t: T0, bpm: 90 }] }] }) };
  const r = B.parseBackup(JSON.stringify(legacy));
  assert.strictEqual(r.legacy, true);
  assert.strictEqual(r.customers[0].id, '1');
  assert.strictEqual(r.sessions[0].samples[0][1], 90);
});
console.log(n + ' tests passed');

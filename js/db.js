/*
 * PULSE — IndexedDB 保存（このブラウザ内のみ。サーバーへは送信しない）
 * customers: { id, name, age, memo, restingHr, maxHrMeasured, useMeasuredMax, isDemo, todayPre, createdAt, updatedAt }
 * sessions : { id, customerId, source('h10'|'demo'), status('active'|'complete'|'interrupted'),
 *              startedAt, endedAt, maxHr, maxHrSource, preHr, samples[[t,bpm]], events[], recoveries[], activeRecovery }
 */
(function (root) {
  'use strict';
  const NAME = 'pulse-h10';
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('このブラウザではIndexedDBが使えません')); return; }
      const req = root.indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains('customers')) db.createObjectStore('customers', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sessions')) {
          const s = db.createObjectStore('sessions', { keyPath: 'id' });
          s.createIndex('customerId', 'customerId', { unique: false });
        }
      };
      req.onsuccess = function () {
        const db = req.result;
        db.onversionchange = function () { db.close(); };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('データベースを開けませんでした')); };
      req.onblocked = function () { reject(new Error('別のタブがデータベースを使用中です')); };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  // body(tx) は同期的にリクエストを発行し、結果を受け取る関数を返す。完了は oncomplete で判定する。
  function run(stores, mode, body) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        let tx;
        try { tx = db.transaction(stores, mode); } catch (e) { reject(e); return; }
        let getResult = null;
        try { getResult = body(tx); } catch (e) { try { tx.abort(); } catch (_) { /* noop */ } reject(e); return; }
        tx.oncomplete = function () { resolve(typeof getResult === 'function' ? getResult() : undefined); };
        tx.onerror = function () { reject(tx.error || new Error('保存に失敗しました')); };
        tx.onabort = function () { reject(tx.error || new Error('保存が中断されました（容量不足の可能性）')); };
      });
    });
  }

  function reqResult(req) { let v; req.onsuccess = function () { v = req.result; }; return function () { return v; }; }

  const PulseDB = {
    open: open,
    getAll: function (store) {
      return run([store], 'readonly', function (tx) { return reqResult(tx.objectStore(store).getAll()); });
    },
    get: function (store, id) {
      return run([store], 'readonly', function (tx) { return reqResult(tx.objectStore(store).get(id)); });
    },
    put: function (store, obj) {
      return run([store], 'readwrite', function (tx) { tx.objectStore(store).put(obj); });
    },
    remove: function (store, id) {
      return run([store], 'readwrite', function (tx) { tx.objectStore(store).delete(id); });
    },
    sessionsByCustomer: function (customerId) {
      return run(['sessions'], 'readonly', function (tx) {
        return reqResult(tx.objectStore('sessions').index('customerId').getAll(customerId));
      });
    },
    deleteCustomer: function (customerId) {
      return run(['customers', 'sessions'], 'readwrite', function (tx) {
        tx.objectStore('customers').delete(customerId);
        const idx = tx.objectStore('sessions').index('customerId');
        const cur = idx.openKeyCursor(IDBKeyRange.only(customerId));
        cur.onsuccess = function () {
          const c = cur.result;
          if (c) { tx.objectStore('sessions').delete(c.primaryKey); c.continue(); }
        };
      });
    },
    // 既存データを消さずに追加する。同じIDが既にあるものはスキップする。
    importMerge: function (customers, sessions) {
      return run(['customers', 'sessions'], 'readwrite', function (tx) {
        const counts = { customersAdded: 0, customersSkipped: 0, sessionsAdded: 0, sessionsSkipped: 0 };
        const cs = tx.objectStore('customers'), ss = tx.objectStore('sessions');
        customers.forEach(function (c) {
          const r = cs.add(c);
          r.onsuccess = function () { counts.customersAdded++; };
          r.onerror = function (e) { e.preventDefault(); e.stopPropagation(); counts.customersSkipped++; };
        });
        sessions.forEach(function (s) {
          const r = ss.add(s);
          r.onsuccess = function () { counts.sessionsAdded++; };
          r.onerror = function (e) { e.preventDefault(); e.stopPropagation(); counts.sessionsSkipped++; };
        });
        return function () { return counts; };
      });
    }
  };

  root.PulseDB = PulseDB;
})(window);

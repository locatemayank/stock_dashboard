/* ══════════════════════════════════════════════════════════════════
   stock_db.js — Robust local data layer for the Stock Dashboard /
   Portfolio Predictor PWAs.

   Goals
   ─────
   1. Persist portfolio, settings (API keys, currency) AND the latest
      fetched API data (prices, metrics, ratings, price-targets, F&G…)
      in IndexedDB so nothing is lost when the browser evicts the
      lighter-weight localStorage or when the device is offline.
   2. Keep a synchronous localStorage mirror so existing code that reads
      localStorage keeps working with zero refactor.
   3. Auto-restore localStorage from IndexedDB on boot (in case the
      volatile localStorage was cleared but the sturdier IndexedDB
      survived — or vice-versa).
   4. Offer Export (download a .json backup) and Import (restore from a
      previously-saved backup file) so the user always has an off-device
      copy — the ultimate protection against cache loss.
   5. Request persistent storage so the browser is less likely to evict
      the data at all.

   The module attaches a single global: window.StockDB
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var DB_NAME    = 'stockDashDB';
  var DB_VERSION = 1;
  var STORE_KV   = 'kv';      // key/value: portfolio, settings
  var STORE_CACHE= 'cache';   // cached API payloads keyed by name

  // localStorage keys that must be mirrored/backed-up. These are the keys
  // both apps already use; kept in one place so backups stay consistent.
  var MIRRORED_LS_KEYS = [
    'stockDash_portfolio_v1',
    'stockDash_finnhub_v1',
    'stockDash_currency_v1',
    'stockDash_av_v1',
    'stockDash_sheet_v1'
  ];

  var _db = null;
  var _readyResolvers = [];
  var _ready = false;

  /* ── Low-level IndexedDB helpers ─────────────────────────────── */
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_KV))    db.createObjectStore(STORE_KV);
        if (!db.objectStoreNames.contains(STORE_CACHE)) db.createObjectStore(STORE_CACHE);
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
  }

  function idbPut(store, key, val) {
    return new Promise(function (resolve, reject) {
      if (!_db) { resolve(false); return; }
      try {
        var tx = _db.transaction(store, 'readwrite');
        tx.objectStore(store).put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror    = function (e) { reject(e.target.error); };
      } catch (err) { reject(err); }
    });
  }

  function idbGet(store, key) {
    return new Promise(function (resolve, reject) {
      if (!_db) { resolve(undefined); return; }
      try {
        var tx = _db.transaction(store, 'readonly');
        var rq = tx.objectStore(store).get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror   = function (e) { reject(e.target.error); };
      } catch (err) { reject(err); }
    });
  }

  function idbGetAll(store) {
    return new Promise(function (resolve, reject) {
      if (!_db) { resolve({}); return; }
      try {
        var tx = _db.transaction(store, 'readonly');
        var os = tx.objectStore(store);
        var out = {};
        var cursorReq = os.openCursor();
        cursorReq.onsuccess = function (e) {
          var cur = e.target.result;
          if (cur) { out[cur.key] = cur.value; cur.continue(); }
          else resolve(out);
        };
        cursorReq.onerror = function (e) { reject(e.target.error); };
      } catch (err) { reject(err); }
    });
  }

  /* ── Boot: open DB, hydrate localStorage, request persistence ── */
  function init() {
    return openDB().then(function (db) {
      _db = db;
      return hydrateFromIDB();
    }).then(function () {
      requestPersistence();
      _ready = true;
      _readyResolvers.forEach(function (r) { r(); });
      _readyResolvers = [];
      return true;
    }).catch(function (err) {
      // IndexedDB unavailable (private mode etc.) — degrade gracefully to
      // pure localStorage. Everything still works, just less robust.
      console.warn('StockDB: IndexedDB init failed, using localStorage only.', err);
      _ready = true;
      _readyResolvers.forEach(function (r) { r(); });
      _readyResolvers = [];
      return false;
    });
  }

  function ready() {
    if (_ready) return Promise.resolve();
    return new Promise(function (resolve) { _readyResolvers.push(resolve); });
  }

  /* Copy any IDB-stored settings into localStorage when localStorage is
     missing them (i.e. localStorage was evicted but IDB survived), and
     conversely push localStorage values into IDB when IDB is empty. */
  function hydrateFromIDB() {
    return idbGetAll(STORE_KV).then(function (kv) {
      MIRRORED_LS_KEYS.forEach(function (key) {
        var lsVal  = safeLSget(key);
        var idbVal = kv[key];
        if ((lsVal === null || lsVal === undefined) && idbVal !== undefined && idbVal !== null) {
          // Restore evicted localStorage from durable IndexedDB copy
          safeLSset(key, idbVal);
        } else if (lsVal !== null && lsVal !== undefined && (idbVal === undefined || idbVal === null)) {
          // Seed IndexedDB from existing localStorage
          idbPut(STORE_KV, key, lsVal);
        }
      });
    });
  }

  function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persisted().then(function (already) {
          if (!already) navigator.storage.persist();
        });
      }
    } catch (e) { /* ignore */ }
  }

  /* ── Safe localStorage wrappers ─────────────────────────────── */
  function safeLSget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeLSset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ── Public: settings (mirrored key/value strings) ──────────── */
  // Write to both localStorage (sync, for legacy reads) and IndexedDB (durable)
  function setItem(key, value) {
    safeLSset(key, value);
    return idbPut(STORE_KV, key, value);
  }
  function getItem(key) { return safeLSget(key); }

  /* ── Public: cached API data ────────────────────────────────
     Store larger, frequently-refreshed payloads (price snapshots,
     metrics, ratings, price targets, fear & greed, exchange rates…)
     with a timestamp so the app can show last-known values offline. */
  function cacheSet(name, data) {
    return idbPut(STORE_CACHE, name, { ts: Date.now(), data: data });
  }
  function cacheGet(name) {
    return idbGet(STORE_CACHE, name).then(function (rec) {
      return rec || null; // {ts, data} or null
    });
  }

  /* ── Public: full backup / restore ──────────────────────────── */
  function buildBackupObject() {
    return Promise.all([idbGetAll(STORE_KV), idbGetAll(STORE_CACHE)])
      .then(function (res) {
        var kv = res[0] || {};
        var cache = res[1] || {};
        // Ensure the mirrored localStorage keys are captured even if IDB
        // hasn't been written yet this session.
        MIRRORED_LS_KEYS.forEach(function (key) {
          var lsVal = safeLSget(key);
          if (lsVal !== null && lsVal !== undefined) kv[key] = lsVal;
        });
        return {
          app: 'stock-dashboard',
          type: 'stockDashBackup',
          version: 1,
          exportedAt: new Date().toISOString(),
          kv: kv,
          cache: cache
        };
      });
  }

  function exportBackup() {
    return buildBackupObject().then(function (obj) {
      var json = JSON.stringify(obj, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = 'portfolio-predictor-backup-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return obj;
    });
  }

  // Restore from a parsed backup object. Writes into both IndexedDB and
  // localStorage so the running app + future sessions both see the data.
  function importBackupObject(obj) {
    if (!obj || (obj.type !== 'stockDashBackup' && !obj.kv)) {
      return Promise.reject(new Error('Not a valid Stock Dashboard backup file.'));
    }
    var kv = obj.kv || {};
    var cache = obj.cache || {};
    var ops = [];
    Object.keys(kv).forEach(function (key) {
      var val = kv[key];
      // kv values are stored as strings (localStorage-style); coerce objects
      if (typeof val !== 'string') val = JSON.stringify(val);
      safeLSset(key, val);
      ops.push(idbPut(STORE_KV, key, val));
    });
    Object.keys(cache).forEach(function (name) {
      ops.push(idbPut(STORE_CACHE, name, cache[name]));
    });
    return Promise.all(ops).then(function () { return obj; });
  }

  function importBackupFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var obj = JSON.parse(reader.result);
          resolve(importBackupObject(obj));
        } catch (e) { reject(new Error('Could not parse backup file: ' + e.message)); }
      };
      reader.onerror = function () { reject(new Error('Could not read file.')); };
      reader.readAsText(file);
    });
  }

  /* ── Expose API ─────────────────────────────────────────────── */
  global.StockDB = {
    init: init,
    ready: ready,
    setItem: setItem,
    getItem: getItem,
    cacheSet: cacheSet,
    cacheGet: cacheGet,
    exportBackup: exportBackup,
    importBackupFile: importBackupFile,
    importBackupObject: importBackupObject,
    buildBackupObject: buildBackupObject,
    MIRRORED_LS_KEYS: MIRRORED_LS_KEYS
  };

})(typeof window !== 'undefined' ? window : this);

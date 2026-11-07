'use strict';

const DB_NAME = 'jarvis-journal';
const DB_VERSION = 2;
const STORES = ['trades', 'reasons', 'transactions', 'settings', 'screenshots'];
const SETTINGS_KEY = 'app-settings';
const META_KEY = 'meta';

function uid() {
  if (self.crypto && typeof self.crypto.randomUUID === 'function') return self.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error('IndexedDB is not available in this browser.'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open database.'));
    req.onblocked = () => reject(new Error('Database upgrade blocked by another open tab. Close other tabs and retry.'));
  });
}

function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function safeStr(v, max = 10000) {
  if (v == null) return '';
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}
function isDataImage(v) {
  return typeof v === 'string' && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(v);
}

function sanitizeTrade(t, reasonIdsValid) {
  const valid = reasonIdsValid instanceof Set ? reasonIdsValid : null;
  const reasonIds = Array.isArray(t.reasonIds)
    ? [...new Set(t.reasonIds.filter(id => typeof id === 'string'))]
    : [];
  const timeframes = Array.isArray(t.timeframes)
    ? [...new Set(t.timeframes.filter(x => typeof x === 'string').map(x => safeStr(x, 12)))]
    : [];
  const screenshots = Array.isArray(t.screenshots)
    ? t.screenshots
        .filter(s => s && isDataImage(s.data))
        .map(s => ({
          name: safeStr(s.name, 200),
          data: s.data,
          tf: safeStr(s.tf, 12),
          reasonIds: Array.isArray(s.reasonIds) ? s.reasonIds.filter(id => typeof id === 'string') : []
        }))
    : [];
  const reasonNames = {};
  if (t.reasonNames && typeof t.reasonNames === 'object') {
    for (const [k, v] of Object.entries(t.reasonNames)) {
      if (typeof k === 'string') reasonNames[k] = safeStr(v, 200);
    }
  }
  const result = ['WIN', 'LOSS', 'OPEN'].includes(t.result) ? t.result : 'OPEN';
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    pair: safeStr(t.pair, 40).trim().toUpperCase(),
    date: safeStr(t.date, 40),
    timeZone: safeStr(t.timeZone, 80) || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    direction: t.direction === 'PUT' ? 'PUT' : 'CALL',
    result,
    risk: clamp(num(t.risk), 0, 1e9),
    payout: clamp(num(t.payout), 0, 1000),
    confidence: t.confidence == null || t.confidence === '' ? null : clamp(num(t.confidence), 1, 10),
    session: safeStr(t.session, 40) || 'Custom',
    condition: safeStr(t.condition, 40) || 'Unspecified',
    category: t.category === 'Multi-timeframe' ? 'Multi-timeframe' : 'Single-timeframe',
    setupQuality: t.setupQuality == null || t.setupQuality === '' ? null : clamp(num(t.setupQuality), 1, 10),
    executionQuality: t.executionQuality == null || t.executionQuality === '' ? null : clamp(num(t.executionQuality), 1, 10),
    reasonIds,
    timeframes,
    screenshots,
    notes: safeStr(t.notes, 5000),
    mood: t.mood && typeof t.mood === 'object'
      ? { tired: !!t.mood.tired, anxious: !!t.mood.anxious, good: !!t.mood.good, great: !!t.mood.great }
      : null,
    createdAt: num(t.createdAt, Date.now()),
    updatedAt: num(t.updatedAt, Date.now()),
    reasonNames
  };
}

function sanitizeReason(r) {
  return {
    id: typeof r.id === 'string' && r.id ? r.id : uid(),
    name: safeStr(r.name, 200).trim() || 'Unnamed reason',
    active: r.active !== false
  };
}

function sanitizeTransaction(t) {
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    type: ['Deposit', 'Withdrawal', 'Adjustment'].includes(t.type) ? t.type : 'Adjustment',
    amount: clamp(num(t.amount), 0, 1e9),
    date: safeStr(t.date, 40),
    note: safeStr(t.note, 500)
  };
}

function sanitizeSettings(s) {
  const c = ['USD', 'EUR', 'GBP'];
  return {
    startingBalance: clamp(num(s.startingBalance, 70), 0, 1e9),
    defaultPayout: clamp(num(s.defaultPayout, 80), 0, 1000),
    currency: c.includes(s.currency) ? s.currency : 'USD',
    defaultSession: safeStr(s.defaultSession, 40) || 'New York'
  };
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}
function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const Storage = {
  db: null,

  async init() {
    this.db = await openDB();
  },

  async getAllTrades() {
    const tx = this.db.transaction('trades', 'readonly');
    return reqPromise(tx.objectStore('trades').getAll());
  },
  async putTrade(t) {
    const tx = this.db.transaction('trades', 'readwrite');
    tx.objectStore('trades').put(t);
    return txPromise(tx);
  },
  async deleteTrade(id) {
    const tx = this.db.transaction('trades', 'readwrite');
    tx.objectStore('trades').delete(id);
    return txPromise(tx);
  },

  async getAllReasons() {
    const tx = this.db.transaction('reasons', 'readonly');
    return reqPromise(tx.objectStore('reasons').getAll());
  },
  async putReason(r) {
    const tx = this.db.transaction('reasons', 'readwrite');
    tx.objectStore('reasons').put(r);
    return txPromise(tx);
  },
  async putReasons(list) {
    const tx = this.db.transaction('reasons', 'readwrite');
    const s = tx.objectStore('reasons');
    list.forEach(r => s.put(r));
    return txPromise(tx);
  },

  async getAllTransactions() {
    const tx = this.db.transaction('transactions', 'readonly');
    return reqPromise(tx.objectStore('transactions').getAll());
  },
  async putTransaction(t) {
    const tx = this.db.transaction('transactions', 'readwrite');
    tx.objectStore('transactions').put(t);
    return txPromise(tx);
  },

  async getSettings() {
    const tx = this.db.transaction('settings', 'readonly');
    const rec = await reqPromise(tx.objectStore('settings').get(SETTINGS_KEY));
    return rec ? rec.value : null;
  },
  async putSettings(s) {
    const tx = this.db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ id: SETTINGS_KEY, value: s });
    return txPromise(tx);
  },

  async getMeta() {
    const tx = this.db.transaction('settings', 'readonly');
    const rec = await reqPromise(tx.objectStore('settings').get(META_KEY));
    return rec ? rec.value : null;
  },
  async putMeta(m) {
    const tx = this.db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ id: META_KEY, value: m });
    return txPromise(tx);
  },

  async importAll(payload, opts = {}) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid backup: no data object.');
    const rawReasons = Array.isArray(payload.reasons) ? payload.reasons : [];
    const reasons = rawReasons.map(sanitizeReason);
    const reasonIds = new Set(reasons.map(r => r.id));
    const trades = (Array.isArray(payload.trades) ? payload.trades : []).map(t =>
      sanitizeTrade(t, reasonIds)
    );
    const transactions = (Array.isArray(payload.transactions) ? payload.transactions : []).map(sanitizeTransaction);
    const settings = sanitizeSettings(payload.settings || {});

    const tx = this.db.transaction(STORES, 'readwrite');
    const stores = STORES.map(n => tx.objectStore(n));
    const [tSt, rSt, xSt, sSt, shSt] = stores;
    tSt.clear(); rSt.clear(); xSt.clear(); shSt.clear();
    trades.forEach(t => tSt.put(t));
    reasons.forEach(r => rSt.put(r));
    transactions.forEach(x => xSt.put(x));
    sSt.put({ id: SETTINGS_KEY, value: settings });
    sSt.put({ id: META_KEY, value: { schemaVersion: 2, importedAt: Date.now() } });
    return txPromise(tx);
  },

  async exportAll() {
    const [trades, reasons, transactions, settings, meta] = await Promise.all([
      this.getAllTrades(), this.getAllReasons(), this.getAllTransactions(),
      this.getSettings(), this.getMeta()
    ]);
    return {
      app: 'Jarvis',
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      data: { trades, reasons, transactions, settings: settings || sanitizeSettings({}), meta: meta || null }
    };
  }
};

window.JarvisStorage = Storage;
window.JarvisUtil = { uid, num, clamp, safeStr, isDataImage, sanitizeTrade, sanitizeReason, sanitizeTransaction, sanitizeSettings };
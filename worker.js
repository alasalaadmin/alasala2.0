/* worker.js — the phone's local "server": runs the rules and keeps the encrypted data, off the screen's thread. */
'use strict';
importScripts('./js/crypto.js', './js/bundle.js', './js/spot.js', './js/gas-env.js', './js/formulas.js', './js/gas-bundle.js', './js/engine.js', './js/core.js');

const DB = 'alasala-offline', STORE = 'kv';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
let dbp = null;
const db = () => (dbp = dbp || idb());
function tx(mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode); const s = t.objectStore(STORE);
    const req = fn(s);
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted'));
  }));
}
const kv = {
  get: (k) => tx('readonly', (s) => s.get(k)),
  set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
  del: (k) => tx('readwrite', (s) => s.delete(k))
};

const core = new self.PhoneCore.Core({ kv });
const METHODS = ['status', 'join', 'joinText', 'enroll', 'unlock', 'lock', 'changeSecret', 'wipe', 'api', 'makeBundle', 'applyReply', 'applyIncoming', 'collect', 'packFor', 'info', 'details', 'spotStart', 'spotCancel', 'spotRead', 'spotDecide', 'spotFinish'];

let queue = Promise.resolve();   // one operation at a time: no two changes can interleave
self.onmessage = (e) => {
  const { id, method, args } = e.data || {};
  if (METHODS.indexOf(method) === -1) { self.postMessage({ id, error: { code: 'BAD_INPUT', message: 'unknown method' } }); return; }
  queue = queue.then(async () => {
    try {
      const result = await core[method].apply(core, args || []);
      self.postMessage({ id, result: result === undefined ? null : result });
    } catch (err) {
      self.postMessage({ id, error: { code: err && err.code ? err.code : 'ERROR', message: err && err.message ? err.message : String(err) } });
    }
  });
};

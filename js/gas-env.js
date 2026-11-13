/**
 * gas-env.js — an offline stand-in for the Google Apps Script services used by API.gs.
 * Same file runs on the master station (Node) and on phones (Web Worker).
 *
 * The spreadsheet lives in memory as a "book": one Sheet per tab, each row an array of cell
 * values plus a permanent row id (uid). Every change made while an action runs is written to
 * a journal (before / after image of each row), which the master stores and can undo.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GasEnv = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------------------------------------------------------------- utilities
  function randomHex(n) {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function newUid() { return 'r' + Date.now().toString(36) + randomHex(5); }
  const isEmpty = (v) => v === '' || v === null || v === undefined;

  // JSON encoding of cell values (Dates survive storage)
  function encodeCell(v) { return v instanceof Date ? { $d: v.toISOString() } : v; }
  function decodeCell(v) { return v && typeof v === 'object' && typeof v.$d === 'string' ? new Date(v.$d) : v; }
  function encodeRow(r) { return r.map(encodeCell); }
  function decodeRow(r) { return (r || []).map(decodeCell); }

  // ---- SHA-256 (synchronous; Apps Script's computeDigest is synchronous)
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(bytes) {
    const l = bytes.length, withPad = ((l + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(withPad); m.set(bytes); m[l] = 0x80;
    const bits = l * 8; const dv = new DataView(m.buffer);
    dv.setUint32(withPad - 4, bits >>> 0); dv.setUint32(withPad - 8, Math.floor(bits / 4294967296));
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let o = 0; o < withPad; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32); const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
    return out;
  }
  const utf8 = (s) => new TextEncoder().encode(String(s));
  const signed = (bytes) => Array.from(bytes, (x) => (x > 127 ? x - 256 : x));
  const unsigned = (arr) => Uint8Array.from(arr, (x) => x & 255);
  function b64enc(bytes) {
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64dec(str) { const s = atob(str); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; }

  // ---- dates in a named time zone (the script's)
  const fmtCache = {};
  function parts(d, tz) {
    let f = fmtCache[tz];
    if (!f) {
      f = fmtCache[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
      });
    }
    const o = {};
    f.formatToParts(d).forEach((p) => { o[p.type] = p.value; });
    return o;
  }
  function formatDate(d, tz, pattern) {
    if (!(d instanceof Date) || isNaN(d.getTime())) throw new Error('Invalid date');
    const p = parts(d, tz || 'UTC');
    const map = { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, H: String(Number(p.hour)), mm: p.minute, ss: p.second, EEE: p.weekday };
    return pattern.replace(/yyyy|MM|dd|HH|H|mm|ss|EEE/g, (t) => map[t]);
  }

  // display value of a cell, the way the sheet shows it (sheet time zone is GMT)
  function displayOf(v) {
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return '';
      const iso = v.toISOString();
      if (v.getUTCFullYear() === 1899) return iso.slice(11, 16);                // time of day
      if (iso.slice(11, 19) === '00:00:00') return iso.slice(0, 10);
      return iso.slice(0, 10) + ' ' + iso.slice(11, 19);
    }
    if (isEmpty(v)) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }

  // ---------------------------------------------------------------- A1 helpers
  function colNum(L) { let n = 0; for (const ch of L) n = n * 26 + ch.charCodeAt(0) - 64; return n; }

  // ---------------------------------------------------------------- sheet model
  class Range {
    constructor(sheet, r, c, nr, nc) { this.s = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
    getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.s.get(this.r + i, this.c + j)); o.push(row); } return o; }
    getValue() { return this.s.get(this.r, this.c); }
    getDisplayValues() { return this.getValues().map((r) => r.map(displayOf)); }
    getDisplayValue() { return displayOf(this.getValue()); }
    setValues(arr) {
      if (!Array.isArray(arr) || arr.length !== this.nr || arr.some((r) => !Array.isArray(r) || r.length !== this.nc)) {
        throw new Error('The number of rows or columns in the data does not match the range.');
      }
      for (let i = 0; i < arr.length; i++) for (let j = 0; j < arr[i].length; j++) this.s.set(this.r + i, this.c + j, arr[i][j]);
      return this;
    }
    setValue(v) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.s.set(this.r + i, this.c + j, v); return this; }
    clearContent() { return this.setValue(''); }
    getFormula() { return ''; }
    getFormulas() { const o = []; for (let i = 0; i < this.nr; i++) o.push(new Array(this.nc).fill('')); return o; }
    getDataValidations() {
      const o = [];
      for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.s.validationAt(this.r + i, this.c + j)); o.push(row); }
      return o;
    }
    getDataValidation() { return this.s.validationAt(this.r, this.c); }
    setDataValidation() { return this; }
    clearDataValidations() { return this; }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setFontColor() { return this; }
    setWrap() { return this; }
    setHorizontalAlignment() { return this; }
    copyTo() { return this; }        // formulas, formats and validations are not copied offline (see formulas.js)
    getRow() { return this.r; }
    getColumn() { return this.c; }
    getNumRows() { return this.nr; }
    getNumColumns() { return this.nc; }
    getSheet() { return this.s; }
  }

  class Sheet {
    constructor(book, name, rows, opts) {
      opts = opts || {};
      this.book = book; this.name = name;
      this.data = (rows || []).map((r) => r.slice());
      this.uids = opts.uids ? opts.uids.slice() : this.data.map(() => newUid());
      this.hidden = !!opts.hidden;
      this.validations = opts.validations || [];
      this.formulaCols = opts.formulas || {};
      this._dims = null;
    }
    getName() { return this.name; }
    setName(n) { this.book.journal.renamed.push([this.name, n]); this.name = n; return this; }
    getSheetId() { return this.name; }
    _touch(rowIdx) {
      // first change of a row in this action: keep its "before" image
      while (this.uids.length < this.data.length) this.uids.push(newUid());
      const uid = this.uids[rowIdx];
      const j = this.book.journal;
      const key = this.name + '\u0000' + uid;
      if (!j.rows.has(key)) j.rows.set(key, { sheet: this.name, uid, pos0: rowIdx, before: j.newRows.has(key) ? null : encodeRow(this.data[rowIdx] || []) });
      this._dims = null;
      this.book.changed = true; this.book.version++;
    }
    get(r, c) { const row = this.data[r - 1]; if (!row) return ''; const v = row[c - 1]; return v === undefined || v === null ? '' : v; }
    set(r, c, v) {
      if (r < 1 || c < 1) throw new Error('Range out of bounds');
      if (r > 200000 || c > 200) throw new Error('Range too large');
      this._grow(r);
      if (typeof v === 'string' && v.charAt(0) === "'") v = v.slice(1);          // Sheets: a leading ' forces text and is not stored
      if (v === undefined || v === null) v = '';
      const row = this.data[r - 1];
      const cur = row[c - 1] === undefined ? '' : row[c - 1];
      if (cur === v || (cur instanceof Date && v instanceof Date && cur.getTime() === v.getTime())) return;
      this._touch(r - 1);
      while (row.length < c) row.push('');
      row[c - 1] = v;
    }
    _grow(r) {
      while (this.data.length < r) {
        this.data.push([]);
        const uid = newUid(); this.uids.push(uid);
        this.book.journal.newRows.add(this.name + '\u0000' + uid);
        this.book.journal.structure.add(this.name);
      }
    }
    _usedDims() {
      if (this._dims) return this._dims;
      let lr = 0, lc = 0;
      for (let i = 0; i < this.data.length; i++) {
        const row = this.data[i];
        for (let j = row.length - 1; j >= 0; j--) if (!isEmpty(row[j])) { lr = i + 1; if (j + 1 > lc) lc = j + 1; break; }
      }
      this._dims = { lr, lc };
      return this._dims;
    }
    getLastRow() { return this._usedDims().lr; }
    getLastColumn() { return this._usedDims().lc; }
    getMaxRows() { return Math.max(this.data.length, 1); }
    getMaxColumns() { return Math.max(26, this._usedDims().lc); }
    getDataRange() { const u = this._usedDims(); return new Range(this, 1, 1, Math.max(u.lr, 1), Math.max(u.lc, 1)); }
    getRange(r, c, nr, nc) {
      if (typeof r === 'string') {
        const s = r.replace(/\$/g, '');
        let m = /^([A-Z]+)(\d*):([A-Z]+)(\d*)$/.exec(s);
        if (m) {
          const c1 = colNum(m[1]), c2 = colNum(m[3]);
          const r1 = m[2] ? Number(m[2]) : 1, r2 = m[4] ? Number(m[4]) : this.getMaxRows();
          return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
        }
        m = /^([A-Z]+)(\d+)$/.exec(s);
        if (m) return new Range(this, Number(m[2]), colNum(m[1]), 1, 1);
        throw new Error('Unsupported range ' + r);
      }
      if (!(r >= 1) || !(c >= 1)) throw new Error('Range out of bounds');
      return new Range(this, r, c, nr || 1, nc || 1);
    }
    insertRowsAfter(after, n) {
      for (let i = 0; i < n; i++) {
        const uid = newUid();
        this.data.splice(after + i, 0, []);
        this.uids.splice(after + i, 0, uid);
        this.book.journal.newRows.add(this.name + '\u0000' + uid);
      }
      this.book.journal.structure.add(this.name); this._dims = null; this.book.changed = true; this.book.version++;
      return this;
    }
    /** Puts back a row that was removed earlier, with its permanent id (used to restore hidden rows). */
    restoreRow(at, uid, row) {
      at = Math.max(1, Math.min(at, this.data.length));
      this.data.splice(at, 0, row.slice()); this.uids.splice(at, 0, uid);
      const key = this.name + '\u0000' + uid;
      this.book.journal.newRows.add(key);
      this.book.journal.rows.set(key, { sheet: this.name, uid, pos0: at, before: null });
      this.book.journal.structure.add(this.name); this._dims = null; this.book.changed = true; this.book.version++;
      return this;
    }
    insertRowsBefore(before, n) { return this.insertRowsAfter(before - 1, n); }
    insertRowAfter(after) { return this.insertRowsAfter(after, 1); }
    insertColumnsAfter() { return this; }
    appendRow(arr) { const r = this.getLastRow() + 1; arr.forEach((v, j) => this.set(r, j + 1, v)); return this; }
    deleteRow(r) { return this.deleteRows(r, 1); }
    deleteRows(r, n) {
      for (let k = 0; k < n; k++) {
        const idx = r - 1;
        if (idx >= this.data.length) break;
        this._touch(idx);
        const uid = this.uids[idx];
        this.book.journal.deleted.add(this.name + '\u0000' + uid);
        this.data.splice(idx, 1); this.uids.splice(idx, 1);
      }
      this.book.journal.structure.add(this.name); this._dims = null; this.book.changed = true; this.book.version++;
      return this;
    }
    clear() { for (let i = 0; i < this.data.length; i++) { if (this.data[i].some((v) => !isEmpty(v))) { this._touch(i); this.data[i] = []; } } return this; }
    clearContents() { return this.clear(); }
    setRightToLeft() { return this; }
    setFrozenRows() { return this; }
    setFrozenColumns() { return this; }
    setColumnWidth() { return this; }
    autoResizeColumns() { return this; }
    hideSheet() { this.hidden = true; return this; }
    isSheetHidden() { return this.hidden; }
    getParent() { return this.book; }
    validationAt(r, c) {
      for (const v of this.validations) {
        if (r >= v.r1 && r <= v.r2 && c >= v.c1 && c <= v.c2) {
          const list = v.list.slice();
          return { getCriteriaType: () => 'VALUE_IN_LIST', getCriteriaValues: () => [list, true] };
        }
      }
      return null;
    }
    copyTo(book) { const s = book.insertSheet('نسخة من ' + this.name); this.data.forEach((row, i) => row.forEach((v, j) => s.set(i + 1, j + 1, v))); return s; }
  }

  class Book {
    constructor(json) {
      this.sheets = [];
      this.changed = false;
      this.version = 0;          // goes up at every change (the master's full views rebuild their copy when it moves)
      this.resetJournal();
      (json && json.sheets ? json.sheets : []).forEach((s) => {
        this.sheets.push(new Sheet(this, s.name, (s.rows || []).map(decodeRow), { uids: s.uids, hidden: s.hidden, validations: s.validations, formulas: s.formulas }));
      });
      this.resetJournal();
    }
    resetJournal() { this.journal = { rows: new Map(), newRows: new Set(), deleted: new Set(), structure: new Set(), addedSheets: [], removedSheets: [], renamed: [] }; this.changed = false; }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    getActiveSheet() { return this.sheets[0] || null; }
    getId() { return 'offline'; }
    getUrl() { return ''; }
    getName() { return 'Alasala'; }
    insertSheet(n) {
      if (this.getSheetByName(n)) throw new Error('A sheet with the name "' + n + '" already exists.');
      const s = new Sheet(this, n, [], {});
      this.sheets.push(s); this.journal.addedSheets.push(n); this.journal.structure.add(n); this.changed = true; this.version++;
      return s;
    }
    deleteSheet(s) {
      const i = this.sheets.indexOf(s);
      if (i === -1) return;
      s.data.forEach((row, idx) => s._touch(idx));
      s.uids.forEach((u) => this.journal.deleted.add(s.name + '\u0000' + u));
      this.sheets.splice(i, 1); this.journal.removedSheets.push(s.name); this.changed = true; this.version++;
    }
    /** Changes made since the last resetJournal(): what the master stores (and can undo). */
    takeJournal() {
      const j = this.journal;
      const out = { rows: [], structure: Array.from(j.structure), addedSheets: j.addedSheets.slice(), removedSheets: j.removedSheets.slice(), renamed: j.renamed.slice() };
      j.rows.forEach((e, key) => {
        const deleted = j.deleted.has(key);
        let after = null, pos = -1;
        if (!deleted) {
          const sh = this.getSheetByName(e.sheet);
          if (sh) { pos = sh.uids.indexOf(e.uid); if (pos !== -1) after = encodeRow(sh.data[pos] || []); }
        }
        out.rows.push({ sheet: e.sheet, uid: e.uid, before: e.before, after, pos, pos0: e.pos0, deleted });
      });
      this.resetJournal();
      return out;
    }
    toJSON() {
      return {
        format: 'alasala-book/1',
        sheets: this.sheets.map((s) => {
          // trailing empty rows are not kept
          let n = s.data.length; while (n > 0 && !s.data[n - 1].some((v) => !isEmpty(v))) n--;
          return { name: s.name, hidden: s.hidden, validations: s.validations, formulas: s.formulaCols, uids: s.uids.slice(0, n), rows: s.data.slice(0, n).map(encodeRow) };
        })
      };
    }
  }

  // ---------------------------------------------------------------- services
  /**
   * makeEnv(book, opts) -> the globals API.gs expects.
   * opts.tz         script time zone (default Africa/Tunis)
   * opts.props      Map-like store for PropertiesService (kept by the caller)
   * opts.now        function returning the current time in ms (replays use the original time)
   * opts.log        function(msg)
   */
  function makeEnv(book, opts) {
    opts = opts || {};
    const tz = opts.tz || 'Africa/Tunis';
    const props = opts.props || new Map();
    const cache = new Map();
    const nowFn = opts.now || (() => Date.now());
    const RealDate = Date;
    // a Date whose "now" follows the action's own clock
    function ClockDate(...a) {
      if (!new.target) return new RealDate(nowFn()).toString();
      return a.length ? new RealDate(...a) : new RealDate(nowFn());
    }
    ClockDate.prototype = RealDate.prototype;
    ClockDate.now = () => nowFn();
    ClockDate.UTC = RealDate.UTC; ClockDate.parse = RealDate.parse;
    Object.defineProperty(ClockDate, Symbol.hasInstance, { value: (x) => x instanceof RealDate });

    const logs = [];
    const blob = (bytes, type) => {
      let b = bytes;
      const o = {
        getBytes: () => signed(b), getContentType: () => type || null,
        setDataFromString: (s) => { b = utf8(s); return o; }, getDataAsString: () => new TextDecoder().decode(b)
      };
      return o;
    };
    const env = {
      Date: ClockDate,
      Logger: { log: (m) => { logs.push(String(m)); if (opts.log) opts.log(String(m)); } },
      Session: { getScriptTimeZone: () => tz, getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }) },
      SpreadsheetApp: {
        openById: () => book,
        getActiveSpreadsheet: () => book,
        create: () => { throw new Error('Creating spreadsheets is not available offline.'); },
        flush: () => {},
        DataValidationCriteria: { VALUE_IN_LIST: 'VALUE_IN_LIST', VALUE_IN_RANGE: 'VALUE_IN_RANGE' },
        newDataValidation: () => { const b = { requireValueInRange: () => b, requireValueInList: () => b, setAllowInvalid: () => b, setHelpText: () => b, build: () => ({}) }; return b; },
        CopyPasteType: { PASTE_FORMULA: 'PASTE_FORMULA', PASTE_FORMAT: 'PASTE_FORMAT', PASTE_DATA_VALIDATION: 'PASTE_DATA_VALIDATION', PASTE_NORMAL: 'PASTE_NORMAL' }
      },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
        computeDigest: (alg, s) => signed(sha256(Array.isArray(s) ? unsigned(s) : utf8(s))),
        getUuid: () => globalThis.crypto.randomUUID(),
        formatDate: (d, z, p) => formatDate(d, z, p),
        newBlob: (data, type) => blob(typeof data === 'string' ? utf8(data) : unsigned(data || []), type),
        base64Encode: (bytes) => b64enc(typeof bytes === 'string' ? utf8(bytes) : unsigned(bytes)),
        base64Decode: (s) => signed(b64dec(s)),
        gzip: () => { throw new Error('gzip not available offline'); },
        ungzip: () => { throw new Error('ungzip not available offline'); },
        sleep: () => {}
      },
      CacheService: {
        getScriptCache: () => ({
          get: (k) => (cache.has(k) ? cache.get(k) : null),
          getAll: (ks) => { const o = {}; ks.forEach((k) => { if (cache.has(k)) o[k] = cache.get(k); }); return o; },
          put: (k, v) => { cache.set(k, String(v)); },
          putAll: (o) => { Object.keys(o).forEach((k) => cache.set(k, String(o[k]))); },
          remove: (k) => { cache.delete(k); },
          removeAll: (ks) => ks.forEach((k) => cache.delete(k))
        })
      },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k) => (props.has(k) ? props.get(k) : null),
          setProperty: (k, v) => { props.set(k, String(v)); },
          deleteProperty: (k) => { props.delete(k); },
          getProperties: () => Object.fromEntries(props)
        })
      },
      LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {}, hasLock: () => true }) },
      ContentService: { MimeType: { JSON: 'JSON', JAVASCRIPT: 'JS', TEXT: 'TEXT' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
      ScriptApp: (() => {
        const trig = [];
        const b = (fn) => { const chain = { forSpreadsheet: () => chain, onEdit: () => chain, onChange: () => chain, timeBased: () => chain, everyMinutes: () => chain, everyHours: () => chain, create: () => { const t = { getHandlerFunction: () => fn }; trig.push(t); return t; } }; return chain; };
        return { newTrigger: b, getProjectTriggers: () => trig.slice(), deleteTrigger: (t) => { const i = trig.indexOf(t); if (i !== -1) trig.splice(i, 1); } };
      })(),
      DriveApp: { createFile: () => { throw new Error('Drive is not available offline.'); } },
      __cache: cache, __props: props, __logs: logs, __book: book
    };
    return env;
  }

  return { Book, Sheet, Range, makeEnv, formatDate, displayOf, encodeRow, decodeRow, encodeCell, decodeCell, newUid, sha256, randomHex };
});

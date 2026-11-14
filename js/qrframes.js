/**
 * qrframes.js — splits a bundle into numbered QR frames shown in a loop ("animated QR"),
 * and puts it back together on the other side, in any order, with an integrity check.
 *
 * Frame text:  AQ1/<session>/<index>/<count>/<hash8>/<chunk>
 *   session  random per transfer, so frames of two transfers never mix
 *   hash8    first 8 hex chars of SHA-256 of the whole payload (checked once complete)
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./crypto.js') : root.AC);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QRFrames = api;
})(typeof self !== 'undefined' ? self : globalThis, function (AC) {
  'use strict';
  const PREFIX = 'AQ1';
  const MAX_FRAMES = 4000;

  async function hash8(text) { const h = await AC.sha256(AC.utf8(text)); return Array.from(h.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join(''); }

  async function split(text, chunk) {
    chunk = chunk || 450;
    const sid = AC.b64u(AC.rand(4));
    const h = await hash8(text);
    const n = Math.max(1, Math.ceil(text.length / chunk));
    if (n > MAX_FRAMES) throw new Error('Too large for QR: use a file');
    const frames = [];
    for (let i = 0; i < n; i++) frames.push([PREFIX, sid, i, n, h, text.slice(i * chunk, (i + 1) * chunk)].join('/'));
    return frames;
  }

  class Assembler {
    constructor() { this.reset(); }
    reset() { this.sid = null; this.n = 0; this.h = ''; this.parts = new Map(); this.done = null; }
    /** Feed one decoded QR text. Returns {status, have, total} ; status: 'single' | 'progress' | 'complete' | 'ignored' */
    async add(text) {
      if (typeof text !== 'string') return { status: 'ignored' };
      if (!text.startsWith(PREFIX + '/')) {
        // a plain (single) QR: join requests are shown this way
        // a plain (single) QR: join requests and approval codes (W1Q. / W1A.) are shown this way
        if (text.charAt(0) === '{' || /^W1[QA]\./.test(text)) return { status: 'single', text };
        return { status: 'ignored' };
      }
      const p = text.split('/');
      if (p.length < 6) return { status: 'ignored' };
      const [, sid, iS, nS, h] = p;
      const chunk = p.slice(5).join('/');
      const i = Number(iS), n = Number(nS);
      if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > MAX_FRAMES || i < 0 || i >= n || !/^[0-9a-f]{8}$/.test(h)) return { status: 'ignored' };
      if (this.sid !== sid) { this.reset(); this.sid = sid; this.n = n; this.h = h; }
      if (n !== this.n || h !== this.h) return { status: 'ignored' };
      if (!this.parts.has(i)) this.parts.set(i, chunk);
      if (this.parts.size === this.n && !this.done) {
        let all = ''; for (let k = 0; k < this.n; k++) all += this.parts.get(k);
        if ((await hash8(all)) !== this.h) { this.reset(); return { status: 'progress', have: 0, total: n, error: 'checksum' }; }
        this.done = all;
        return { status: 'complete', text: all, have: n, total: n };
      }
      return { status: this.done ? 'complete' : 'progress', text: this.done || undefined, have: this.parts.size, total: this.n, missing: this.missing() };
    }
    missing() { const m = []; for (let k = 0; k < this.n && m.length < 12; k++) if (!this.parts.has(k)) m.push(k + 1); return m; }
  }

  return { split, Assembler, PREFIX };
});

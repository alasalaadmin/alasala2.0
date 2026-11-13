/**
 * bundle.js — the sealed, signed packages that travel between phones and the master station.
 *
 *   outer (what a relay or a camera sees):  { v, k, id, from, to, epk, iv, ct }
 *     k   = "B" changes from a phone, "R" master reply to a phone, "E" enrollment reply
 *     ct  = AES-GCM ciphertext, readable only with the recipient's private key; the header
 *           (v, k, id, from, to) is bound to it, so it cannot be altered or swapped.
 *   inner (after opening):                  { b: "<body JSON>", s: "<signature>" }
 *     the sender signs header + body, so the recipient knows who wrote it and that nothing changed.
 *
 * A join request ("J") is the only clear message: it holds public keys only.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./crypto.js') : root.AC);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Bundle = api;
})(typeof self !== 'undefined' ? self : globalThis, function (AC) {
  'use strict';
  const FORMAT = 1;
  const ACCEPTED_FORMATS = [1];                 // the master accepts the current and the previous format
  const MAX_OUTER = 12 * 1024 * 1024;
  const MAX_INNER = 48 * 1024 * 1024;
  const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

  class BundleError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

  function header(k, id, from, to, v) { return 'alasala|' + (v || FORMAT) + '|' + k + '|' + id + '|' + from + '|' + to; }

  async function make({ kind, id, from, to, body, signPriv, recipientEcdhPub }) {
    const h = header(kind, id, from, to);
    const bodyStr = JSON.stringify(body);
    const sig = await AC.sign(signPriv, AC.utf8(h + '\n' + bodyStr));
    const inner = await AC.gzip(AC.utf8(JSON.stringify({ b: bodyStr, s: sig })));
    const sealed = await AC.seal(recipientEcdhPub, inner, AC.utf8(h));
    return JSON.stringify({ v: FORMAT, k: kind, id, from, to, epk: sealed.epk, iv: sealed.iv, ct: sealed.ct });
  }

  function parseOuter(text) {
    if (typeof text !== 'string' || text.length > MAX_OUTER) throw new BundleError('SIZE', 'Bundle too large or empty');
    let o;
    try { o = JSON.parse(text); } catch (e) { throw new BundleError('FORMAT', 'Not a bundle'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new BundleError('FORMAT', 'Not a bundle');
    const keys = Object.keys(o).sort().join(',');
    if (o.k === 'J') return parseJoin(o);
    if (o.k === 'P') return parsePack(o);
    if (keys !== 'ct,epk,from,id,iv,k,to,v') throw new BundleError('FORMAT', 'Unexpected fields');
    if (ACCEPTED_FORMATS.indexOf(o.v) === -1) throw new BundleError('VERSION', 'Unsupported bundle format ' + o.v);
    if (['B', 'R', 'E'].indexOf(o.k) === -1) throw new BundleError('FORMAT', 'Unknown bundle kind');
    for (const f of ['id', 'from', 'to']) if (typeof o[f] !== 'string' || !ID_RE.test(o[f])) throw new BundleError('FORMAT', 'Bad ' + f);
    for (const f of ['epk', 'iv', 'ct']) if (typeof o[f] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(o[f])) throw new BundleError('FORMAT', 'Bad ' + f);
    return o;
  }

  /** Opens and checks a bundle. senderSignPub: the expected author's public key (looked up by the caller from o.from). */
  async function open(o, { ecdhPriv, ecdhPub, senderSignPub }) {
    const h = header(o.k, o.id, o.from, o.to, o.v);
    let inner;
    try { inner = await AC.open(ecdhPriv, ecdhPub, { epk: o.epk, iv: o.iv, ct: o.ct }, AC.utf8(h)); }
    catch (e) { throw new BundleError('SEAL', 'Bundle cannot be opened (wrong recipient or altered)'); }
    let parsed;
    try {
      const raw = await AC.gunzip(inner);
      if (raw.length > MAX_INNER) throw new Error('size');
      parsed = JSON.parse(AC.fromUtf8(raw));
    } catch (e) { throw new BundleError('FORMAT', 'Bundle content unreadable'); }
    if (!parsed || typeof parsed.b !== 'string' || typeof parsed.s !== 'string') throw new BundleError('FORMAT', 'Bundle content unreadable');
    if (!senderSignPub) throw new BundleError('SENDER', 'Unknown sender');
    const ok = await AC.verify(senderSignPub, parsed.s, AC.utf8(h + '\n' + parsed.b));
    if (!ok) throw new BundleError('SIGNATURE', 'Signature does not match the sender');
    let body;
    try { body = JSON.parse(parsed.b); } catch (e) { throw new BundleError('FORMAT', 'Bundle body unreadable'); }
    if (!body || typeof body !== 'object') throw new BundleError('FORMAT', 'Bundle body unreadable');
    return body;
  }

  // ---- join request (phone -> master, clear: public keys only)
  function makeJoin({ name, signPub, ecdhPub, nonce, app }) {
    return JSON.stringify({ v: FORMAT, k: 'J', name: String(name || '').slice(0, 60), sign: signPub, ecdh: ecdhPub, nonce, app: app || '' });
  }
  function parseJoin(o) {
    const keys = Object.keys(o).sort().join(',');
    if (keys !== 'app,ecdh,k,name,nonce,sign,v') throw new BundleError('FORMAT', 'Bad join request');
    if (o.v !== FORMAT) throw new BundleError('VERSION', 'Unsupported format');
    AC.checkPub(o.sign); AC.checkPub(o.ecdh);
    if (typeof o.nonce !== 'string' || !ID_RE.test(o.nonce)) throw new BundleError('FORMAT', 'Bad nonce');
    if (typeof o.name !== 'string' || typeof o.app !== 'string') throw new BundleError('FORMAT', 'Bad join request');
    return o;
  }

  // ---- pack: an open envelope holding sealed bundles and replies, so one person can carry many
  const MAX_ITEMS = 1000;
  function makePack({ from, name, items, receipt, acked }) {
    return JSON.stringify({ v: FORMAT, k: 'P', id: newId('p'), from: from || 'master', name: String(name || '').slice(0, 60), items: items || [], receipt: receipt || null, acked: acked || [] });
  }
  function parsePack(o) {
    const keys = Object.keys(o).sort().join(',');
    if (keys !== 'acked,from,id,items,k,name,receipt,v') throw new BundleError('FORMAT', 'Bad pack');
    if (o.v !== FORMAT) throw new BundleError('VERSION', 'Unsupported format');
    if (typeof o.from !== 'string' || !(o.from === 'master' || ID_RE.test(o.from)) || typeof o.id !== 'string' || !ID_RE.test(o.id)) throw new BundleError('FORMAT', 'Bad pack');
    if (typeof o.name !== 'string' || !Array.isArray(o.items) || o.items.length > MAX_ITEMS || !Array.isArray(o.acked) || o.acked.length > 5000) throw new BundleError('FORMAT', 'Bad pack');
    o.items.forEach((it) => {
      if (!it || typeof it !== 'object' || typeof it.t !== 'string' || it.t.length > 4 * 1024 * 1024) throw new BundleError('FORMAT', 'Bad pack item');
      if (it.r !== undefined && (!Array.isArray(it.r) || it.r.length > 50 || it.r.some((x) => typeof x !== 'string' || !ID_RE.test(x)))) throw new BundleError('FORMAT', 'Bad pack route');
    });
    if (o.acked.some((x) => typeof x !== 'string' || !ID_RE.test(x))) throw new BundleError('FORMAT', 'Bad pack');
    if (o.receipt !== null && (typeof o.receipt !== 'object' || !Array.isArray(o.receipt.bundles) || o.receipt.bundles.length > MAX_ITEMS)) throw new BundleError('FORMAT', 'Bad receipt');
    return o;
  }

  function newId(prefix) { return (prefix || '') + AC.b64u(AC.rand(12)); }

  return { FORMAT, ACCEPTED_FORMATS, BundleError, make, parseOuter, open, makeJoin, makePack, newId, header };
});

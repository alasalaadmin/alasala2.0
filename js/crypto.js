/**
 * crypto.js — every cryptographic operation of the system, using only the standard WebCrypto API
 * (built into browsers and Node). No home-made algorithms.
 *
 *  - Signatures: ECDSA P-256 / SHA-256 (each device and the master have a signing key).
 *  - Sealing:    ECDH P-256 with a fresh one-time key + HKDF-SHA-256 + AES-256-GCM ("seal for a public key").
 *  - At rest:    AES-256-GCM; the data key is wrapped by a key derived from the PIN / passphrase
 *                with PBKDF2-SHA-256 (high iteration count, so each guess is slow).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AC = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const subtle = globalThis.crypto.subtle;
  const te = new TextEncoder(), td = new TextDecoder();

  const PBKDF2_ITERATIONS = 600000;     // ~0.3-1 s per guess on a phone
  const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

  // ---- encoding
  function b64u(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o;
  }
  const utf8 = (s) => te.encode(s);
  const fromUtf8 = (b) => td.decode(b);
  function rand(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; }
  function concat(...arrs) { const n = arrs.reduce((a, b) => a + b.length, 0); const o = new Uint8Array(n); let p = 0; arrs.forEach((a) => { o.set(a, p); p += a.length; }); return o; }
  async function sha256(bytes) { return new Uint8Array(await subtle.digest('SHA-256', bytes)); }
  function eqBytes(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

  // ---- compression (CompressionStream exists in browsers and Node 18+)
  async function streamAll(stream) {
    const reader = stream.getReader(); const parts = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; if (n > 64 * 1024 * 1024) throw new Error('too large'); }
    return concat(...parts);
  }
  async function gzip(bytes) { return streamAll(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))); }
  async function gunzip(bytes) { return streamAll(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))); }

  // ---- keys
  async function generateIdentity() {
    const sign = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
    const ecdh = await subtle.generateKey(ECDH, true, ['deriveBits']);
    return {
      signPriv: b64u(await subtle.exportKey('pkcs8', sign.privateKey)),
      signPub: b64u(await subtle.exportKey('raw', sign.publicKey)),
      ecdhPriv: b64u(await subtle.exportKey('pkcs8', ecdh.privateKey)),
      ecdhPub: b64u(await subtle.exportKey('raw', ecdh.publicKey))
    };
  }
  const importSignPriv = (b) => subtle.importKey('pkcs8', unb64u(b), ECDSA, false, ['sign']);
  const importSignPub = (b) => subtle.importKey('raw', unb64u(b), ECDSA, false, ['verify']);
  const importEcdhPriv = (b) => subtle.importKey('pkcs8', unb64u(b), ECDH, false, ['deriveBits']);
  const importEcdhPub = (b) => subtle.importKey('raw', unb64u(b), ECDH, false, []);
  function checkPub(b) { const r = unb64u(b); if (r.length !== 65 || r[0] !== 4) throw new Error('bad public key'); return b; }

  async function sign(privB64, bytes) {
    const k = typeof privB64 === 'string' ? await importSignPriv(privB64) : privB64;
    return b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, bytes));
  }
  async function verify(pubB64, sigB64, bytes) {
    try {
      const k = await importSignPub(pubB64);
      return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, unb64u(sigB64), bytes);
    } catch (e) { return false; }
  }

  async function hkdfKey(shared, salt, info) {
    const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** Seal bytes so that only the holder of the private key matching recipientEcdhPub can open them. */
  async function seal(recipientEcdhPub, bytes, aad) {
    const recip = await importEcdhPub(recipientEcdhPub);
    const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
    const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: recip }, eph.privateKey, 256));
    const key = await hkdfKey(shared, concat(epk, unb64u(recipientEcdhPub)), 'alasala/seal/v1');
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad || new Uint8Array(0) }, key, bytes));
    return { epk: b64u(epk), iv: b64u(iv), ct: b64u(ct) };
  }
  async function open(recipientEcdhPriv, recipientEcdhPub, sealed, aad) {
    const priv = typeof recipientEcdhPriv === 'string' ? await importEcdhPriv(recipientEcdhPriv) : recipientEcdhPriv;
    const epkPub = await importEcdhPub(checkPub(sealed.epk));
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: epkPub }, priv, 256));
    const key = await hkdfKey(shared, concat(unb64u(sealed.epk), unb64u(recipientEcdhPub)), 'alasala/seal/v1');
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(sealed.iv), additionalData: aad || new Uint8Array(0) }, key, unb64u(sealed.ct)));
  }

  // ---- data at rest
  async function newDataKey() { return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
  async function exportKeyRaw(k) { return new Uint8Array(await subtle.exportKey('raw', k)); }
  async function importDataKey(raw, extractable) { return subtle.importKey('raw', raw, { name: 'AES-GCM' }, !!extractable, ['encrypt', 'decrypt']); }
  async function passKey(secret, salt, iterations) {
    const base = await subtle.importKey('raw', utf8(String(secret).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iterations || PBKDF2_ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(key, bytes, aad) {
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad || new Uint8Array(0) }, key, bytes));
    return { iv: b64u(iv), ct: b64u(ct) };
  }
  async function decrypt(key, box, aad) {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(box.iv), additionalData: aad || new Uint8Array(0) }, key, unb64u(box.ct)));
  }
  /** Wraps a data key under a PIN/passphrase. Returns a record safe to store in clear. */
  async function wrapDataKey(dataKeyRaw, secret, iterations) {
    const salt = rand(16); const it = iterations || PBKDF2_ITERATIONS;
    const kek = await passKey(secret, salt, it);
    const box = await encrypt(kek, dataKeyRaw, utf8('alasala/dek/v1'));
    return { kdf: 'PBKDF2-SHA256', it, salt: b64u(salt), iv: box.iv, ct: box.ct };
  }
  async function unwrapDataKey(rec, secret) {
    const kek = await passKey(secret, unb64u(rec.salt), rec.it);
    return decrypt(kek, rec, utf8('alasala/dek/v1'));   // throws on a wrong PIN
  }

  /** Short code both screens show at enrollment, to confirm they talk to each other (6 digits). */
  async function pairingCode(...pubs) {
    const h = await sha256(utf8(pubs.join('|')));
    const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    return String(n % 1000000).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
  }
  async function keyId(pub) { return b64u((await sha256(utf8(pub))).slice(0, 9)); }

  return {
    PBKDF2_ITERATIONS, b64u, unb64u, utf8, fromUtf8, rand, sha256, eqBytes, gzip, gunzip,
    generateIdentity, importSignPriv, importEcdhPriv, checkPub, sign, verify, seal, open,
    newDataKey, exportKeyRaw, importDataKey, passKey, encrypt, decrypt, wrapDataKey, unwrapDataKey, pairingCode, keyId
  };
});

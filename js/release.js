/**
 * release.js — signed app releases. A release is a list of every app file with its SHA-256,
 * signed with an offline release key. The phone installs a new version only when the list is
 * signed by the key built into the app and every file matches its hash.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./crypto.js') : root.AC);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Release = api;
})(typeof self !== 'undefined' ? self : globalThis, function (AC) {
  'use strict';
  async function sha256Hex(bytes) { return Array.from(await AC.sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join(''); }

  async function sign(manifest, signPriv) {
    const text = JSON.stringify(manifest);
    return { text, sig: await AC.sign(signPriv, AC.utf8('alasala/release/v1\n' + text)) };
  }

  /** Returns the manifest if the signature is valid for the pinned key; throws otherwise. */
  async function verify(text, sig, pinnedPub) {
    if (typeof text !== 'string' || typeof sig !== 'string' || text.length > 1e6) throw new Error('release: bad input');
    const ok = await AC.verify(pinnedPub, sig.trim(), AC.utf8('alasala/release/v1\n' + text));
    if (!ok) throw new Error('release: signature does not match the app key');
    const m = JSON.parse(text);
    if (!m || typeof m.version !== 'string' || !m.files || typeof m.files !== 'object') throw new Error('release: bad manifest');
    Object.keys(m.files).forEach((p) => { if (!/^[A-Za-z0-9._/-]+$/.test(p) || p.indexOf('..') !== -1) throw new Error('release: bad path ' + p); });
    return m;
  }

  async function checkFile(m, path, bytes) {
    const want = m.files[path];
    if (!want) throw new Error('release: file not in the release ' + path);
    const got = await sha256Hex(bytes);
    if (got !== want) throw new Error('release: file altered ' + path);
    return true;
  }

  return { sign, verify, checkFile, sha256Hex };
});

/**
 * spot.js — approval on the spot, between two phones, face to face (v1.8).
 *
 *   request  (teacher's phone)  "W1Q." + base64url(JSON) + "." + signature of everything before the last dot
 *   decision (T4's phone)       "W1A." + base64url(JSON) + "." + signature; its JSON names the request by hash
 *
 * Both are signed with the phone's own key (the one enrolled at the station). The station checks both signatures
 * against its list of phones before it applies anything; the teacher's phone checks the T4's signature against the
 * list of T4 phones the station sends it.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./crypto.js') : root.AC);
  if (isNode) module.exports = api; else root.Spot = api;
})(typeof self !== 'undefined' ? self : globalThis, function (AC) {
  'use strict';
  const KINDS = { deletion: 1, name: 1 };
  const MAX_TEXT = 200, MAX_AGE_DAYS = 30;

  class SpotError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const clip = (v, n) => String(v === null || v === undefined ? '' : v).slice(0, n || MAX_TEXT);

  async function seal(prefix, body, signPriv) {
    const head = prefix + AC.b64u(AC.utf8(JSON.stringify(body)));
    return head + '.' + (await AC.sign(signPriv, AC.utf8(head)));
  }
  function parse(text) {
    const t = String(text || '').trim();
    const m = /^(W1[QA])\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(t);
    if (!m) throw new SpotError('BAD_INPUT', 'Not an approval code');
    let body;
    try { body = JSON.parse(AC.fromUtf8(AC.unb64u(m[2]))); } catch (e) { throw new SpotError('FORMAT', 'Damaged code'); }
    if (!body || body.v !== 1) throw new SpotError('VERSION', 'Unknown code version');
    return { type: m[1] === 'W1Q' ? 'Q' : 'A', body, head: m[1] + '.' + m[2], sig: m[3], text: t };
  }
  async function verify(parsed, signPub) { return !!signPub && AC.verify(signPub, parsed.sig, AC.utf8(parsed.head)); }
  async function hashOf(text) { return AC.b64u((await AC.sha256(AC.utf8(String(text).trim()))).slice(0, 18)); }

  /** The teacher's request. fields: deletion {studentId, courseCode, reason} | name {studentId, newName, reason};
   *  show: {student, course, current} (labels for the T4's screen only). */
  async function request(o) {
    if (!KINDS[o.kind]) throw new SpotError('BAD_INPUT', 'Unknown request');
    const f = o.fields || {};
    const p = o.kind === 'deletion'
      ? { studentId: clip(f.studentId, 40), courseCode: clip(f.courseCode, 40), reason: clip(f.reason) }
      : { studentId: clip(f.studentId, 40), newName: clip(f.newName, 80), reason: clip(f.reason) };
    const s = o.show || {};
    const body = { v: 1, n: AC.b64u(AC.rand(9)), dev: o.deviceId, e: String(o.email || '').toLowerCase(), nm: clip(o.name, 60), k: o.kind, p,
      s: { student: clip(s.student, 80), course: clip(s.course, 80), current: clip(s.current, 80) }, at: o.at || Date.now() };
    return seal('W1Q.', body, o.signPriv);
  }

  /** The T4's decision on a request text. */
  async function decision(o) {
    const q = parse(o.requestText);
    if (q.type !== 'Q') throw new SpotError('BAD_INPUT', 'Not a request');
    if (o.decision !== 'approve' && o.decision !== 'reject') throw new SpotError('BAD_INPUT', 'Unknown decision');
    if (o.decision === 'reject' && !String(o.note || '').trim()) throw new SpotError('NOTE', 'A note is required to reject');
    const body = { v: 1, h: await hashOf(q.text), n: q.body.n, d: o.decision, note: clip(o.note), fn: q.body.k === 'name' ? clip(o.finalName || '', 80) : '',
      dev: o.deviceId, e: String(o.email || '').toLowerCase(), nm: clip(o.name, 60), at: o.at || Date.now() };
    return seal('W1A.', body, o.signPriv);
  }

  /** Checks that a decision answers this request (same hash). Signatures are checked separately. */
  async function matches(q, a) { return q.type === 'Q' && a.type === 'A' && a.body.h === (await hashOf(q.text)) && a.body.n === q.body.n; }

  /** The engine payload both texts stand for (what is replayed as the teacher, the T4 deciding). */
  function payloadOf(q, a) {
    const p = q.body.p || {};
    const out = { action: 'spotDecision', kind: q.body.k, studentId: p.studentId, reason: p.reason, decision: a.body.d, note: a.body.note || '', q: q.text, a: a.text };
    if (q.body.k === 'deletion') out.courseCode = p.courseCode;
    else { out.newName = p.newName; out.finalName = a.body.fn || ''; }
    return out;
  }

  return { request, decision, parse, verify, matches, payloadOf, hashOf, SpotError, MAX_AGE_DAYS };
});

/**
 * core.js — everything the phone does, independent of the screen: the encrypted vault, the PIN,
 * running the v66 rules on the person's own data, recording changes, making and reading bundles.
 * Runs in a Web Worker on the phone (and in Node for the automated tests).
 *
 * What is stored on the phone (IndexedDB):
 *   "meta"  (clear)      enrollment state, the PIN-wrapped data key, wrong-PIN counter, the personal mark
 *   "vault" (encrypted)  device keys, master public keys, the person's data slice, pending changes
 * Without the PIN (or passphrase) the vault is unreadable.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const deps = isNode
    ? [require('../shared/crypto.js'), require('../shared/bundle.js'), require('../shared/engine.js'), require('../shared/gas-env.js')]
    : [root.AC, root.Bundle, root.Engine, root.GasEnv];
  const api = factory.apply(null, deps);
  if (isNode) module.exports = api; else root.PhoneCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function (AC, Bundle, Engine, GasEnv) {
  'use strict';
  const APP_VERSION = '1.0.0';
  const LOCK_STEPS = [0, 0, 0, 0, 0, 15 * 60e3, 60 * 60e3, 6 * 3600e3];   // after 5 wrong secrets: 15 min, 1 h, then 6 h
  const WIPE_AFTER = 20;                                                   // wrong secrets in a row before the phone erases its data
  const MAX_RECENT_BUNDLES = 20;
  const CARRY_MAX = 500;                                  // sealed items one phone carries for others
  const CARRY_UP_DAYS = 60, CARRY_DOWN_DAYS = 45;          // older carried items are dropped
  const ACKED_MAX = 3000;

  class PhoneError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

  function secretOk(secret, strong) {
    const s = String(secret || '');
    if (strong) return s.length >= 12 && /[^0-9]/.test(s);
    return /^\d{8,}$/.test(s) || (s.length >= 10 && /[^0-9]/.test(s));
  }
  const A4_MASTER_ONLY = ['actContribInit', 'actSetDeclared', 'actSetDeclaredMany', 'actSetDefaultFilter'];
  const strongNeeded = (profile) => /(^|[^A-Z0-9])(T3|T4|T5|A3|A4)(?![0-9])/.test(String((profile && profile.role) || '').toUpperCase());
  function replaceDeep(v, map) {
    if (typeof v === 'string') return Object.prototype.hasOwnProperty.call(map, v) ? map[v] : v;
    if (Array.isArray(v)) return v.map((x) => replaceDeep(x, map));
    if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = replaceDeep(v[k], map); }); return o; }
    return v;
  }

  class Core {
    /** kv: { get(key) -> Promise<any>, set(key, value) -> Promise, del(key) -> Promise } */
    constructor({ kv, now, iterations }) {
      this.kv = kv; this.now = now || (() => Date.now()); this.iterations = iterations;
      this.dek = null; this.v = null; this.engine = null; this.meta = null;
    }

    async loadMeta() { this.meta = (await this.kv.get('meta')) || { state: 'new', failures: 0 }; return this.meta; }
    async saveMeta() { await this.kv.set('meta', this.meta); }

    async status() {
      const m = await this.loadMeta();
      return {
        state: m.state, locked: !this.v, label: m.label || '', mark: m.mark || '', email: m.email || '', name: m.name || '',
        lockedUntil: m.lockUntil && m.lockUntil > this.now() ? m.lockUntil : 0, failures: m.failures || 0,
        pending: this.v ? this.v.pending.length : (m.pendingCount || 0), lastSync: m.lastSync || null,
        mustUpgradeSecret: !!(this.v && this.v.mustUpgradeSecret), app: APP_VERSION,
        inTransit: this.v && this.v.inTransit && this.v.pending.length ? this.v.inTransit : null,
        carrying: this.v && this.v.carry ? { up: this.v.carry.up.length, down: this.v.carry.down.length } : { up: 0, down: 0 }
      };
    }

    // ---------------------------------------------------------------- joining
    async join(label, secret) {
      const m = await this.loadMeta();
      if (m.state === 'enrolled') throw new PhoneError('ENROLLED', 'This phone is already enrolled');
      if (!secretOk(secret)) throw new PhoneError('WEAK', 'Use at least 8 digits, or a passphrase of 10 characters or more');
      const id = await AC.generateIdentity();
      const dek = await AC.newDataKey();
      const raw = await AC.exportKeyRaw(dek);
      const wrapped = await AC.wrapDataKey(raw, secret, this.iterations);
      raw.fill(0);
      this.dek = await AC.importDataKey(await AC.unwrapDataKey(wrapped, secret));
      const nonce = Bundle.newId('n');
      this.v = { v: 1, identity: id, joinNonce: nonce, pending: [], seq: 0, pool: [], recentBundles: [], rejected: [], lastReplyAt: '', strongSecret: secretOk(secret, true) };
      this.meta = { state: 'joining', label: String(label || '').slice(0, 60), wrapped, failures: 0 };
      await this.saveVault();
      return Bundle.makeJoin({ name: this.meta.label, signPub: id.signPub, ecdhPub: id.ecdhPub, nonce, app: APP_VERSION });
    }

    async joinText() {
      this.requireUnlocked();
      if (this.meta.state !== 'joining') throw new PhoneError('STATE', 'Not waiting for enrollment');
      const id = this.v.identity;
      return Bundle.makeJoin({ name: this.meta.label, signPub: id.signPub, ecdhPub: id.ecdhPub, nonce: this.v.joinNonce, app: APP_VERSION });
    }

    /** Reads the master's enrollment reply. Returns the pairing code to compare with the master's screen. */
    async enroll(text) {
      this.requireUnlocked();
      if (this.meta.state !== 'joining') throw new PhoneError('STATE', 'Not waiting for enrollment');
      const o = Bundle.parseOuter(text);
      if (o.k !== 'E') throw new PhoneError('BAD_INPUT', 'This is not an enrollment code');
      const id = this.v.identity;
      // the master's keys arrive inside the sealed reply; they are trusted because you are face to face
      // with the master station and both screens show the same pairing code
      let peek;
      try {
        const inner = await AC.open(id.ecdhPriv, id.ecdhPub, { epk: o.epk, iv: o.iv, ct: o.ct }, AC.utf8(Bundle.header(o.k, o.id, o.from, o.to, o.v)));
        peek = JSON.parse(JSON.parse(AC.fromUtf8(await AC.gunzip(inner))).b);
      } catch (e) { throw new PhoneError('SEAL', 'This code is not for this phone'); }
      if (!peek.master || !peek.master.signPub) throw new PhoneError('FORMAT', 'Enrollment code incomplete');
      const body = await Bundle.open(o, { ecdhPriv: id.ecdhPriv, ecdhPub: id.ecdhPub, senderSignPub: peek.master.signPub });
      if (body.kind !== 'enroll' || body.nonce !== this.v.joinNonce || body.device !== o.to || o.from !== body.master.id) throw new PhoneError('MISMATCH', 'This enrollment code was made for another phone');
      const code = await AC.pairingCode(body.master.signPub, id.signPub, id.ecdhPub);
      if (code !== body.pairingCode) throw new PhoneError('MISMATCH', 'Pairing codes differ');
      Object.assign(this.v, { deviceId: o.to, master: body.master, profile: body.profile, mark: body.mark, base: { format: 'alasala-book/1', sheets: [] }, hashes: {} });
      this.applySlice(body);
      this.v.lastReplyAt = body.created;
      this.v.mustUpgradeSecret = strongNeeded(body.profile) && !this.v.strongSecret;
      this.meta.state = 'enrolled'; this.meta.mark = body.mark; this.meta.email = body.profile.email; this.meta.name = body.profile.name;
      this.meta.lastSync = body.created;
      this.rebuild();
      await this.saveVault();
      return { code, mark: body.mark, profile: body.profile, mustUpgradeSecret: this.v.mustUpgradeSecret };
    }

    // ---------------------------------------------------------------- lock / unlock
    async unlock(secret) {
      const m = await this.loadMeta();
      if (m.state === 'new') throw new PhoneError('STATE', 'This phone is not set up');
      if (m.lockUntil && m.lockUntil > this.now()) throw new PhoneError('LOCKED', 'Too many wrong attempts. Try again later.');
      let raw;
      try { raw = await AC.unwrapDataKey(m.wrapped, secret); }
      catch (e) {
        m.failures = (m.failures || 0) + 1;
        if (m.failures >= WIPE_AFTER) { await this.wipe(); throw new PhoneError('WIPED', 'Too many wrong attempts: the data on this phone was erased. Enroll it again with the master station.'); }
        const step = LOCK_STEPS[Math.min(m.failures, LOCK_STEPS.length - 1)];
        if (step) m.lockUntil = this.now() + step;
        await this.saveMeta();
        throw new PhoneError('BAD_SECRET', 'Wrong PIN');
      }
      this.dek = await AC.importDataKey(raw); raw.fill(0);
      const box = await this.kv.get('vault');
      this.v = JSON.parse(AC.fromUtf8(await AC.decrypt(this.dek, box, AC.utf8('alasala/vault/v1'))));
      m.failures = 0; m.lockUntil = 0; await this.saveMeta();
      if (m.state === 'enrolled') { this.rebuild(); if (this.purged) await this.saveVault(); }
      return this.status();
    }

    lock() { this.dek = null; this.v = null; this.engine = null; }
    requireUnlocked() { if (!this.v || !this.dek) throw new PhoneError('LOCKED', 'Locked'); }
    requireEnrolled() { this.requireUnlocked(); if (this.meta.state !== 'enrolled') throw new PhoneError('STATE', 'Not enrolled'); }

    async changeSecret(oldSecret, newSecret) {
      this.requireUnlocked();
      const strong = strongNeeded(this.v.profile);
      if (!secretOk(newSecret, strong)) throw new PhoneError('WEAK', strong ? 'Your role needs a passphrase of at least 12 characters, with letters' : 'Use at least 8 digits, or a passphrase of 10 characters or more');
      const raw = await AC.unwrapDataKey(this.meta.wrapped, oldSecret).catch(() => { throw new PhoneError('BAD_SECRET', 'Wrong current PIN'); });
      this.meta.wrapped = await AC.wrapDataKey(raw, newSecret, this.iterations); raw.fill(0);
      this.v.strongSecret = secretOk(newSecret, true);
      this.v.mustUpgradeSecret = strong && !this.v.strongSecret;
      await this.saveVault();
      return this.status();
    }

    async wipe() { await this.kv.del('vault'); this.meta = { state: 'new', failures: 0 }; await this.saveMeta(); this.lock(); }

    async saveVault() {
      const box = await AC.encrypt(this.dek, AC.utf8(JSON.stringify(this.v)), AC.utf8('alasala/vault/v1'));
      await this.kv.set('vault', box);
      this.meta.pendingCount = this.v.pending ? this.v.pending.length : 0;
      await this.saveMeta();
    }

    // ---------------------------------------------------------------- data & rules
    applySlice(body) {
      const cur = {}; (this.v.base.sheets || []).forEach((s) => { cur[s.name] = s; });
      const old = this.v.hashes || {};
      const hashes = Object.assign({}, body.hashes || {});
      const next = (body.sheets || []).map((s) => {
        if (!s.same) return s;
        // the master skipped this tab, assuming this phone has version h; if not, keep ours and let the next direct sync fix it
        if (s.h && old[s.name] !== s.h) hashes[s.name] = old[s.name] || 'stale';
        return cur[s.name];
      }).filter(Boolean);
      this.v.base = { format: 'alasala-book/1', sheets: next };
      this.v.hashes = hashes;
      this.v.pool = (body.pool || []).slice();
      this.v.props = body.props || {};
      this.v.profile = body.profile || this.v.profile;
      this.v.grants = (body.grants || []).map((g) => ({ id: g.id, kind: g.kind, ref: g.ref, until: g.until, uids: g.uids || [], members: g.members }));
      this.v.views = body.views || {};
    }

    /** Rows of details whose time is over are erased now, without waiting for the next reply. */
    purgeExpired() {
      const now = new Date(this.now()).toISOString();
      const gone = new Set(), keep = new Set();
      (this.v.grants || []).forEach((g) => (g.until > now ? keep : gone).add(g.id));
      if (!gone.size) return false;
      const drop = new Set();
      this.v.grants.filter((g) => gone.has(g.id)).forEach((g) => g.uids.forEach((u) => drop.add(u)));
      this.v.grants.filter((g) => keep.has(g.id)).forEach((g) => g.uids.forEach((u) => drop.delete(u)));
      this.v.base.sheets.forEach((s) => {
        let changed = false;
        for (let i = s.uids.length - 1; i >= 1; i--) if (drop.has(s.uids[i])) { s.uids.splice(i, 1); s.rows.splice(i, 1); changed = true; }
        if (changed && this.v.hashes) this.v.hashes[s.name] = 'stale';
      });
      this.v.grants = this.v.grants.filter((g) => keep.has(g.id));
      return true;
    }

    /** What a T4 / A3 / A4 can ask for, what they hold now, and their programs summary (percentages). */
    details() {
      this.requireEnrolled();
      const p = this.v.profile || {};
      const now = new Date(this.now()).toISOString();
      return {
        canCourse: /(^|[^A-Z0-9])T4(?![0-9])/.test(String(p.role || '').toUpperCase()),
        canClass: ['A3', 'A4'].indexOf(p.act) !== -1,
        canPub: p.act === 'A4',
        tier: p.act || '',
        pubLessons: (this.v.views && this.v.views.pubLessons) || [],
        grants: (this.v.grants || []).filter((g) => g.until > now).map((g) => ({ kind: g.kind, ref: g.ref, until: g.until, members: g.members, people: this.peopleOf(g) })),
        asked: this.v.pending.filter((c) => c.payload.action === 'requestDetails').map((c) => ({ kind: c.payload.kind, ref: c.payload.ref, at: c.at })),
        prog: (this.v.views && this.v.views.prog) || null
      };
    }

    /** The members a grant brought to the phone: name, phone, level, area (shown in the details screen). */
    peopleOf(g) {
      const sh = this.v.base.sheets.find((x) => x.name === 'الرواد');
      if (!sh) return [];
      const head = (sh.rows[0] || []).map((h) => String(h || '').trim());
      const col = (n) => head.findIndex((h) => h === n || h.indexOf(n) === 0);
      const iN = col('الاسم'), iP = col('الهاتف'), iL = col('المستوى'), iC = col('الحيّ / المدينة') !== -1 ? col('الحيّ / المدينة') : col('الحي / المدينة');
      const want = new Set(g.uids || []);
      const val = (r, i) => { if (i === -1) return ''; const v = r[i]; return v && typeof v === 'object' ? String(v.$d || '').slice(0, 10) : String(v === null || v === undefined ? '' : v); };
      const out = [];
      sh.uids.forEach((u, i) => { if (i && want.has(u)) { const r = sh.rows[i]; out.push({ name: val(r, iN), phone: val(r, iP), level: val(r, iL), city: val(r, iC) }); } });
      return out.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    }

    async requestDetails(payload) {
      const d = this.details();
      const kind = ['class', 'course', 'pub'].indexOf(payload.kind) !== -1 ? payload.kind : '';
      const ref = String(payload.ref || '').trim().slice(0, 60);
      if (!kind || !ref) return { success: false, code: 'BAD_INPUT', error: 'اختر الدرس أو الصف.' };
      if ((kind === 'course' && !d.canCourse) || (kind === 'class' && !d.canClass) || (kind === 'pub' && !d.canPub)) return { success: false, code: 'FORBIDDEN', error: 'غير متاح لصفتك.' };
      if (d.asked.some((a) => a.kind === kind && a.ref === ref)) return { success: true, message: 'الطلب مسجّل من قبل؛ يصل مع المزامنة القادمة.' };
      this.v.seq += 1;
      this.v.pending.push({ id: Bundle.newId('c'), seq: this.v.seq, at: this.now(), payload: { action: 'requestDetails', kind, ref }, gen: [] });
      await this.saveVault();
      return { success: true, message: 'سُجّل الطلب؛ يصل إلى المحطة مع المزامنة القادمة، وتصل التفاصيل مع ردها.' };
    }

    /** Working data = what the master last sent + the changes not yet acknowledged, replayed in order. */
    rebuild() {
      this.purged = this.purgeExpired();
      const props = new Map(Object.entries(this.v.props || {}));
      const self = this;
      this.engine = Engine.create({
        book: this.v.base, props, mode: 'phone',
        pool: () => self.v.pool, takeFromPool: (id) => { const i = self.v.pool.indexOf(id); if (i !== -1) self.v.pool.splice(i, 1); }
      });
      const email = this.v.profile.email;
      this.v.pending.forEach((c) => {
        if (c.payload.action === 'requestDetails') return;   // decided by the master only
        const expect = { ids: (c.gen || []).filter((g) => g.kind !== 'student'), studentIds: (c.gen || []).filter((g) => g.kind === 'student').map((g) => g.value) };
        const r = this.engine.run(email, c.payload, { now: c.at, expect });
        c.localConflict = !r.res.success ? (r.res.error || 'refused') : undefined;
        (c.gen || []).forEach((g) => { if (g.kind === 'student') { const i = this.v.pool.indexOf(g.value); if (i !== -1) this.v.pool.splice(i, 1); } });
      });
    }

    /** The app's screens call this instead of the Google server. */
    async api(payload) {
      if (payload && payload.action === 'login') return this.login(payload);
      if (payload && payload.action === 'logout') { this.lock(); return { success: true }; }
      this.requireEnrolled();
      const email = this.v.profile.email;
      if (payload.action === 'requestDetails') return this.requestDetails(payload);
      // A4: contribution details and the programs settings stay on the master (percentages in the summary)
      if (this.v.profile.act === 'A4' && A4_MASTER_ONLY.indexOf(payload.action) !== -1) return { success: false, code: 'MASTER_ONLY', error: 'متاح في المحطة الرئيسية فقط. على الهاتف: ملخص البرامج بالنسب.' };
      if (payload.action === 'viewAs' || payload.action === 'viewAsList' || payload.action === 'revokeSessions') return { success: false, code: 'FORBIDDEN', error: 'متاح في المحطة الرئيسية فقط.' };
      const out = this.engine.run(email, payload, {});
      // the book list as the master computes it from every course (a phone holds only some courses)
      if (payload.action === 'init' && out.res && out.res.success && this.v.views && Array.isArray(this.v.views.books) && this.v.views.books.length) out.res.books = this.v.views.books.slice();
      if (payload.action === 'init' && out.res && out.res.success && this.v.views && this.v.views.dropdowns) out.res.dropdowns = JSON.parse(JSON.stringify(this.v.views.dropdowns));
      if (out.write && out.res && out.res.success) {
        const p = JSON.parse(JSON.stringify(payload)); delete p.token;
        this.v.seq += 1;
        this.v.pending.push({ id: Bundle.newId('c'), seq: this.v.seq, at: this.now(), payload: p, gen: out.gen });
        await this.saveVault();
      }
      return out.res;
    }

    async login(p) {
      // the v66 login screen: e-mail + PIN; offline, the PIN opens this phone's vault
      try { if (!this.v) await this.unlock(p.pin); }
      catch (e) { return { success: false, code: e.code || 'BAD_CREDENTIALS', error: e.code === 'LOCKED' ? 'تم تعليق الدخول مؤقتاً بسبب محاولات خاطئة متكررة. أعد المحاولة لاحقاً.' : (e.code === 'WIPED' ? 'تم مسح بيانات هذا الهاتف بعد محاولات خاطئة كثيرة. أعد تسجيله لدى المحطة الرئيسية.' : 'البريد الإلكتروني أو الرمز السري غير صحيح.') }; }
      if (this.meta.state !== 'enrolled') return { success: false, code: 'STATE', error: 'هذا الهاتف غير مسجل بعد.' };
      if (String(p.email || '').trim().toLowerCase() !== this.v.profile.email) { this.lock(); return { success: false, code: 'BAD_CREDENTIALS', error: 'البريد الإلكتروني أو الرمز السري غير صحيح.' }; }
      // education and programs (A1 to A4, M1); the CEO view stays on the master
      const deps = (this.v.profile.departments || ['edu']).filter((d) => d === 'edu' || d === 'act');
      return { success: true, token: GasEnv.randomHex(32), departments: deps.length ? deps : ['edu'], canViewAs: false, tiers: { edu: this.v.profile.tier || '', act: this.v.profile.act || '' } };
    }

    // ---------------------------------------------------------------- sync
    async makeBundle() {
      this.requireEnrolled();
      const id = Bundle.newId('b');
      const changes = this.v.pending.map((c) => ({ id: c.id, seq: c.seq, at: c.at, payload: c.payload, gen: c.gen }));
      const body = {
        kind: 'changes', device: this.v.deviceId, staff: this.v.profile.email, bundleId: id, created: new Date(this.now()).toISOString(),
        seqFrom: changes.length ? changes[0].seq : this.v.seq + 1, seqTo: this.v.seq, changes, have: this.v.hashes || {}, app: APP_VERSION
      };
      const own = await Bundle.make({ kind: 'B', id, from: this.v.deviceId, to: this.v.master.id, body, signPriv: this.v.identity.signPriv, recipientEcdhPub: this.v.master.ecdhPub });
      this.v.recentBundles = (this.v.recentBundles || []).concat([id]).slice(-MAX_RECENT_BUNDLES);
      this.pruneCarry();
      const up = this.carry().up;
      const text = Bundle.makePack({ from: this.v.deviceId, name: this.v.profile.name, items: [{ t: own }].concat(up.map((x) => ({ t: x.t }))), acked: [] });
      await this.saveVault();
      return { text, id, changes: changes.length, carried: up.length, single: own };
    }

    // ---------------------------------------------------------------- carrying for others
    carry() { if (!this.v.carry) this.v.carry = { up: [], down: [], acked: [] }; return this.v.carry; }
    pruneCarry() {
      const c = this.carry(), now = this.now();
      const ack = new Set(c.acked);
      c.up = c.up.filter((x) => !ack.has(x.id) && now - x.at < CARRY_UP_DAYS * 86400e3).slice(-CARRY_MAX);
      c.down = c.down.filter((x) => now - x.at < CARRY_DOWN_DAYS * 86400e3).slice(-CARRY_MAX);
      c.acked = c.acked.slice(-ACKED_MAX);
    }
    /** You collect someone's updates (their "send" code): they are sealed for the master, you only carry them. */
    async collect(text) {
      this.requireEnrolled();
      const o = Bundle.parseOuter(text);
      if (o.k !== 'P') throw new PhoneError('BAD_INPUT', 'This is not a code from the send button');
      if (o.from === this.v.deviceId) throw new PhoneError('MISMATCH', 'This is your own code');
      const c = this.carry(); const have = new Set(c.up.map((x) => x.id)); const ack = new Set(c.acked);
      const got = [];
      for (const it of o.items) {
        let io; try { io = Bundle.parseOuter(it.t); } catch (e) { continue; }
        if (io.k !== 'B' || io.to !== this.v.master.id || io.from === this.v.deviceId) continue;
        got.push(io.id);
        if (!have.has(io.id) && !ack.has(io.id)) { c.up.push({ id: io.id, from: io.from, t: it.t, at: this.now() }); have.add(io.id); }
      }
      this.pruneCarry();
      await this.saveVault();
      return { from: o.from, name: o.name, bundles: got, carrying: c.up.length };
    }
    /** What you hand back to the person you just collected from: their replies (and their team's), and a carrier receipt. */
    async packFor(deviceId, bundles) {
      this.requireEnrolled();
      const c = this.carry();
      const items = c.down.filter((x) => x.to === deviceId || (x.route || []).indexOf(deviceId) !== -1).map((x) => ({ t: x.t, r: x.route }));
      const receipt = bundles && bundles.length ? { by: this.v.profile.name, at: new Date(this.now()).toISOString(), bundles: bundles.slice(0, 1000) } : null;
      return { text: Bundle.makePack({ from: this.v.deviceId, name: this.v.profile.name, items, receipt, acked: c.acked.slice(-ACKED_MAX) }), replies: items.length };
    }
    /** Reads what comes down: a reply from the master, or a pack from the master or from the person above you. */
    async applyIncoming(text) {
      this.requireEnrolled();
      const o = Bundle.parseOuter(text);
      if (o.k === 'R') return { mine: await this.applyReply(text), carriedDown: 0 };
      if (o.k !== 'P') throw new PhoneError('BAD_INPUT', 'This is not a reply');
      const c = this.carry();
      o.acked.forEach((id) => c.acked.push(id));
      const out = { mine: null, mineError: null, carriedDown: 0, inTransit: null };
      if (o.receipt && o.receipt.bundles.some((b) => (this.v.recentBundles || []).indexOf(b) !== -1)) {
        this.v.inTransit = { by: String(o.receipt.by || '').slice(0, 60), at: String(o.receipt.at || '').slice(0, 30), seqTo: this.v.seq };
        out.inTransit = this.v.inTransit;
      }
      for (const it of o.items) {
        let io; try { io = Bundle.parseOuter(it.t); } catch (e) { continue; }
        if (io.k !== 'R') continue;
        if (io.to === this.v.deviceId) {
          try { out.mine = await this.applyReply(it.t); } catch (e) { if (e.code !== 'OLD') out.mineError = e.code || e.message; }
        } else if ((it.r || []).indexOf(this.v.deviceId) !== -1) {
          c.down = c.down.filter((x) => x.to !== io.to);            // a newer reply replaces the older one for the same phone
          c.down.push({ to: io.to, route: it.r, t: it.t, at: this.now() });
          out.carriedDown++;
        }
      }
      this.pruneCarry();
      await this.saveVault();
      return out;
    }

    /** Reads the master's reply: only replies signed by the master and meant for this phone are accepted. */
    async applyReply(text) {
      this.requireEnrolled();
      const o = Bundle.parseOuter(text);
      if (o.k !== 'R') throw new PhoneError('BAD_INPUT', 'This is not a reply from the master');
      if (o.to !== this.v.deviceId) throw new PhoneError('MISMATCH', 'This reply is for another phone');
      if (o.from !== this.v.master.id) throw new PhoneError('MISMATCH', 'This reply does not come from your master station');
      const id = this.v.identity;
      const body = await Bundle.open(o, { ecdhPriv: id.ecdhPriv, ecdhPub: id.ecdhPub, senderSignPub: this.v.master.signPub });
      if (body.kind !== 'reply' || body.device !== this.v.deviceId) throw new PhoneError('MISMATCH', 'Unexpected reply');
      if (body.inReplyTo !== null && (this.v.recentBundles || []).indexOf(body.inReplyTo) === -1) throw new PhoneError('MISMATCH', 'This reply does not answer a bundle from this phone');
      if (this.v.lastReplyAt && body.created <= this.v.lastReplyAt) throw new PhoneError('OLD', 'This reply is older than the data already on the phone');
      const r = body.receipt || { accepted: [], rejected: [], held: [], flagged: [], remap: {} };
      const done = new Set([].concat(r.accepted || [], (r.rejected || []).map((x) => x.id), (r.held || []).map((x) => x.id)));
      const rejected = this.v.pending.filter((c) => (r.rejected || []).some((x) => x.id === c.id)).map((c) => {
        const x = r.rejected.find((y) => y.id === c.id);
        return { id: c.id, action: c.payload.action, at: c.at, reason: x.reason, code: x.code };
      });
      this.v.pending = this.v.pending.filter((c) => !done.has(c.id));
      if (r.remap && Object.keys(r.remap).length) {
        this.v.pending = this.v.pending.map((c) => Object.assign({}, c, { payload: replaceDeep(c.payload, r.remap), gen: (c.gen || []).map((g) => ({ kind: g.kind, value: r.remap[g.value] || g.value })) }));
      }
      this.v.rejected = rejected.concat(this.v.rejected || []).slice(0, 100);
      this.applySlice(body);
      this.v.lastReplyAt = body.created;
      this.meta.lastSync = body.created;
      if (done.size || !this.v.pending.length) this.v.inTransit = null;
      this.rebuild();
      await this.saveVault();
      return { accepted: (r.accepted || []).length, rejected, held: r.held || [], flagged: r.flagged || [], pending: this.v.pending.length, counts: body.counts };
    }

    info() {
      this.requireEnrolled();
      return { profile: this.v.profile, pending: this.v.pending.map((c) => ({ id: c.id, action: c.payload.action, at: c.at, conflict: c.localConflict || null })), rejected: this.v.rejected || [], pool: this.v.pool.length, deviceId: this.v.deviceId, master: this.v.master.id, mark: this.v.mark };
    }
  }

  return { Core, PhoneError, APP_VERSION, secretOk };
});

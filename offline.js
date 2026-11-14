/* offline.js — connects the v66 screens to the phone's local engine, and adds the screens the offline
   version needs: enrollment, sync by animated QR or file, PIN change, automatic lock. */
(function () {
  'use strict';
  const IDLE_MS = 5 * 60 * 1000;          // automatic lock after 5 minutes without use
  const HIDDEN_MS = 60 * 1000;            // or 1 minute in the background
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;

  // ---------------------------------------------------------------- worker RPC
  const worker = new Worker('./worker.js');
  let seq = 0; const waiting = new Map();
  worker.onmessage = (e) => { const { id, result, error } = e.data; const p = waiting.get(id); if (!p) return; waiting.delete(id); if (error) { const er = new Error(error.message); er.code = error.code; p.reject(er); } else p.resolve(result); };
  const rpc = (method, ...args) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); worker.postMessage({ id, method, args }); });

  const READS = { init: 1, actInit: 1, ceoInit: 1, areaList: 1, pubLoad: 1, pubSearch: 1, majlisInit: 1, majlisSearch: 1, actClassInit: 1, actContribInit: 1, login: 1, logout: 1 };
  window.LocalBackend = {
    async call(body) {
      try {
        const r = await rpc('api', body);
        if (body && body.action === 'login' && r && r.success) afterLogin();
        else if (body && !READS[body.action]) updateBadge();
        return r;
      }
      catch (e) { if (e.code === 'LOCKED') return { success: false, code: 'SESSION_EXPIRED', error: 'انتهت الجلسة، يرجى تسجيل الدخول من جديد.' }; return { success: false, code: e.code || 'ERROR', error: e.message }; }
    },
    rpc
  };

  // ---------------------------------------------------------------- styles of the added screens
  const css = document.createElement('style');
  css.textContent = `
    #waslTitle{margin:0;line-height:0}
    #waslTitle img{display:block;margin:0 auto;width:min(62vw,250px);height:auto;filter:drop-shadow(0 3px 14px rgba(0,0,0,.7)) drop-shadow(0 1px 2px rgba(0,0,0,.5))}
    #waslSub{font-size:12px;letter-spacing:.45em;text-transform:uppercase;color:#f5d58ccc;margin-top:6px;font-weight:700}
    #offForgot{display:block;margin:14px auto 0;background:none;border:0;color:#fde68a;font-size:12.5px;font-weight:700;text-decoration:underline;cursor:pointer}
    #offForgotNote{margin-top:8px;font-size:12px;line-height:1.7;color:#fef3c7;text-align:center}
    #offLayer .hint{font-size:12px;color:#64748b;margin-top:4px}
    #offLayer .hint.ok{color:#047857;font-weight:700}
    #offLayer .hint.bad{color:#b91c1c;font-weight:700}
    #offLayer{position:fixed;inset:0;z-index:90;background:rgba(15,23,42,.72);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px}
    #offLayer .oc{background:#fff;border-radius:22px;max-width:560px;width:100%;padding:18px;margin:auto 0;box-shadow:0 25px 60px -15px rgba(0,0,0,.5);font-family:Tajawal,sans-serif;color:#0f172a}
    #offLayer h2{font-size:18px;font-weight:900;margin:0 0 8px}
    #offLayer p{font-size:13px;line-height:1.8;color:#334155;margin:6px 0}
    #offLayer label{display:block;font-size:12px;font-weight:800;margin:10px 0 4px;color:#1e293b}
    #offLayer input{width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:14px;font-size:15px;box-sizing:border-box}
    #offLayer .ob{display:block;width:100%;margin-top:10px;padding:13px;border-radius:14px;border:0;font-weight:900;font-size:14px;cursor:pointer;background:#1e382b;color:#fff;font-family:inherit}
    #offLayer .ob.l{background:#eef2f0;color:#1e382b}
    #offLayer .ob.r{background:#fee2e2;color:#b91c1c}
    #offLayer .note{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:10px 12px;font-size:12.5px;line-height:1.8}
    #offAreaHint .warn{background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:10px 12px;font-size:12.5px;line-height:1.8;color:#78350f}
    #offAreaHint .note{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:10px 12px;font-size:12.5px;line-height:1.8}
    #offAreaHint .ob{display:block;width:100%;padding:10px;border:0;border-radius:12px;background:#eef2f0;color:#1e382b;font-weight:800;font-family:inherit;cursor:pointer}
    #offLayer .warn{background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:10px 12px;font-size:12.5px;line-height:1.8;color:#78350f}
    #offLayer .err{background:#fef2f2;border:1px solid #fecaca;border-radius:14px;padding:10px 12px;font-size:12.5px;color:#7f1d1d;margin-top:8px}
    #offLayer .code{font-size:38px;font-weight:900;letter-spacing:5px;text-align:center;direction:ltr;padding:12px;background:#fffbeb;border:2px dashed #f59e0b;border-radius:16px;margin:10px 0;font-family:'Plus Jakarta Sans',sans-serif}
    #offLayer .row{display:flex;gap:8px}#offLayer .row>*{flex:1}
    #offLayer ul{font-size:12.5px;line-height:1.8;padding-inline-start:18px;margin:6px 0}
    #offLayer .x{float:left;background:none;border:0;font-size:22px;cursor:pointer;color:#64748b}
    #offLayer .steps{display:flex;gap:6px;margin:0 0 12px}
    #offLayer .steps>div{flex:1;text-align:center;font-size:11px;font-weight:800;color:#94a3b8}
    #offLayer .steps b{display:flex;align-items:center;justify-content:center;width:28px;height:28px;margin:0 auto 3px;border-radius:50%;background:#e2e8f0;color:#64748b;font-size:13px}
    #offLayer .steps .on{color:#1e382b}#offLayer .steps .on b{background:#1e382b;color:#fff}
    #offLayer .steps .done{color:#047857}#offLayer .steps .done b{background:#d1fae5;color:#047857}
    #offLayer .wait{background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:10px 12px;font-size:13px;font-weight:700;line-height:1.8;color:#78350f;margin:10px 0}
    #offLayer .sum{background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:10px 12px;font-size:13px;line-height:1.9;margin:8px 0}
    #offLayer .big{font-size:56px;line-height:1;text-align:center;margin:8px 0 2px}
    #offLayer .ob.g{background:#047857;color:#fff}
    #offLayer textarea{width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:14px;font-size:14px;box-sizing:border-box;font-family:inherit}
    #offSyncBtn{position:relative}
    #offSyncBadge{position:absolute;top:2px;left:2px;min-width:16px;height:16px;border-radius:9px;background:#d97706;color:#fff;font-size:10px;font-weight:800;display:none;align-items:center;justify-content:center;padding:0 3px}
    /* the header refresh button: on a phone, new data only comes with «أخذ التحيينات» */
    button[onclick="refreshLiveBackend()"]{display:none!important}
    #offTabWarn{position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#7c2d12;color:#fff;font-size:12px;font-weight:700;padding:8px 12px;text-align:center}
    /* login fields: dark with white text, also when focused or filled in by the phone (autofill paints them light) */
    #loginScreen input,#loginScreen input:focus,#loginScreen input:hover{background-color:#101c16 !important;color:#fff !important;-webkit-text-fill-color:#fff !important;caret-color:#fbbf24}
    #loginScreen input:-webkit-autofill,#loginScreen input:-webkit-autofill:focus,#loginScreen input:-webkit-autofill:hover{-webkit-box-shadow:0 0 0 1000px #101c16 inset !important;box-shadow:0 0 0 1000px #101c16 inset !important;-webkit-text-fill-color:#fff !important;transition:background-color 99999s}`;
  document.head.appendChild(css);

  let layer = null, widgets = [];
  function stopWidgets() { widgets.forEach((w) => { try { w.stop(); } catch (e) { /* stopped */ } }); widgets = []; }
  function show(html) {
    stopWidgets();
    if (!layer) { layer = document.createElement('div'); layer.id = 'offLayer'; document.body.appendChild(layer); }
    layer.innerHTML = '<div class="oc">' + html + '</div>';
    layer.scrollTop = 0;
    return layer;
  }
  function close() { stopWidgets(); if (layer) { layer.remove(); layer = null; } }
  function errBox(msg) { const e = $('#offErr'); if (e) { e.textContent = msg; e.style.display = 'block'; } }
  function download(name, text) {
    const file = new File([text], name, { type: 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => {}); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  function fileInput(onText) {
    const i = document.createElement('input'); i.type = 'file';
    i.onchange = () => { const f = i.files && i.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => onText(String(r.result).trim()); r.readAsText(f); };
    i.click();
  }
  const MSG = {
    WEAK: 'الرمز ضعيف: 8 أرقام على الأقل، أو كلمة مرور من 10 أحرف فأكثر.', BAD_SECRET: 'الرمز غير صحيح.', LOCKED: 'تم تعليق الدخول مؤقتاً بسبب محاولات خاطئة متكررة.',
    SEAL: 'هذا الرمز ليس لهذا الهاتف.', SIGNATURE: 'هذا الرمز غير صالح لهذا الهاتف.', MISMATCH: 'هذا الرمز لا يخص هذا الهاتف أو هذه المزامنة.',
    OLD: 'هذا رمز قديم.', FORMAT: 'هذا الرمز غير صالح.', VERSION: 'صيغة أحدث من التطبيق: حدّث التطبيق عند توفر الإنترنت.', BAD_INPUT: 'هذا ليس الرمز المنتظر.', MISMATCH_OWN: 'هذا رمزك أنت.', WIPED: 'مُسحت بيانات الهاتف بعد محاولات خاطئة كثيرة.'
  };
  const msgOf = (e) => MSG[e.code] || e.message;

  // ---------------------------------------------------------------- enrollment
  async function onboarding(st) {
    if (st.state === 'joining') {
      show(`<h2>متابعة التسجيل</h2><p>أدخل الرمز السري الذي اخترته لهذا الهاتف.</p><label>الرمز السري</label><input id="offPin" type="password" dir="ltr" autocomplete="current-password">
        <div id="offErr" class="err" style="display:none"></div><button class="ob" id="offGo">متابعة</button><button class="ob r" id="offRestart">البدء من جديد</button>`);
      $('#offGo').onclick = async () => { try { await rpc('unlock', $('#offPin').value); showJoin(await rpc('joinText')); } catch (e) { errBox(msgOf(e)); } };
      $('#offRestart').onclick = async () => { if (confirm('حذف ما بدأته والبدء من جديد؟')) { await rpc('wipe'); onboarding({ state: 'new' }); } };
      return;
    }
    show(`<h2>تسجيل هذا الهاتف</h2>
      ${standalone() ? '' : '<div class="warn">افتح التطبيق من أيقونته على الشاشة الرئيسية، لا من المتصفح.</div>'}
      <label>اسم الهاتف (مثلاً: هاتف أيمن)</label><input id="offLabel" maxlength="40">
      <label>الرمز السري للتطبيق</label><input id="offP1" type="password" dir="ltr" autocomplete="new-password">
      <div class="hint" id="offP1Hint">${PIN_RULE}</div>
      <label>أعد كتابة الرمز</label><input id="offP2" type="password" dir="ltr" autocomplete="new-password">
      <div class="hint" id="offP2Hint"></div>
      <div id="offErr" class="err" style="display:none"></div><button class="ob" id="offGo">متابعة</button>`);
    pinChecks('offP1', 'offP2', false);
    $('#offGo').onclick = async () => {
      const a = $('#offP1').value, b = $('#offP2').value;
      if (a !== b) return errBox('الرمزان غير متطابقين.');
      if (!$('#offLabel').value.trim()) return errBox('اكتب اسماً للهاتف.');
      $('#offGo').disabled = true;
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* not available */ }
      try { try { localStorage.setItem('offPinKind', /^\d+$/.test(a) ? 'digits' : 'text'); } catch (e) { /* none */ } showJoin(await rpc('join', $('#offLabel').value.trim(), a)); }
      catch (e) { errBox(msgOf(e)); $('#offGo').disabled = false; }
    };
  }
  // ---- PIN rules shown while typing (the phone checks them again when saving)
  const PIN_RULE = '8 أرقام على الأقل، أو كلمة سر من 10 أحرف فأكثر.';
  const PIN_RULE_STRONG = '12 حرفاً على الأقل، فيها حروف.';
  const pinOk = (v, strong) => (strong ? v.length >= 12 && /[^0-9]/.test(v) : /^\d{8,}$/.test(v) || (v.length >= 10 && /[^0-9]/.test(v)));
  function pinChecks(a, b, strong) {
    const A = $('#' + a), B = $('#' + b), hA = $('#' + a + 'Hint'), hB = $('#' + b + 'Hint');
    const rule = strong ? PIN_RULE_STRONG : PIN_RULE;
    const upd = () => {
      if (hA) { const ok = pinOk(A.value, strong); hA.className = 'hint' + (A.value ? (ok ? ' ok' : '') : ''); hA.textContent = ok ? '✓ ' + rule : rule; }
      if (hB) {
        if (!B.value) { hB.className = 'hint'; hB.textContent = ''; }
        else if (B.value === A.value) { hB.className = 'hint ok'; hB.textContent = '✓ الرمزان متطابقان'; }
        else { hB.className = 'hint bad'; hB.textContent = '✗ الرمزان غير متطابقين'; }
      }
    };
    A.addEventListener('input', upd); B.addEventListener('input', upd); upd();
  }
  function showJoin(joinText) {
    show(`<h2>1 — اعرض الرمز على الكاميرا</h2><div id="offQR"></div>
      <button class="ob" id="offNext">التالي: امسح الرمز</button><button class="ob l" id="offFile">حفظ الرمز كملف</button>`);
    QRUI.still($('#offQR'), joinText);
    $('#offFile').onclick = () => download('alasala-join.alasala', joinText);
    $('#offNext').onclick = scanEnroll;
  }
  function scanEnroll() {
    show(`<h2>2 — امسح الرمز</h2><p>وجّه الكاميرا نحو الرمز حتى يكتمل الشريط.</p><div id="offScan"></div>
      <div id="offErr" class="err" style="display:none"></div><button class="ob l" id="offFile">قراءة ملف بدلاً من ذلك</button><button class="ob l" id="offBack">رجوع</button>`);
    const done = async (text) => {
      try {
        const r = await rpc('enroll', text);
        show(`<h2>3 — تحقق من رقم المطابقة</h2><p>هل يظهر الرقم نفسه على الشاشة الأخرى؟</p><div class="code">${esc(r.code)}</div>
          <p>هذا الهاتف لـ <b>${esc(r.profile.name)}</b>.</p>
          <button class="ob" id="offYes">نعم، الرقم مطابق</button><button class="ob r" id="offNo">لا، الرقم مختلف</button>`);
        $('#offYes').onclick = () => (r.mustUpgradeSecret ? changeSecret(true) : finishEnroll());
        $('#offNo').onclick = async () => { await rpc('wipe'); alert('أُلغي التسجيل.'); onboarding({ state: 'new' }); };
      } catch (e) { errBox(msgOf(e)); setTimeout(scanEnroll, 2500); }
    };
    widgets.push(QRUI.scanner($('#offScan'), done, { allowSingle: false }));
    $('#offFile').onclick = () => fileInput(done);
    $('#offBack').onclick = async () => showJoin(await rpc('joinText'));
  }
  function finishEnroll() { close(); location.reload(); }

  function changeSecret(forced) {
    show(`${forced ? '' : '<button class="x" id="offX">×</button>'}<h2>${forced ? 'اختر كلمة مرور أقوى' : 'تغيير الرمز السري'}</h2>
      <label>الرمز الحالي</label><input id="offOld" type="password" dir="ltr">
      <label>الرمز الجديد</label><input id="offN1" type="password" dir="ltr" autocomplete="new-password">
      <div class="hint" id="offN1Hint"></div>
      <label>أعد كتابته</label><input id="offN2" type="password" dir="ltr" autocomplete="new-password">
      <div class="hint" id="offN2Hint"></div>
      <div id="offErr" class="err" style="display:none"></div><button class="ob" id="offGo">حفظ</button>`);
    if (!forced) $('#offX').onclick = close;
    if (forced) pinChecks('offN1', 'offN2', true);
    else rpc('details').then((d) => { const strong = /^T[345]$/.test((d && d.eduTier) || '') || /^A[34]$/.test((d && d.tier) || ''); pinChecks('offN1', 'offN2', strong); }).catch(() => pinChecks('offN1', 'offN2', false));
    $('#offGo').onclick = async () => {
      if ($('#offN1').value !== $('#offN2').value) return errBox('الرمزان غير متطابقين.');
      try {
        await rpc('changeSecret', $('#offOld').value, $('#offN1').value);
        try { localStorage.setItem('offPinKind', /^\d+$/.test($('#offN1').value) ? 'digits' : 'text'); } catch (e) { /* none */ }
        if (forced) finishEnroll(); else { close(); if (typeof showToast === 'function') showToast('تم تغيير الرمز', 'success'); }
      } catch (e) { errBox(e.code === 'WEAK' ? e.message.replace('Your role needs a passphrase of at least 12 characters, with letters', 'كلمة المرور: 12 حرفاً على الأقل، فيها حروف.').replace('Use at least 8 digits, or a passphrase of 10 characters or more', MSG.WEAK) : msgOf(e)); }
    };
  }

  // ---------------------------------------------------------------- sync
  const REASONS = { 'action not allowed': 'عملية غير مسموحة', 'bad payload': 'بيانات غير صالحة', 'refused after review': 'رفضتها الإدارة بعد المراجعة' };
  const ACTIONS = { saveAttendance: 'تسجيل حضور', addStudent: 'إضافة طالب', updateStudent: 'تحيين طالب', createCourse: 'فتح درس', updateCourse: 'تعديل درس', updateCourseBook: 'تغيير الكتاب', moveStudent: 'نقل طالب', requestDeletion: 'طلب إزالة', suggestNameChange: 'اقتراح اسم', markNoSession: 'درس لم ينعقد', clearNoSession: 'إلغاء «لم ينعقد»', markFeedSeen: 'قراءة التنبيهات', createRequest: 'طلب درس', assignRequest: 'إسناد طلب', setRequestStatus: 'حالة طلب', addRequestNote: 'ملاحظة', placeRequest: 'إدماج طلب', logFollowUp: 'متابعة', requestDetails: 'طلب تفاصيل', spotDecision: 'اعتماد فوري' };
  async function openSync() {
    let info, st;
    try { info = await rpc('info'); st = await rpc('status'); } catch (e) { return; }
    const last = st.lastSync;
    show(`<button class="x" id="offX">×</button><h2>المزامنة</h2>
      <p>تحيينات لم تُرسل بعد: <b>${info.pending.length}</b>${last ? '<br>آخر أخذ للتحيينات: ' + esc(String(last).slice(0, 16).replace('T', ' ')) : ''}</p>
      ${st.inTransit ? '<div class="note">تحييناتك مع <b>' + esc(st.inTransit.by) + '</b>.</div>' : ''}
      <button class="ob" id="offSend">إرسال التحيينات</button>
      <button class="ob" id="offRead">أخذ التحيينات</button>
      <button class="ob l" id="offCollect">استلام تحيينات شخص آخر</button>
      <button class="ob l" id="offDetails" style="display:none"></button>
      ${info.rejected.length ? '<h2 style="font-size:14px;margin-top:14px">تحيينات لم تُقبل</h2><ul>' + info.rejected.slice(0, 10).map((r) => '<li>' + esc(ACTIONS[r.action] || r.action) + ': ' + esc(REASONS[r.reason] || r.reason) + '</li>').join('') + '</ul>' : ''}
      <button class="ob l" id="offPinChange">تغيير الرمز السري</button>`);
    $('#offX').onclick = close;
    $('#offPinChange').onclick = () => changeSecret(false);
    $('#offCollect').onclick = collectFromSomeone;
    // T4: a course's member list for 14 days; A3 / A4: the programs summary and lists for 14 days
    rpc('details').then((d) => { if (d && (d.canCourse || d.canClass || d.prog)) { const b = $('#offDetails'); if (b) { b.textContent = detailsTitle(d); b.style.display = 'block'; b.onclick = openDetails; } } }).catch(() => {});
    $('#offSend').onclick = async () => {
      try {
        const b = await rpc('makeBundle');
        show(`<button class="x" id="offX">×</button><h2>اعرض الرمز على الكاميرا</h2><p>اترك الهاتف ثابتاً حتى يكتمل.</p><div id="offQR"></div>
          <button class="ob" id="offRead">التالي: أخذ التحيينات</button><button class="ob l" id="offFile">حفظ كملف / مشاركة</button>`);
        widgets.push(QRUI.player($('#offQR'), b.text, { chunk: 600, fps: 6 }));
        $('#offX').onclick = close;
        $('#offFile').onclick = () => download('wasl-' + new Date().toISOString().slice(0, 10) + '.alasala', b.text);
        $('#offRead').onclick = readReply;
      } catch (e) { alert(msgOf(e)); }
    };
    $('#offRead').onclick = readReply;
  }
  // ---------------------------------------------------------------- programs summary & details on request
  const pct = (v) => (v === null || v === undefined ? '—' : Math.round(v) + '٪');
  const small = (n) => (n === null || n === undefined || n > 30 ? '—' : n);
  const KIND = { course: 'الدرس ', class: 'الصف ', pub: 'الدرس العام ', area: 'القائمة الكاملة لصفوفك' };
  const dayOf = (iso) => esc(String(iso || '').slice(0, 10));
  async function openDetails() {
    let d; try { d = await rpc('details'); } catch (e) { return; }
    const p = d.prog;
    const classes = p ? p.classes : [];
    show(`<button class="x" id="offX">×</button><h2>${detailsTitle(d)}</h2>
      ${p ? `<p>من ${dayOf(p.from)} إلى ${dayOf(p.to)}.</p>
        <div style="overflow:auto"><table style="width:100%;font-size:12px;border-collapse:collapse" id="offProg"><tr style="background:#eef2f0"><th style="padding:6px;text-align:right">الصف</th><th>الأعضاء</th><th>الحضور</th><th>قبلها</th><th>الدرس العام</th><th>صرّحوا بمساهمة</th><th>دفعوا</th></tr>
        ${classes.map((c) => `<tr style="border-top:1px solid #e2e8f0"><td style="padding:6px">${esc(c.label)}${c.branch ? '<br><small style="color:#64748b">' + esc(c.branch) + '</small>' : ''}</td><td style="text-align:center">${small(c.members)}</td><td style="text-align:center">${pct(c.att)}</td><td style="text-align:center;color:#64748b">${pct(c.attPrev)}</td><td style="text-align:center">${pct(c.pub)}</td><td style="text-align:center">${pct(c.declared)}</td><td style="text-align:center">${pct(c.paid)}</td></tr>`).join('')}</table></div>
        ${p.councils && p.councils.length ? '<p>مجالس الذكر (30 يوماً): ' + p.councils.map((m) => esc(m.branch) + ' ' + pct(m.done)).join(' — ') + '</p>' : ''}
        <p style="font-size:11.5px;color:#64748b">يُحدَّث الملخص مع كل أخذ للتحيينات.</p>` : ''}
      ${d.grants.length ? '<h2 style="font-size:14px;margin-top:14px">تفاصيل على هاتفك الآن</h2><ul>' + d.grants.map((g) => '<li>' + KIND[g.kind] + esc(g.kind === 'class' ? labelOf(classes, g.ref) : g.kind === 'area' ? '' : g.ref) + (g.members !== null && g.members !== undefined ? ' (' + g.members + ' عضواً)' : '') + ' — تُمحى تلقائياً يوم ' + dayOf(g.until) + (g.kind === 'pub' ? '<br><small>سجّل الحضور من «الدرس العام» في قسم البرامج.</small>' : '') + (g.kind !== 'pub' && g.kind !== 'area' && g.people && g.people.length ? '<details><summary style="cursor:pointer;color:#1e382b;font-weight:800">عرض الأسماء</summary><ul style="margin:4px 0">' + g.people.map((x) => '<li>' + esc(x.name) + (x.level ? ' — م' + esc(x.level) : '') + (x.city ? ' — ' + esc(x.city) : '') + (x.phone ? ' — <a dir="ltr" href="tel:' + esc(x.phone) + '">' + esc(x.phone) + '</a>' : '') + '</li>').join('') + '</ul></details>' : '') + '</li>').join('') + '</ul>' : ''}
      ${d.asked.length ? '<div class="note">طلبات تُرسل مع التحيينات القادمة: ' + d.asked.map((a) => KIND[a.kind] + esc(a.kind === 'class' ? labelOf(classes, a.ref) : a.ref)).join('، ') + '</div>' : ''}
      ${d.canCourse ? `<h2 style="font-size:14px;margin-top:14px">طلب قائمة أعضاء درس</h2><p>اكتب رمز الدرس. تصل القائمة مع أخذ التحيينات، وتبقى على هاتفك 14 يوماً.</p>
        <input id="offCode" dir="ltr" maxlength="40" placeholder="رمز الدرس"><button class="ob" id="offAskCourse">طلب القائمة</button>` : ''}
      ${d.canClass && classes.length ? `<h2 style="font-size:14px;margin-top:14px">طلب قائمة أعضاء صف</h2><p>تصل القائمة مع أخذ التحيينات، وتبقى على هاتفك 14 يوماً.</p>
        <select id="offClass" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:14px;font-size:14px">${classes.map((c) => '<option value="' + esc(c.key) + '">' + esc(c.label) + (c.branch ? ' — ' + esc(c.branch) : '') + '</option>').join('')}</select>
        <button class="ob" id="offAskClass">طلب القائمة</button>` : ''}
      ${d.canPub && d.pubLessons.length ? `<h2 style="font-size:14px;margin-top:14px">درس عام أسجّل حضوره بالأسماء</h2><p>يصل الدرس وحصصه الأخيرة ومن حضرها، لمدة 14 يوماً. من لا يوجد على هاتفك يُضاف برقم هاتفه.</p>
        <select id="offPub" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:14px;font-size:14px">${d.pubLessons.map((l) => '<option value="' + esc(l.code) + '">' + esc(l.code) + ' — ' + esc(l.venue) + (l.day ? ' — ' + esc(l.day) : '') + '</option>').join('')}</select>
        <button class="ob" id="offAskPub">طلب الدرس</button>` : ''}
      <div id="offErr" class="err" style="display:none"></div>`);
    $('#offX').onclick = close;
    const ask = async (kind, ref) => {
      const r = await LocalBackend.call({ action: 'requestDetails', kind, ref });
      if (r && r.success) { updateBadge(); openDetails(); setTimeout(() => { const n = document.createElement('div'); n.className = 'note'; n.textContent = r.message; const c = $('#offLayer .oc'); if (c) c.insertBefore(n, c.children[2] || null); }, 50); }
      else errBox((r && r.error) || 'تعذّر الطلب');
    };
    if ($('#offAskCourse')) $('#offAskCourse').onclick = () => ask('course', $('#offCode').value);
    if ($('#offAskClass')) $('#offAskClass').onclick = () => ask('class', $('#offClass').value);
    if ($('#offAskPub')) $('#offAskPub').onclick = () => ask('pub', $('#offPub').value);
  }
  function detailsTitle(d) { return d.prog ? 'ملخص البرامج' : 'طلب قائمة أعضاء درس'; }
  function labelOf(classes, key) { const c = (classes || []).find((x) => x.key === key); return c ? c.label : key; }

  function collectFromSomeone() {
    show(`<button class="x" id="offX">×</button><h2>استلام تحيينات شخص آخر</h2><p>يضغط «إرسال التحيينات» على هاتفه، ثم وجّه الكاميرا نحو الرمز.</p><div id="offScan"></div>
      <div id="offErr" class="err" style="display:none"></div><button class="ob l" id="offFile">قراءة ملف بدلاً من ذلك</button>`);
    $('#offX').onclick = close;
    const done = async (text) => {
      try {
        const c = await rpc('collect', text);
        const back = await rpc('packFor', c.from, c.bundles);
        show(`<button class="x" id="offX">×</button><h2>استُلمت تحيينات ${esc(c.name)}</h2>
          <p>الآن يضغط ${esc(c.name)} «أخذ التحيينات» ويوجّه الكاميرا نحو هذا الرمز.</p>
          <div id="offQR"></div><button class="ob" id="offOk">تم</button><button class="ob l" id="offFile">حفظ كملف / مشاركة</button>`);
        widgets.push(QRUI.player($('#offQR'), back.text, { chunk: 600, fps: 6 }));
        $('#offX').onclick = close; $('#offOk').onclick = openSync;
        $('#offFile').onclick = () => download('wasl-' + new Date().toISOString().slice(0, 10) + '.alasala', back.text);
      } catch (e) { errBox(msgOf(e)); setTimeout(collectFromSomeone, 2500); }
    };
    widgets.push(QRUI.scanner($('#offScan'), done, { allowSingle: false }));
    $('#offFile').onclick = () => fileInput(done);
  }
  function readReply() {
    show(`<button class="x" id="offX">×</button><h2>أخذ التحيينات</h2><p>وجّه الكاميرا نحو الرمز.</p><div id="offScan"></div>
      <div id="offErr" class="err" style="display:none"></div><button class="ob l" id="offFile">قراءة ملف بدلاً من ذلك</button>`);
    $('#offX').onclick = close;
    const done = async (text) => {
      try {
        const x = await rpc('applyIncoming', text);
        const r = x.mine;
        show(`<h2>تم</h2>
          ${r ? `<p>قُبل: <b>${r.accepted}</b>${r.rejected.length ? ' — لم يُقبل: <b>' + r.rejected.length + '</b>' : ''}${r.held.length ? ' — للمراجعة: <b>' + r.held.length + '</b>' : ''}</p>` : ''}
          ${x.inTransit ? '<div class="note">تحييناتك مع <b>' + esc(x.inTransit.by) + '</b>.</div>' : ''}
          ${!r && !x.inTransit && !x.carriedDown ? '<p>لا جديد لك في هذا الرمز.</p>' : ''}
          ${r && r.rejected.length ? '<div class="err">لم يُقبل:<ul>' + r.rejected.map((y) => '<li>' + esc(ACTIONS[y.action] || y.action) + ': ' + esc(REASONS[y.reason] || y.reason) + '</li>').join('') + '</ul></div>' : ''}
          ${r && r.flagged.some((f) => /newer edit kept/.test(f.reason)) ? '<div class="warn">بعض تعديلاتك كانت أقدم من تعديل آخر على الخانة نفسها: بقي التعديل الأحدث.</div>' : ''}
          <button class="ob" id="offOk">حسناً</button>`);
        $('#offOk').onclick = () => { close(); if (r && typeof refreshLiveBackend === 'function') refreshLiveBackend(true); updateBadge(); const wb = $('#offWatchBtn'); if (wb) wb.remove(); addWatchButton(); areaBanner(); };
      } catch (e) { errBox(msgOf(e)); setTimeout(readReply, 2500); }
    };
    widgets.push(QRUI.scanner($('#offScan'), done, { allowSingle: false }));
    $('#offFile').onclick = () => fileInput(done);
  }
  async function updateBadge() {
    try { const st = await rpc('status'); const b = $('#offSyncBadge'); if (b) { b.textContent = st.pending; b.style.display = st.pending ? 'flex' : 'none'; } } catch (e) { /* locked */ }
  }

  // ---------------------------------------------------------------- login screen & header
  // ---------------------------------------------------------------- approval on the spot (teacher and T4 face to face)
  // Teacher: 1 show my code → 2 scan the T4's answer → 3 done.   T4: 1 scan the teacher's code → 2 decide → 3 show my answer.
  const SPOT_KIND = { deletion: 'إزالة عضو من درس', name: 'تغيير اسم عضو' };
  function steps(n, labels) {
    return '<div class="steps">' + labels.map((l, i) => '<div class="' + (i + 1 < n ? 'done' : i + 1 === n ? 'on' : '') + '"><b>' + (i + 1 < n ? '✓' : i + 1) + '</b>' + l + '</div>').join('') + '</div>';
  }
  const T_STEPS = ['رمز الطلب', 'جواب المدير', 'تمّ'], D_STEPS = ['مسح الطلب', 'القرار', 'رمز الجواب'];
  function spotSummary(kind, f, sh, from) {
    f = f || {}; sh = sh || {};
    let h = '<div class="sum"><b>' + esc(SPOT_KIND[kind] || kind) + '</b>';
    if (from) h += '<br>من: <b>' + esc(from) + '</b>';
    if (kind === 'deletion') h += '<br>العضو: <b>' + esc(sh.student || f.studentId) + '</b><br>الدرس: <b>' + esc(sh.course || f.courseCode) + '</b>';
    else h += '<br>الاسم الحالي: <b>' + esc(sh.current || sh.student || f.studentId) + '</b><br>الاسم المقترح: <b>' + esc(f.newName) + '</b>';
    if (f.reason) h += '<br>السبب: ' + esc(f.reason);
    return h + '</div>';
  }
  function qrBox(text) {
    const box = $('#offQR'); box.innerHTML = '';
    const c = document.createElement('canvas'); c.style.cssText = 'width:100%;max-width:340px;image-rendering:pixelated;background:#fff;border-radius:12px;display:block;margin:6px auto';
    box.appendChild(c); QRUI.drawQR(c, text, 'L');
  }
  function backToApp() { close(); if (typeof refreshLiveBackend === 'function') refreshLiveBackend(true); updateBadge(); }

  // ---- teacher
  async function spotStart(o) {
    let r;
    try { r = await rpc('spotStart', o.kind, o.fields, o.show); }
    catch (e) { show('<h2>تعذر</h2><div class="err">' + esc(msgOf(e)) + '</div><button class="ob" id="spOk">حسناً</button>'); $('#spOk').onclick = close; return; }
    spotShowRequest(r.text, o);
  }
  function spotShowRequest(text, o) {
    show(steps(1, T_STEPS) + '<h2>اعتماد فوري من المدير</h2>' + spotSummary(o.kind, o.fields, o.show) +
      '<p><b>اعرض هذا الرمز على المدير ليمسحه بهاتفه.</b></p><div id="offQR"></div>' +
      '<div class="wait">⏳ انتظر: المدير يمسح الرمز ثم يقرّر. حين يظهر على هاتفه رمز الجواب، اضغط الزر الأخضر.</div>' +
      '<button class="ob g" id="spNext">ظهر رمز الجواب على هاتف المدير: امسحه</button><button class="ob l" id="spCancel">إلغاء الطلب</button>');
    qrBox(text);
    $('#spNext').onclick = () => spotScanAnswer(text, o);
    $('#spCancel').onclick = async () => { try { await rpc('spotCancel'); } catch (e) { /* none */ } close(); };
  }
  function spotScanAnswer(text, o) {
    show(steps(2, T_STEPS) + '<h2>امسح جواب المدير</h2><p><b>وجّه الكاميرا نحو الرمز الظاهر على هاتف المدير.</b></p><div id="offScan"></div>' +
      '<div id="offErr" class="err" style="display:none"></div><button class="ob l" id="spBack">رجوع إلى رمز الطلب</button>');
    const done = async (t) => {
      try { spotDone(await rpc('spotFinish', t)); }
      catch (e) {
        if (e.code === 'SPOT_UNKNOWN') {
          show(steps(2, T_STEPS) + '<h2>تعذر التحقق من الجواب على هاتفك</h2><div class="warn">هاتفك لا يعرف هاتف هذا المدير بعد (يعرفه بعد أخذ التحيينات). لا شيء ضاع: هاتف المدير يحتفظ بقراره ويرسله إلى المحطة، وتصلك النتيجة مع التحيينات القادمة.</div><button class="ob" id="spOk">حسناً</button>');
          $('#spOk').onclick = async () => { try { await rpc('spotCancel'); } catch (x) { /* none */ } close(); };
          return;
        }
        errBox(e.code === 'MISMATCH' ? 'هذا الجواب لطلب آخر.' : e.code === 'BAD_INPUT' ? 'هذا ليس رمز جواب المدير.' : msgOf(e));
        setTimeout(() => spotScanAnswer(text, o), 2500);
      }
    };
    widgets.push(spotScanner = QRUI.scanner($('#offScan'), done, {}));
    $('#spBack').onclick = () => spotShowRequest(text, o);
  }
  function spotDone(r) {
    const yes = r.decision === 'approve';
    const what = r.kind === 'deletion' ? 'أُزيل العضو من الدرس على هاتفك.' : 'اعتُمد الاسم: <b>' + esc(r.finalName || '') + '</b>.';
    show(steps(4, T_STEPS) + '<div class="big" style="color:' + (yes ? '#047857' : '#b91c1c') + '">' + (yes ? '✓' : '✕') + '</div>' +
      '<h2 style="text-align:center">' + (yes ? 'تمّ: وافق ' + esc(r.by) : 'رفض ' + esc(r.by) + ' الطلب') + '</h2>' +
      (yes ? '<p style="text-align:center">' + (r.kind === 'name' && !r.finalName ? 'اعتُمد الاسم المقترح.' : what) + '</p>' : (r.note ? '<div class="sum">ملاحظة المدير: ' + esc(r.note) + '</div>' : '')) +
      '<div class="note">تتأكد المحطة من القرار مع التحيينات القادمة. يمكن للمدير الآن أن يضغط «إنهاء» على هاتفه.</div><button class="ob" id="spOk">إنهاء</button>');
    $('#spOk').onclick = backToApp;
  }

  // ---- T4
  function t4Scan() {
    show('<button class="x" id="offX">×</button>' + steps(1, D_STEPS) + '<h2>اعتماد طلب</h2><p><b>امسح الرمز الظاهر على هاتف المدرس.</b></p><div id="offScan"></div><div id="offErr" class="err" style="display:none"></div>');
    $('#offX').onclick = close;
    const done = async (t) => {
      try { t4Decide(t, await rpc('spotRead', t)); }
      catch (e) { errBox(e.code === 'BAD_INPUT' ? 'هذا ليس رمز طلب.' : e.code === 'MISMATCH_OWN' ? 'هذا رمزك أنت.' : e.code === 'OLD' ? 'هذا الطلب قديم: يعيده المدرس.' : msgOf(e)); setTimeout(t4Scan, 2500); }
    };
    widgets.push(spotScanner = QRUI.scanner($('#offScan'), done, {}));
  }
  function t4Decide(text, d) {
    show(steps(2, D_STEPS) + '<h2>قرّر</h2>' + spotSummary(d.kind, d.fields, d.show, d.from) +
      (d.kind === 'name' ? '<label>الاسم المعتمد (يمكنك تصحيحه)</label><input id="spName" value="' + esc(d.fields.newName) + '">' : '') +
      '<label>ملاحظة (إجبارية عند الرفض)</label><textarea id="spNote" rows="2" maxlength="200"></textarea>' +
      '<div id="offErr" class="err" style="display:none"></div>' +
      '<div class="wait">⏳ المدرس ينتظر قرارك.</div>' +
      '<div class="row"><button class="ob g" id="spYes">موافقة</button><button class="ob r" id="spNo">رفض</button></div><button class="ob l" id="spBack">إلغاء</button>');
    const go = async (decision) => {
      const note = $('#spNote').value.trim();
      if (decision === 'reject' && !note) return errBox('اكتب سبب الرفض في الملاحظة.');
      const name = $('#spName') ? $('#spName').value.trim() : '';
      if (d.kind === 'name' && decision === 'approve' && name.length < 2) return errBox('اكتب الاسم المعتمد.');
      $('#spYes').disabled = $('#spNo').disabled = true;
      try { t4Answer(await rpc('spotDecide', text, decision, note, name), decision); }
      catch (e) { errBox(msgOf(e)); $('#spYes').disabled = $('#spNo').disabled = false; }
    };
    $('#spYes').onclick = () => go('approve'); $('#spNo').onclick = () => go('reject');
    $('#spBack').onclick = close;
  }
  function t4Answer(r, decision) {
    show(steps(3, D_STEPS) + '<h2>' + (decision === 'approve' ? 'وافقت' : 'رفضت') + ': اعرض هذا الرمز على المدرس</h2><div id="offQR"></div>' +
      '<div class="wait">⏳ انتظر حتى تظهر «تمّ» على هاتف المدرس، ثم اضغط «إنهاء».</div>' +
      '<div class="note">قرارك محفوظ على هاتفك ويصل إلى المحطة مع المزامنة القادمة، حتى لو لم يمسح المدرس هذا الرمز.</div><button class="ob" id="spOk">إنهاء</button>');
    qrBox(r.text);
    $('#spOk').onclick = backToApp;
  }
  async function addSpotButton() {
    let info; try { info = await rpc('info'); } catch (e) { return; }
    if (!info || !info.profile || info.profile.tier !== 'T4' || $('#offSpotBtn')) return;
    const sync = $('#offSyncBtn'); if (!sync || !sync.parentNode) return;
    const b = document.createElement('button'); b.id = 'offSpotBtn'; b.type = 'button'; b.title = 'اعتماد طلب فوري'; b.className = sync.className;
    b.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>';
    sync.parentNode.insertBefore(b, sync);
    b.onclick = t4Scan;
  }
  let spotScanner = null;
  // feed: the same as a code read by the camera (used to read a code from a picture or by the tests)
  window.WaslSpot = { start: spotStart, feed: (t) => spotScanner && spotScanner.feed(t) };

  async function afterLogin() {
    setTimeout(updateBadge, 300);
    setTimeout(addSpotButton, 750);
    setTimeout(a4Banner, 600);
    setTimeout(addWatchButton, 700);
    setTimeout(areaBanner, 800);
    // the programs screens are drawn later (department switch): add the hint each time they are drawn
    if (typeof renderActivities === 'function' && !renderActivities.__hint) {
      const ra = renderActivities;
      window.renderActivities = function () { const r = ra.apply(this, arguments); setTimeout(areaBanner, 50); return r; };
      window.renderActivities.__hint = true;
    }
    const st = await rpc('status');
    if (st.mustUpgradeSecret) setTimeout(() => changeSecret(true), 400);
  }
  /** A4: on the phone, percentages and lists on request; the full programs view stays on the master. */
  /** A4 on a phone: contribution details and the setup checks stay on the master; T4: no «courses I follow» tab. */
  async function a4Banner() {
    let d; try { d = await rpc('details'); } catch (e) { return; }
    if (!d) return;
    if (d.tier === 'A4' && !$('#offA4css')) {
      const css2 = document.createElement('style'); css2.id = 'offA4css'; css2.textContent = '#actContrib,#actAreas,#actReports{display:none!important}'; document.head.appendChild(css2);
    }
    if (d.eduTier === 'T4') {
      // a T4 phone holds its own courses only: the second tab would always be empty
      const tabs = $('#roleWorkspaceTabs'); if (tabs) tabs.style.display = 'none';
      if (typeof switchWorkspaceTab === 'function') switchWorkspaceTab('personal');
    }
  }
  // ---------------------------------------------------------------- «متابعة الفريق» (T3, A3): red flags only
  const sinceTxt = (n) => (n === null || n === undefined ? 'لا شيء بعد' : n === 0 ? 'اليوم' : n === 1 ? 'منذ يوم' : n === 2 ? 'منذ يومين' : 'منذ ' + n + (n <= 10 ? ' أيام' : ' يوماً'));
  async function addWatchButton() {
    let d; try { d = await rpc('details'); } catch (e) { return; }
    const w = d && d.watch; if (!w || $('#offWatchBtn')) return;
    const sync = $('#offSyncBtn'); if (!sync || !sync.parentNode) return;
    const b = document.createElement('button'); b.id = 'offWatchBtn'; b.type = 'button'; b.title = 'متابعة تحت إشرافي';
    b.className = sync.className;
    b.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg><span id="offWatchBadge"></span>';
    b.style.position = 'relative';
    sync.parentNode.insertBefore(b, sync);
    const red = (w.edu ? w.edu.red : 0) + (w.act ? w.act.red : 0);
    const bd = $('#offWatchBadge');
    if (red) { bd.textContent = red > 30 ? '+' : String(red); bd.style.cssText = 'position:absolute;top:2px;left:2px;min-width:16px;height:16px;border-radius:8px;background:#dc2626;color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;padding:0 3px'; }
    b.onclick = openWatch;
  }
  function li(t, red) { return '<li style="margin:3px 0' + (red ? ';color:#b91c1c;font-weight:700' : '') + '">' + t + '</li>'; }
  async function openWatch() {
    let d; try { d = await rpc('details'); } catch (e) { return; }
    const w = d.watch; if (!w) return;
    let h = '<button class="x" id="offX">×</button><h2>متابعة تحت إشرافي</h2><p style="font-size:12px;color:#64748b">حتى ' + dayOf(w.asOf) + '، يُحدَّث مع كل أخذ للتحيينات.</p>';
    if (w.edu) {
      const L = w.edu.limits;
      const flagged = w.edu.teachers.filter((t) => t.red), calm = w.edu.teachers.filter((t) => !t.red);
      h += '<h2 style="font-size:15px;margin-top:10px">التعليم</h2>';
      if (!flagged.length) h += '<div class="note">لا ملاحظات.</div>';
      flagged.forEach((t) => {
        const items = [];
        if (t.askUpdate) items.push(li((t.sinceDays === null ? 'لم يصل منه أي تحيين' : 'آخر تحيين منه ' + sinceTxt(t.sinceDays)) + ': اطلب منه التحيينات', true));
        const never = t.courses.filter((c) => c.flags.indexOf('never') !== -1).map((c) => esc(c.label || c.code));
        if (never.length) items.push(li((never.length > 1 ? 'دروس لم تبدأ (لا حصة مسجّلة): ' : 'درس لم يبدأ (لا حصة مسجّلة): ') + never.join('، '), true));
        t.courses.forEach((c) => {
          if (c.flags.indexOf('stopped') !== -1) items.push(li('الدرس ' + esc(c.label || c.code) + ': لا حصة منذ ' + L.STALE_DAYS + ' يوماً، آخر حصة ' + sinceTxt(c.sinceDays) + ' (إن توقف، يحدّث المدرس حالة الدرس)', true));
          if (c.flags.indexOf('notHeld') !== -1) items.push(li('الدرس ' + esc(c.label || c.code) + ': لم يُعقد ' + c.notHeld + ' مرات في ' + L.NOT_HELD_WINDOW + ' يوماً', true));
        });
        if (t.absent.length) items.push(li('غائبون دون اتصال:<ul style="margin:2px 0;padding-right:16px">' + t.absent.map((x) => '<li>' + esc(x.name) + ' — ' + esc(x.course) + ' — ' + x.streak + ' غيابات متتالية</li>').join('') + '</ul>', false));
        h += '<div style="border:1px solid #fecaca;background:#fff7f7;border-radius:14px;padding:10px 12px;margin:8px 0"><b>' + esc(t.name) + '</b><ul style="margin:4px 0;padding-right:16px">' + items.join('') + '</ul></div>';
      });
      if (calm.length) h += '<p style="font-size:12px;color:#047857">دون ملاحظات: ' + calm.map((t) => esc(t.name)).join('، ') + '</p>';
      const declared = [];
      w.edu.teachers.forEach((t) => t.courses.forEach((c) => { if (c.declared === 'متوقف') declared.push(esc(c.label || c.code) + ' (' + esc(t.name) + (c.stopReason ? '، ' + esc(c.stopReason) : '') + ')'); }));
      if (declared.length) h += '<p style="font-size:12px;color:#64748b">دروس متوقفة بإعلان المدرس: ' + declared.join('، ') + '</p>';
    }
    if (w.act) {
      h += '<h2 style="font-size:15px;margin-top:12px">البرامج — ' + esc(w.act.month) + '</h2>';
      w.act.classes.forEach((c) => {
        const items = [];
        if (!c.out) items.push(li('درس الصف: ' + (c.lastRoll ? 'آخر حضور ' + sinceTxt(c.sinceDays) : 'لا حضور مسجّل'), c.stopped));
        items.push(li('المساهمة الشهرية: ' + (c.paidPct === null ? 'لا أعضاء في المستوى 7' : c.paidPct + '٪ دفعوا'), !!c.payLate));
        if (c.notPaid.length) items.push('<li><details><summary style="cursor:pointer;font-weight:700">لم يدفعوا هذا الشهر</summary><ul style="margin:2px 0;padding-right:16px">' + c.notPaid.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></details></li>');
        if (c.level7.length) items.push('<li><details><summary style="cursor:pointer;font-weight:700">أعضاء المستوى 7</summary><ul style="margin:2px 0;padding-right:16px">' + c.level7.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></details></li>');
        h += '<div style="border:1px solid ' + (c.red ? '#fecaca;background:#fff7f7' : '#d1fae5;background:#f6fffa') + ';border-radius:14px;padding:10px 12px;margin:8px 0"><b>' + esc(c.label) + '</b><ul style="margin:4px 0;padding-right:16px">' + items.join('') + '</ul></div>';
      });
      h += areaHint(d);
    }
    show(h + '<div id="offErr" class="err" style="display:none"></div>');
    $('#offX').onclick = close;
    bindAreaAsk(openWatch);
  }
  /** A3: how much of the area is not on the phone, and the 7-day full list. */
  function areaHint(d) {
    const w = d.watch, hid = w && w.act && w.act.hidden;
    if (!d.canArea || !hid) return '';
    const g = (d.grants || []).find((x) => x.kind === 'area');
    if (g) return '<div class="note">القائمة الكاملة لصفوفك على هاتفك حتى ' + dayOf(g.until) + '.</div>';
    if (d.asked.some((a) => a.kind === 'area')) return '<div class="note">طلب القائمة الكاملة يُرسل مع التحيينات القادمة.</div>';
    if (!hid.pct) return '';
    return '<div class="warn" style="margin-top:10px">' + hid.pct + '٪ من أعضاء صفوفك غير ظاهرين على هاتفك (المستويان 1 و2).<button class="ob l" id="offAskArea" style="margin-top:8px">طلب القائمة الكاملة لمدة 7 أيام</button><div style="font-size:11.5px;margin-top:4px">تصلك مع أخذ التحيينات القادم.</div></div>';
  }
  function bindAreaAsk(after, id) {
    const b = $('#' + (id || 'offAskArea')); if (!b) return;
    b.onclick = async () => {
      const r = await LocalBackend.call({ action: 'requestDetails', kind: 'area', ref: 'all' });
      if (r && r.success) { updateBadge(); after(); if (after !== areaBanner) areaBanner(); } else errBox((r && r.error) || 'تعذّر الطلب');
    };
  }
  /** A3: the same hint at the top of the programs screens, so nobody takes the list for complete. */
  async function areaBanner() {
    let d; try { d = await rpc('details'); } catch (e) { return; }
    const html = d ? areaHint(d) : '';
    let el = $('#offAreaHint');
    const tabs = $('#actSubTabs'); if (!tabs || !tabs.parentNode) return;
    if (!html) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'offAreaHint'; tabs.parentNode.insertBefore(el, tabs); }
    el.innerHTML = html.replace('margin-top:10px', 'margin-bottom:10px').replace('id="offAskArea"', 'id="offAskAreaTop"');
    bindAreaAsk(areaBanner, 'offAskAreaTop');
  }
  function addSyncButton() {
    const hdr = document.querySelector('#appShell header .flex.items-center.gap-1\\.5');
    if (!hdr || $('#offSyncBtn')) return;
    const b = document.createElement('button');
    b.id = 'offSyncBtn'; b.type = 'button'; b.title = 'المزامنة';
    b.className = 'p-2.5 rounded-xl text-slate-600 hover:text-olive-700 hover:bg-slate-200/60 transition-all cursor-pointer';
    b.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7h11m0 0l-3-3m3 3l-3 3M20 17H9m0 0l3-3m-3 3l3 3"/></svg><span id="offSyncBadge"></span>';
    b.onclick = openSync;
    hdr.insertBefore(b, hdr.firstChild);
  }
  async function prepareLogin(st) {
    const email = $('#loginEmailInput');
    // one phone = one person: the e-mail is not asked, only the PIN
    if (email) { email.value = st.email; email.readOnly = true; const box = email.parentElement && email.parentElement.parentElement; if (box) box.style.display = 'none'; }
    const pin = $('#loginPinInput');
    try { if (pin && localStorage.getItem('offPinKind') === 'text') pin.setAttribute('inputmode', 'text'); } catch (e) { /* none */ }
    const form = document.querySelector('#loginScreen form');
    if (form && !$('#offForgot')) {
      const f = document.createElement('div');
      f.innerHTML = '<button type="button" id="offForgot">نسيت الرمز السري؟</button><div id="offForgotNote" style="display:none">راجع مسؤولك ليعيد تسجيل هذا الهاتف.<br>ما أرسلته من قبل محفوظ ويعود إليك بعد التسجيل.</div>';
      form.parentNode.insertBefore(f, form.nextSibling);
      $('#offForgot').onclick = () => { const n = $('#offForgotNote'); n.style.display = n.style.display === 'none' ? 'block' : 'none'; };
    }
    if (!standalone() && !$('#offTabWarn')) {
      const w = document.createElement('div'); w.id = 'offTabWarn';
      w.textContent = 'افتح التطبيق من أيقونته على الشاشة الرئيسية، لا من المتصفح.';
      document.body.insertBefore(w, document.body.firstChild);
    }
  }

  // ---------------------------------------------------------------- no big numbers on screen
  // Rule: a count above 30 is not shown in the app's screens (percentages, dates, times, phone numbers and ids are untouched).
  // the 30 rule (counts above 30 hidden): shared/count-cap.js
  const capText = (t) => window.CountCap.capText(t);
  function watchCounts() { window.CountCap.watch(document.getElementById('appShell')); }
  window.__offlineCapText = capText;

  // ---------------------------------------------------------------- automatic lock
  const loggedIn = () => typeof AppState !== 'undefined' && !!AppState.currentUser;
  window.__offlineLoggedIn = loggedIn;
  let lastUse = Date.now(), hiddenAt = 0;
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { lastUse = Date.now(); }, { passive: true }));
  async function lockNow() {
    try { await rpc('lock'); } catch (e) { /* already */ }
    close();
    if (typeof handleLogout === 'function' && loggedIn()) handleLogout(false);
  }
  setInterval(() => { if (Date.now() - lastUse > IDLE_MS && loggedIn()) lockNow(); }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > HIDDEN_MS && loggedIn()) lockNow();
  });

  // ---------------------------------------------------------------- start
  async function start() {
    addSyncButton();
    watchCounts();
    // every way out of the app (button, expired session) also closes the phone's data
    if (typeof window.handleLogout === 'function' && !window.handleLogout.__offline) {
      const orig = window.handleLogout;
      window.handleLogout = function () { rpc('lock').catch(() => {}); close(); return orig.apply(this, arguments); };
      window.handleLogout.__offline = true;
    }
    let st;
    try { st = await rpc('status'); } catch (e) { return; }
    if (st.state !== 'enrolled') return onboarding(st);
    prepareLogin(st);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

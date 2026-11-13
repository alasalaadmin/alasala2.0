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
    #offLayer .warn{background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:10px 12px;font-size:12.5px;line-height:1.8;color:#78350f}
    #offLayer .err{background:#fef2f2;border:1px solid #fecaca;border-radius:14px;padding:10px 12px;font-size:12.5px;color:#7f1d1d;margin-top:8px}
    #offLayer .code{font-size:38px;font-weight:900;letter-spacing:5px;text-align:center;direction:ltr;padding:12px;background:#fffbeb;border:2px dashed #f59e0b;border-radius:16px;margin:10px 0;font-family:'Plus Jakarta Sans',sans-serif}
    #offLayer .mark{font-size:34px;text-align:center;margin:8px 0}
    #offLayer .row{display:flex;gap:8px}#offLayer .row>*{flex:1}
    #offLayer ul{font-size:12.5px;line-height:1.8;padding-inline-start:18px;margin:6px 0}
    #offLayer .x{float:left;background:none;border:0;font-size:22px;cursor:pointer;color:#64748b}
    #offSyncBtn{position:relative}
    #offSyncBadge{position:absolute;top:2px;left:2px;min-width:16px;height:16px;border-radius:9px;background:#d97706;color:#fff;font-size:10px;font-weight:800;display:none;align-items:center;justify-content:center;padding:0 3px}
    #offMark{margin-top:10px;text-align:center;color:#fde68a;font-size:12px;font-weight:700}
    #offMark b{display:block;font-size:30px;margin-top:2px}
    #offTabWarn{background:#7c2d12;color:#fff;font-size:12px;font-weight:700;padding:8px 12px;text-align:center}`;
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
    SEAL: 'هذا الرمز ليس لهذا الهاتف.', SIGNATURE: 'هذا الرد ليس من محطتك الرئيسية: رُفض.', MISMATCH: 'هذا الرمز لا يخص هذا الهاتف أو هذه المزامنة.',
    OLD: 'هذا رد قديم: بيانات الهاتف أحدث منه.', FORMAT: 'هذا ليس رمز مزامنة صالحاً.', VERSION: 'صيغة أحدث من التطبيق: حدّث التطبيق عند توفر الإنترنت.', BAD_INPUT: 'هذا ليس الرمز المنتظر.', MISMATCH_OWN: 'هذا رمزك أنت.', WIPED: 'مُسحت بيانات الهاتف بعد محاولات خاطئة كثيرة.'
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
      <p>يعمل التطبيق دون إنترنت. يُسجَّل الهاتف مرة واحدة أمام المحطة الرئيسية، ثم تتم المزامنة وجهاً لوجه برمز متحرك.</p>
      ${standalone() ? '' : '<div class="warn">افتح التطبيق دائماً من أيقونته على الشاشة الرئيسية، لا من المتصفح، حتى لا يمسح الهاتف بياناته. على أندرويد: قائمة المتصفح ← «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».</div>'}
      <div class="note">قبل البدء: يجب أن يكون للهاتف قفل شاشة (رمز أو بصمة).</div>
      <label>اسم الهاتف (مثلاً: هاتف أيمن)</label><input id="offLabel" maxlength="40">
      <label>الرمز السري للتطبيق</label><input id="offP1" type="password" dir="ltr" autocomplete="new-password">
      <label>أعد كتابة الرمز</label><input id="offP2" type="password" dir="ltr" autocomplete="new-password">
      <p style="font-size:12px">8 أرقام على الأقل. المشرفون والمسؤولون (T3، T4، A3، A4، T5): كلمة مرور من 12 حرفاً على الأقل فيها حروف.</p>
      <div id="offErr" class="err" style="display:none"></div><button class="ob" id="offGo">متابعة</button>`);
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
  function showJoin(joinText) {
    show(`<h2>١ — اعرض هذا الرمز على المحطة</h2><p>وجّه الشاشة نحو كاميرا حاسوب المحطة الرئيسية (قسم «تسجيل هاتف»).</p><div id="offQR"></div>
      <button class="ob" id="offNext">التالي: امسح رمز المحطة</button><button class="ob l" id="offFile">حفظ الرمز كملف</button>`);
    QRUI.still($('#offQR'), joinText);
    $('#offFile').onclick = () => download('alasala-join.alasala', joinText);
    $('#offNext').onclick = scanEnroll;
  }
  function scanEnroll() {
    show(`<h2>٢ — امسح رمز المحطة</h2><p>وجّه كاميرا الهاتف نحو الرمز المتحرك على شاشة المحطة حتى يكتمل الشريط.</p><div id="offScan"></div>
      <div id="offErr" class="err" style="display:none"></div><button class="ob l" id="offFile">قراءة ملف بدلاً من ذلك</button><button class="ob l" id="offBack">رجوع</button>`);
    const done = async (text) => {
      try {
        const r = await rpc('enroll', text);
        show(`<h2>٣ — تحقق من رقم المطابقة</h2><p>هل يظهر الرقم نفسه على شاشة المحطة الرئيسية؟</p><div class="code">${esc(r.code)}</div>
          <p>هذا الهاتف لـ <b>${esc(r.profile.name)}</b>. علامتك الشخصية (تظهر دائماً على شاشة الدخول في تطبيقك الحقيقي):</p><div class="mark">${esc(r.mark)}</div>
          <button class="ob" id="offYes">نعم، الرقم مطابق</button><button class="ob r" id="offNo">لا، الرقم مختلف</button>`);
        $('#offYes').onclick = () => (r.mustUpgradeSecret ? changeSecret(true) : finishEnroll());
        $('#offNo').onclick = async () => { await rpc('wipe'); alert('أُلغي التسجيل. أعد المحاولة مع المحطة الرئيسية وأبلغ المسؤول.'); onboarding({ state: 'new' }); };
      } catch (e) { errBox(msgOf(e)); setTimeout(scanEnroll, 2500); }
    };
    widgets.push(QRUI.scanner($('#offScan'), done, { allowSingle: false }));
    $('#offFile').onclick = () => fileInput(done);
    $('#offBack').onclick = async () => showJoin(await rpc('joinText'));
  }
  function finishEnroll() { close(); location.reload(); }

  function changeSecret(forced) {
    show(`${forced ? '' : '<button class="x" id="offX">×</button>'}<h2>${forced ? 'صفتك تتطلب كلمة مرور أقوى' : 'تغيير الرمز السري'}</h2>
      ${forced ? '<p>تحمل في هاتفك بيانات أكثر: اختر كلمة مرور من 12 حرفاً على الأقل فيها حروف.</p>' : ''}
      <label>الرمز الحالي</label><input id="offOld" type="password" dir="ltr">
      <label>الرمز الجديد</label><input id="offN1" type="password" dir="ltr" autocomplete="new-password">
      <label>أعد كتابته</label><input id="offN2" type="password" dir="ltr" autocomplete="new-password">
      <div id="offErr" class="err" style="display:none"></div><button class="ob" id="offGo">حفظ</button>`);
    if (!forced) $('#offX').onclick = close;
    $('#offGo').onclick = async () => {
      if ($('#offN1').value !== $('#offN2').value) return errBox('الرمزان غير متطابقين.');
      try {
        await rpc('changeSecret', $('#offOld').value, $('#offN1').value);
        try { localStorage.setItem('offPinKind', /^\d+$/.test($('#offN1').value) ? 'digits' : 'text'); } catch (e) { /* none */ }
        if (forced) finishEnroll(); else { close(); if (typeof showToast === 'function') showToast('تم تغيير الرمز', 'success'); }
      } catch (e) { errBox(e.code === 'WEAK' ? e.message.replace('Your role needs a passphrase of at least 12 characters, with letters', 'صفتك تتطلب كلمة مرور من 12 حرفاً على الأقل فيها حروف.').replace('Use at least 8 digits, or a passphrase of 10 characters or more', MSG.WEAK) : msgOf(e)); }
    };
  }

  // ---------------------------------------------------------------- sync
  const REASONS = { 'action not allowed': 'عملية غير مسموحة', 'bad payload': 'بيانات غير صالحة', 'refused after review': 'رفضتها الإدارة بعد المراجعة' };
  const ACTIONS = { saveAttendance: 'تسجيل حضور', addStudent: 'إضافة طالب', updateStudent: 'تحيين طالب', createCourse: 'فتح درس', updateCourse: 'تعديل درس', updateCourseBook: 'تغيير الكتاب', moveStudent: 'نقل طالب', requestDeletion: 'طلب إزالة', suggestNameChange: 'اقتراح اسم', markNoSession: 'درس لم ينعقد', clearNoSession: 'إلغاء «لم ينعقد»', markFeedSeen: 'قراءة التنبيهات', createRequest: 'طلب درس', assignRequest: 'إسناد طلب', setRequestStatus: 'حالة طلب', addRequestNote: 'ملاحظة', placeRequest: 'إدماج طلب', logFollowUp: 'متابعة', requestDetails: 'طلب تفاصيل' };
  async function openSync() {
    let info, st;
    try { info = await rpc('info'); st = await rpc('status'); } catch (e) { return; }
    const last = st.lastSync;
    show(`<button class="x" id="offX">×</button><h2>مزامنة مع المحطة</h2>
      <p>تغييرات لم تصل إلى المحطة بعد: <b>${info.pending.length}</b>${last ? ' — آخر رد من المحطة: ' + esc(String(last).slice(0, 16).replace('T', ' ')) : ''}</p>
      ${st.inTransit ? '<div class="note">تغييراتك في الطريق مع <b>' + esc(st.inTransit.by) + '</b> منذ ' + esc(String(st.inTransit.at).slice(0, 16).replace('T', ' ')) + '. تبقى على هاتفك حتى يصل رد المحطة.</div>' : ''}
      <div class="note">١) «إرسال تغييراتي»: اعرض الرمز على كاميرا المحطة أو على من يحمل التحديثات (مشرفك). ٢) «قراءة الرد»: من المحطة أو ممن حمل تحديثاتك. لا يُمحى شيء من الهاتف قبل وصول رد المحطة.</div>
      <button class="ob" id="offSend">١ — إرسال تغييراتي${st.carrying.up ? ' (+ ' + st.carrying.up + ' أحمله لغيري)' : ''}</button>
      <button class="ob" id="offRead">٢ — قراءة الرد</button>
      <h2 style="font-size:14px;margin-top:16px">حمل تحديثات الآخرين</h2>
      <p>أحمل الآن: <b>${st.carrying.up}</b> تحديثاً إلى المحطة و<b>${st.carrying.down}</b> رداً لأصحابها. كلها مختومة: لا يمكنك قراءتها ولا تغييرها.</p>
      <button class="ob l" id="offCollect">استلام تحديثات شخص وإعطاؤه ردوده</button>
      ${info.pending.some((c) => c.conflict) ? '<div class="warn" style="margin-top:10px">بعض التغييرات لم تعد تنطبق على آخر بيانات المحطة؛ ستقرر المحطة بشأنها.</div>' : ''}
      ${info.rejected.length ? '<h2 style="font-size:14px;margin-top:14px">تغييرات رفضتها المحطة</h2><ul>' + info.rejected.slice(0, 10).map((r) => '<li>' + esc(ACTIONS[r.action] || r.action) + ': ' + esc(REASONS[r.reason] || r.reason) + '</li>').join('') + '</ul>' : ''}
      <button class="ob l" id="offDetails" style="display:none">ملخص البرامج وطلب التفاصيل</button>
      <button class="ob l" id="offPinChange">تغيير الرمز السري</button>`);
    $('#offX').onclick = close;
    rpc('details').then((d) => { if (d && (d.canCourse || d.canClass || d.prog)) { const b = $('#offDetails'); if (b) { b.style.display = 'block'; b.onclick = openDetails; } } }).catch(() => {});
    $('#offPinChange').onclick = () => changeSecret(false);
    $('#offCollect').onclick = collectFromSomeone;
    $('#offSend').onclick = async () => {
      try {
        const b = await rpc('makeBundle');
        show(`<button class="x" id="offX">×</button><h2>اعرض هذا الرمز</h2><p>على كاميرا المحطة، أو على من يحمل التحديثات. ${b.changes} تغيير${b.carried ? ' + ' + b.carried + ' تحديثاً تحمله لغيرك' : ''}. اترك الهاتف ثابتاً حتى يكتمل الاستلام.</p><div id="offQR"></div>
          <button class="ob" id="offRead">التالي: قراءة الرد</button><button class="ob l" id="offFile">حفظ كملف / مشاركة</button>`);
        widgets.push(QRUI.player($('#offQR'), b.text, { chunk: 600, fps: 6 }));
        $('#offX').onclick = close;
        $('#offFile').onclick = () => download('alasala-' + new Date().toISOString().slice(0, 10) + '.alasala', b.text);
        $('#offRead').onclick = readReply;
      } catch (e) { alert(msgOf(e)); }
    };
    $('#offRead').onclick = readReply;
  }
  // ---------------------------------------------------------------- programs summary & details on request
  const pct = (v) => (v === null || v === undefined ? '—' : Math.round(v) + '٪');
  const small = (n) => (n === null || n === undefined || n > 30 ? '—' : n);
  const KIND = { course: 'الدرس ', class: 'الصف ', pub: 'الدرس العام ' };
  const dayOf = (iso) => esc(String(iso || '').slice(0, 10));
  async function openDetails() {
    let d; try { d = await rpc('details'); } catch (e) { return; }
    const p = d.prog;
    const classes = p ? p.classes : [];
    show(`<button class="x" id="offX">×</button><h2>ملخص البرامج وطلب التفاصيل</h2>
      ${p ? `<p>من ${dayOf(p.from)} إلى ${dayOf(p.to)} — النسب فقط، دون أسماء ولا مبالغ.</p>
        <div style="overflow:auto"><table style="width:100%;font-size:12px;border-collapse:collapse" id="offProg"><tr style="background:#eef2f0"><th style="padding:6px;text-align:right">الصف</th><th>الأعضاء</th><th>الحضور</th><th>قبلها</th><th>الدرس العام</th><th>صرّحوا بمساهمة</th><th>دفعوا</th></tr>
        ${classes.map((c) => `<tr style="border-top:1px solid #e2e8f0"><td style="padding:6px">${esc(c.label)}${c.branch ? '<br><small style="color:#64748b">' + esc(c.branch) + '</small>' : ''}</td><td style="text-align:center">${small(c.members)}</td><td style="text-align:center">${pct(c.att)}</td><td style="text-align:center;color:#64748b">${pct(c.attPrev)}</td><td style="text-align:center">${pct(c.pub)}</td><td style="text-align:center">${pct(c.declared)}</td><td style="text-align:center">${pct(c.paid)}</td></tr>`).join('')}</table></div>
        ${p.councils && p.councils.length ? '<p>مجالس الذكر (٣٠ يوماً): ' + p.councils.map((m) => esc(m.branch) + ' ' + pct(m.done)).join(' — ') + '</p>' : ''}
        <p style="font-size:11.5px;color:#64748b">يأتي هذا الملخص مع كل رد من المحطة.</p>` : ''}
      ${d.grants.length ? '<h2 style="font-size:14px;margin-top:14px">تفاصيل على هاتفك الآن</h2><ul>' + d.grants.map((g) => '<li>' + KIND[g.kind] + esc(g.kind === 'class' ? labelOf(classes, g.ref) : g.ref) + (g.members !== null && g.members !== undefined ? ' (' + g.members + ' عضواً)' : '') + ' — تُمحى تلقائياً يوم ' + dayOf(g.until) + (g.kind === 'pub' ? '<br><small>سجّل الحضور من «الدرس العام» في قسم البرامج.</small>' : '') + (g.kind !== 'pub' && g.people && g.people.length ? '<details><summary style="cursor:pointer;color:#1e382b;font-weight:800">عرض الأسماء</summary><ul style="margin:4px 0">' + g.people.map((x) => '<li>' + esc(x.name) + (x.level ? ' — م' + esc(x.level) : '') + (x.city ? ' — ' + esc(x.city) : '') + (x.phone ? ' — <a dir="ltr" href="tel:' + esc(x.phone) + '">' + esc(x.phone) + '</a>' : '') + '</li>').join('') + '</ul></details>' : '') + '</li>').join('') + '</ul>' : ''}
      ${d.asked.length ? '<div class="note">طلبات في الطريق إلى المحطة: ' + d.asked.map((a) => KIND[a.kind] + esc(a.kind === 'class' ? labelOf(classes, a.ref) : a.ref)).join('، ') + '</div>' : ''}
      ${d.canCourse ? `<h2 style="font-size:14px;margin-top:14px">طلب قائمة أعضاء درس</h2><p>اكتب رمز الدرس. تبقى القائمة على هاتفك ١٤ يوماً ثم تُمحى، ويُسجَّل الطلب في المحطة.</p>
        <input id="offCode" dir="ltr" maxlength="40" placeholder="رمز الدرس"><button class="ob" id="offAskCourse">طلب القائمة</button>` : ''}
      ${d.canClass && classes.length ? `<h2 style="font-size:14px;margin-top:14px">طلب قائمة أعضاء صف</h2><p>تبقى القائمة على هاتفك ١٤ يوماً ثم تُمحى، ويُسجَّل الطلب في المحطة.</p>
        <select id="offClass" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:14px;font-size:14px">${classes.map((c) => '<option value="' + esc(c.key) + '">' + esc(c.label) + (c.branch ? ' — ' + esc(c.branch) : '') + '</option>').join('')}</select>
        <button class="ob" id="offAskClass">طلب القائمة</button>` : ''}
      ${d.canPub && d.pubLessons.length ? `<h2 style="font-size:14px;margin-top:14px">درس عام أسجّل حضوره بالأسماء</h2><p>يصل الدرس وحصصه الأخيرة ومن حضرها، لمدة ١٤ يوماً (يمكن طلبه من جديد). من لا يوجد على هاتفك يُضاف برقم هاتفه، وتتعرّف عليه المحطة إن كان مسجّلاً.</p>
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
  function labelOf(classes, key) { const c = (classes || []).find((x) => x.key === key); return c ? c.label : key; }

  function collectFromSomeone() {
    show(`<button class="x" id="offX">×</button><h2>استلام تحديثات شخص</h2><p>يضغط صاحبها «إرسال تغييراتي»، ثم وجّه كاميرا هاتفك نحو رمزه.</p><div id="offScan"></div>
      <div id="offErr" class="err" style="display:none"></div><button class="ob l" id="offFile">قراءة ملف بدلاً من ذلك</button>`);
    $('#offX').onclick = close;
    const done = async (text) => {
      try {
        const c = await rpc('collect', text);
        const back = await rpc('packFor', c.from, c.bundles);
        show(`<button class="x" id="offX">×</button><h2>استُلمت تحديثات ${esc(c.name)}</h2>
          <p>${c.bundles.length} تحديث مختوم. تحمل الآن ${c.carrying} تحديثاً إلى المحطة.</p>
          <div class="note">الآن يضغط ${esc(c.name)} «قراءة الرد» ويمسح هذا الرمز: فيه إشعار بأنك تحمل تحديثاته${back.replies ? '، و' + back.replies + ' رد من المحطة له ولفريقه' : ''}.</div>
          <div id="offQR"></div><button class="ob" id="offOk">تم</button><button class="ob l" id="offFile">حفظ كملف / مشاركة</button>`);
        widgets.push(QRUI.player($('#offQR'), back.text, { chunk: 600, fps: 6 }));
        $('#offX').onclick = close; $('#offOk').onclick = openSync;
        $('#offFile').onclick = () => download('alasala-reply-' + new Date().toISOString().slice(0, 10) + '.alasala', back.text);
      } catch (e) { errBox(msgOf(e)); setTimeout(collectFromSomeone, 2500); }
    };
    widgets.push(QRUI.scanner($('#offScan'), done, { allowSingle: false }));
    $('#offFile').onclick = () => fileInput(done);
  }
  function readReply() {
    show(`<button class="x" id="offX">×</button><h2>قراءة الرد</h2><p>وجّه كاميرا الهاتف نحو الرمز المتحرك: على شاشة المحطة، أو على هاتف من يحمل تحديثاتك.</p><div id="offScan"></div>
      <div id="offErr" class="err" style="display:none"></div><button class="ob l" id="offFile">قراءة ملف بدلاً من ذلك</button>`);
    $('#offX').onclick = close;
    const done = async (text) => {
      try {
        const x = await rpc('applyIncoming', text);
        const r = x.mine;
        show(`<h2>${r ? 'وصل رد المحطة' : 'تمت القراءة'}</h2>
          ${r ? `<p>قُبل: <b>${r.accepted}</b> — رُفض: <b>${r.rejected.length}</b> — للمراجعة: <b>${r.held.length}</b> — في الانتظار: <b>${r.pending}</b></p>` : ''}
          ${x.inTransit ? '<div class="note">تغييراتك في الطريق مع <b>' + esc(x.inTransit.by) + '</b>. تبقى على هاتفك حتى يصل رد المحطة.</div>' : ''}
          ${x.carriedDown ? '<div class="note">تحمل ' + x.carriedDown + ' رداً لأشخاص من فريقك: أعطهم إياها عند استلام تحديثاتهم.</div>' : ''}
          ${!r && !x.inTransit && !x.carriedDown ? '<p>لا شيء جديد لك في هذا الرمز.</p>' : ''}
          ${r && r.rejected.length ? '<div class="err">رفضت المحطة:<ul>' + r.rejected.map((y) => '<li>' + esc(ACTIONS[y.action] || y.action) + ': ' + esc(REASONS[y.reason] || y.reason) + '</li>').join('') + '</ul></div>' : ''}
          ${r && r.held.length ? '<div class="warn">' + r.held.length + ' تغيير ينتظر مراجعة الإدارة.</div>' : ''}
          ${r && r.flagged.some((f) => /newer edit kept/.test(f.reason)) ? '<div class="warn">بعض تعديلاتك كانت أقدم من تعديل آخر على الخانة نفسها: بقي التعديل الأحدث.</div>' : ''}
          <button class="ob" id="offOk">حسناً</button>`);
        $('#offOk').onclick = () => { close(); if (r && typeof refreshLiveBackend === 'function') refreshLiveBackend(true); updateBadge(); };
      } catch (e) { errBox(msgOf(e)); setTimeout(readReply, 2500); }
    };
    widgets.push(QRUI.scanner($('#offScan'), done, { allowSingle: false }));
    $('#offFile').onclick = () => fileInput(done);
  }
  async function updateBadge() {
    try { const st = await rpc('status'); const b = $('#offSyncBadge'); if (b) { b.textContent = st.pending; b.style.display = st.pending ? 'flex' : 'none'; } } catch (e) { /* locked */ }
  }

  // ---------------------------------------------------------------- login screen & header
  async function afterLogin() {
    setTimeout(updateBadge, 300);
    setTimeout(a4Banner, 600);
    const st = await rpc('status');
    if (st.mustUpgradeSecret) setTimeout(() => changeSecret(true), 400);
  }
  /** A4: on the phone, percentages and lists on request; the full programs view stays on the master. */
  async function a4Banner() {
    let d; try { d = await rpc('details'); } catch (e) { return; }
    if (!d || d.tier !== 'A4' || $('#offA4')) return;
    const tabs = $('#actSubTabs'); if (!tabs || !tabs.parentNode) return;
    const b = document.createElement('div'); b.id = 'offA4';
    b.style.cssText = 'background:#f2f3fe;border:1px solid #cdd1fb;border-radius:14px;padding:10px 12px;font-size:12.5px;line-height:1.8;color:#3e4594;margin-bottom:10px';
    b.innerHTML = 'مسؤول البرامج (A4): على الهاتف ملخص بالنسب، وقوائم الصفوف والدرس العام عند الطلب. التفاصيل الكاملة والمساهمات في المحطة الرئيسية. <button type="button" style="display:block;margin-top:6px;width:100%;padding:9px;border:0;border-radius:12px;background:#5f68d8;color:#fff;font-weight:800;font-family:inherit">ملخص البرامج وطلب التفاصيل</button>';
    b.querySelector('button').onclick = openDetails;
    tabs.parentNode.insertBefore(b, tabs);
    // partial data on the phone: contribution details and the A4 setup checks are read on the master
    const css2 = document.createElement('style'); css2.textContent = '#actContrib,#actAreas,#actReports{display:none!important}'; document.head.appendChild(css2);
  }
  function addSyncButton() {
    const hdr = document.querySelector('#appShell header .flex.items-center.gap-1\\.5');
    if (!hdr || $('#offSyncBtn')) return;
    const b = document.createElement('button');
    b.id = 'offSyncBtn'; b.type = 'button'; b.title = 'مزامنة';
    b.className = 'p-2.5 rounded-xl text-slate-600 hover:text-olive-700 hover:bg-slate-200/60 transition-all cursor-pointer';
    b.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7h11m0 0l-3-3m3 3l-3 3M20 17H9m0 0l3-3m-3 3l3 3"/></svg><span id="offSyncBadge"></span>';
    b.onclick = openSync;
    hdr.insertBefore(b, hdr.firstChild);
  }
  async function prepareLogin(st) {
    const email = $('#loginEmailInput');
    if (email) { email.value = st.email; email.readOnly = true; }
    const pin = $('#loginPinInput');
    try { if (pin && localStorage.getItem('offPinKind') === 'text') pin.setAttribute('inputmode', 'text'); } catch (e) { /* none */ }
    const form = document.querySelector('#loginScreen form');
    if (form && !$('#offMark')) {
      const m = document.createElement('div'); m.id = 'offMark';
      m.innerHTML = 'علامتك الشخصية — إن لم تظهر فلا تكتب رمزك<b>' + esc(st.mark) + '</b>' + esc(st.name);
      form.parentElement.appendChild(m);
    }
    if (!standalone() && !$('#offTabWarn')) {
      const w = document.createElement('div'); w.id = 'offTabWarn';
      w.textContent = 'افتح التطبيق من أيقونته على الشاشة الرئيسية، لا من المتصفح.';
      document.body.insertBefore(w, document.body.firstChild);
    }
  }

  // ---------------------------------------------------------------- no big numbers on screen
  // Rule: a count above 30 is not shown in the app's screens (percentages, dates, times, phone numbers and ids are untouched).
  const COUNT_CAP = 30;
  const SKIP = { INPUT: 1, TEXTAREA: 1, SCRIPT: 1, STYLE: 1 };   // option texts are capped too (their values are untouched)
  function capText(t) {
    return t.replace(/(^|[^\d\-\/:.,%٪+A-Za-z_])(\d{2,5})(?![\d\-\/:.,%٪A-Za-z_])/g, (m, pre, num, off, all) => {
      const n = Number(num);
      if (n <= COUNT_CAP || (n >= 1990 && n <= 2100)) return m;
      if (/^\s*(يوم|يوماً|يوما|أيام|ايام|أسبوع|أسابيع|شهر|أشهر|شهور|سنة|سنوات|ساعة|ساعات|دقيقة|دقائق|صفحة)/.test(all.slice(off + m.length))) return m;   // durations, pages: not counts
      if (/(صفحة|الصفحة|ص\.|رقم|الرقم|سنة|عام)\s*$/.test(all.slice(0, off + pre.length))) return m;     // page, number, year
      return pre + '\u0001';
    }).replace(/\(\s*\u0001\s*\)/g, '').replace(/\u0001/g, '').replace(/ {2,}/g, ' ');
  }
  function capNode(root) {
    if (!root) return;
    if (root.nodeType === 3) { const p = root.parentElement; if (p && !SKIP[p.tagName] && !p.closest('[data-no-cap]')) { const v = capText(root.nodeValue); if (v !== root.nodeValue) root.nodeValue = v; } return; }
    if (root.nodeType !== 1 || SKIP[root.tagName] || root.closest('[data-no-cap]')) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; const list = []; while ((n = w.nextNode())) list.push(n);
    list.forEach(capNode);
  }
  function watchCounts() {
    const shell = document.getElementById('appShell'); if (!shell) return;
    capNode(shell);
    new MutationObserver((ms) => ms.forEach((m) => { if (m.type === 'characterData') capNode(m.target); else m.addedNodes.forEach(capNode); }))
      .observe(shell, { childList: true, subtree: true, characterData: true });
  }
  window.__offlineCapText = capText;

  // ---------------------------------------------------------------- automatic lock
  let lastUse = Date.now(), hiddenAt = 0;
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { lastUse = Date.now(); }, { passive: true }));
  async function lockNow() {
    try { await rpc('lock'); } catch (e) { /* already */ }
    close();
    if (typeof handleLogout === 'function' && window.AppState && AppState.currentUser) handleLogout(false);
  }
  setInterval(() => { if (Date.now() - lastUse > IDLE_MS && window.AppState && AppState.currentUser) lockNow(); }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > HIDDEN_MS && window.AppState && AppState.currentUser) lockNow();
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

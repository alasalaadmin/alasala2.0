/* lesson-date.js — the lesson date of a course follows the course's own day.
   When a course is opened for attendance, the date is its latest lesson day (today if the course is today); the
   arrows go to the previous or next lesson day (never after today). On a day that already has attendance saved,
   the list shows what was saved, so a past session can be read or corrected. A course without a day keeps the
   ordinary date field. */
(function () {
  'use strict';
  const DAYS = { 'الأحد': 0, 'الاحد': 0, 'الاثنين': 1, 'الإثنين': 1, 'الثلاثاء': 2, 'الأربعاء': 3, 'الاربعاء': 3, 'الخميس': 4, 'الجمعة': 5, 'السبت': 6 };
  const NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = (s) => { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const todayIso = () => iso(new Date());

  function lessonDays(course) {
    const s = String((course && course.day) || '');
    const out = new Set();
    Object.keys(DAYS).forEach((k) => { if (s.indexOf(k) !== -1) out.add(DAYS[k]); });
    return Array.from(out);
  }
  /** The lesson day at or before `from` (step -1), or after it (step +1); null past today. */
  function step(fromIso, days, dir, inclusive) {
    const d = parse(fromIso);
    if (!inclusive) d.setDate(d.getDate() + dir);
    for (let i = 0; i < 8; i++) {
      if (days.indexOf(d.getDay()) !== -1) { const v = iso(d); return dir > 0 && v > todayIso() ? null : v; }
      d.setDate(d.getDate() + dir);
    }
    return null;
  }

  let current = null;   // course code the widget is set for
  function input() { return document.getElementById('attDateInput'); }
  function course() { try { return AppState.mc && AppState.mc.code ? findCourseByCode(AppState.mc.code) : null; } catch (e) { return null; } }

  function ensureWidget() {
    let w = document.getElementById('lessonDateNav');
    if (w) return w;
    const inp = input(); if (!inp) return null;
    w = document.createElement('div');
    w.id = 'lessonDateNav';
    w.style.cssText = 'display:flex;align-items:center;gap:8px';
    const btn = 'flex:0 0 auto;padding:0 10px;height:38px;border-radius:12px;border:1px solid #cbd5e1;background:#f8fafc;font-size:12px;font-weight:800;color:#1e382b;cursor:pointer;font-family:inherit';
    w.innerHTML = '<button type="button" id="lessonPrev" style="' + btn + '" aria-label="الحصة السابقة">السابقة</button>'
      + '<div id="lessonLabel" style="flex:1;text-align:center;font-weight:800;font-size:13px;color:#0f172a;padding:8px 6px;border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc"></div>'
      + '<button type="button" id="lessonNext" style="' + btn + '" aria-label="الحصة التالية">التالية</button>';
    inp.insertAdjacentElement('afterend', w);
    w.querySelector('#lessonPrev').onclick = () => move(-1);
    w.querySelector('#lessonNext').onclick = () => move(1);
    return w;
  }

  function label(v) {
    const d = parse(v);
    const t = todayIso();
    const tag = v === t ? ' (اليوم)' : '';
    // the date stays left-to-right inside the Arabic line (otherwise it reads 2026-11-04)
    return NAMES[d.getDay()] + ' \u2066' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + '\u2069' + tag;
  }

  /** Marks of a day already saved: shown instead of «everyone present». */
  function fillFrom(v) {
    const c = course(); if (!c) return;
    const saved = (AppState.attendance || []).filter((a) => sameCode(a.courseCode, c.code) && String(a.date).slice(0, 10) === v);
    const byName = {}; saved.forEach((a) => { byName[String(a.studentName || '').trim()] = a; });
    (AppState.currentAttendanceRoster || []).forEach((it) => {
      const a = byName[String(it.studentName || '').trim()];
      it.value = a ? (Number(a.value) === 1 ? 1 : 0) : 1;
      it.status = it.value === 1 ? 'حاضر' : 'غائب';
    });
    if (typeof renderAttendanceStudentList === 'function') renderAttendanceStudentList();
    if (typeof setAttDirty === 'function') setAttDirty(false);
    const note = document.getElementById('lessonSavedNote');
    const n = note || Object.assign(document.createElement('div'), { id: 'lessonSavedNote' });
    n.style.cssText = 'font-size:11px;font-weight:700;color:#047857;margin-top:4px;text-align:center';
    n.textContent = saved.length ? 'حضور هذه الحصة مسجّل: يمكنك تعديله.' : '';
    if (!note) { const w = document.getElementById('lessonDateNav'); if (w) w.insertAdjacentElement('afterend', n); }
  }

  function setDate(v) {
    const inp = input(); if (!inp || !v) return;
    inp.value = v;
    const l = document.getElementById('lessonLabel'); if (l) l.textContent = label(v);
    const days = lessonDays(course());
    const next = document.getElementById('lessonNext'); if (next) { const ok = !!step(v, days, 1, false); next.disabled = !ok; next.style.opacity = ok ? '1' : '.35'; }
    fillFrom(v);
    if (typeof refreshNoSessionState === 'function') refreshNoSessionState();
  }

  function move(dir) {
    const inp = input(); const days = lessonDays(course());
    if (!inp || !days.length) return;
    const v = step(inp.value || todayIso(), days, dir, false);
    if (!v) return;
    if (typeof isAttendanceDirty !== 'undefined' && isAttendanceDirty && !confirm('لم تحفظ الحضور. الانتقال إلى حصة أخرى؟')) return;
    setDate(v);
  }

  function apply() {
    const c = course(), inp = input();
    if (!c || !inp) return;
    const days = lessonDays(c);
    const w = ensureWidget();
    if (!days.length) { inp.style.display = ''; if (w) w.style.display = 'none'; current = null; return; }
    inp.style.display = 'none'; if (w) w.style.display = 'flex';
    if (current !== c.code) { current = c.code; setDate(step(todayIso(), days, -1, true)); }
  }

  function hook() {
    if (typeof mcRender !== 'function' || mcRender.__lessonDate) return false;
    const orig = mcRender;
    const wrapped = function () { const r = orig.apply(this, arguments); try { apply(); } catch (e) { /* keep the screen */ } return r; };
    wrapped.__lessonDate = true;
    window.mcRender = wrapped;
    // a course closed and opened again starts again from its latest lesson day
    if (typeof mcBuildRoster === 'function' && !mcBuildRoster.__lessonDate) {
      const ob = mcBuildRoster;
      window.mcBuildRoster = function () { current = null; return ob.apply(this, arguments); };
      window.mcBuildRoster.__lessonDate = true;
    }
    return true;
  }
  if (!hook()) document.addEventListener('DOMContentLoaded', hook);
  window.LessonDate = { lessonDays, step };
})();

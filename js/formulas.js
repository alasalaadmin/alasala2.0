/**
 * formulas.js — the few spreadsheet formulas the app relies on, recomputed offline.
 * Google Sheets computed these by itself; without it, they are recomputed after every change.
 *   الرواد!S            normalized name (ARRAYFORMULA with REGEXREPLACE)
 *   قائمة الدروس!K      number of students per course (COUNTIF over الرواد!H)
 *   قائمة الدروس!J      progress in the book (lookup in أبواب الكتب by book | chapter)
 * Course codes (قائمة الدروس!C) were formulas too; they are frozen as plain values at import,
 * so a code never changes once given (API.gs already writes plain codes for new courses).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Formulas = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const S = { STUDENTS: 'الرواد', COURSES: 'قائمة الدروس', SYLLABUS: 'أبواب الكتب' };
  const clean = (v) => (v === null || v === undefined ? '' : String(v)).trim();
  const normH = (h) => clean(h).replace(/\s+/g, ' ').toLowerCase();

  function sheetNormName(s) {
    let t = String(s || '').toLowerCase();
    t = t.replace(/[ًٌٍَُِّْٰ]/g, '');
    t = t.replace(/(^| )ال/g, '$1');
    t = t.replace(/[إأآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ +/g, ' ');
    return t.trim();
  }

  function col(sheet, names) {
    const head = (sheet.data[0] || []).map(normH);
    for (const n of names) { const i = head.indexOf(normH(n)); if (i !== -1) return i; }
    return -1;
  }

  function setCell(sheet, r1, c0, v) { if (sheet.get(r1, c0 + 1) !== v) sheet.set(r1, c0 + 1, v); }

  function recompute(book) {
    const st = book.getSheetByName(S.STUDENTS);
    const co = book.getSheetByName(S.COURSES);
    const sy = book.getSheetByName(S.SYLLABUS);
    if (st) {
      const iName = col(st, ['الاسم']), iNorm = col(st, ['الاسم المعياري']);
      if (iName !== -1 && iNorm !== -1) {
        for (let r = 2; r <= st.data.length; r++) {
          const name = clean(st.get(r, iName + 1));
          setCell(st, r, iNorm, name ? sheetNormName(name) : '');
        }
      }
    }
    if (co && st) {
      const iCode = col(co, ['رمز الدرس']), iCount = col(co, ['عدد الطلاب']);
      const iCodes = col(st, ['رمز الدرس']);
      if (iCode !== -1 && iCount !== -1 && iCodes !== -1) {
        const counts = {};
        for (let r = 2; r <= st.data.length; r++) {
          const raw = clean(st.get(r, iCodes + 1)).replace(/ /g, '');
          if (!raw) continue;
          const seen = {};
          raw.split(',').forEach((c) => { if (c && !seen[c]) { seen[c] = 1; counts[c] = (counts[c] || 0) + 1; } });
        }
        for (let r = 2; r <= co.data.length; r++) {
          const code = clean(co.get(r, iCode + 1));
          setCell(co, r, iCount, code ? (counts[code] || 0) : '');
        }
      }
    }
    if (co && sy) {
      const iBook = col(co, ['الكتاب الحالي']), iTopic = col(co, ['آخر ما تم شرحه']), iProg = col(co, ['التقدم في الكتاب']);
      if (iBook !== -1 && iTopic !== -1 && iProg !== -1) {
        const map = {};
        for (let r = 2; r <= sy.data.length; r++) {
          const k = clean(sy.get(r, 1)) + '|' + clean(sy.get(r, 2));
          if (!(k in map)) map[k] = sy.get(r, 3);
        }
        for (let r = 2; r <= co.data.length; r++) {
          const b = clean(co.get(r, iBook + 1)), t = clean(co.get(r, iTopic + 1));
          let v = '';
          if (b && t) { const k1 = b + '|' + t, k2 = b + '|باب ' + t; v = k1 in map ? map[k1] : (k2 in map ? map[k2] : ''); }
          setCell(co, r, iProg, v);
        }
      }
    }
  }

  return { recompute, sheetNormName };
});

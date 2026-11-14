/* count-cap.js — the 30 rule: in the app's screens, a count above 30 is not shown (dates, years, durations, pages,
   percentages, times, ids and phone numbers are left as they are). Used by the phone app, and by the master station
   while it previews a person's screens. */
(function () {
  'use strict';
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
  /** Caps the counts inside root now and whenever it changes; enabled() decides, at each change, whether to cap. */
  function watch(shell, enabled) {
    if (!shell) return;
    enabled = enabled || (() => true);
    if (enabled()) capNode(shell);
    new MutationObserver((ms) => { if (enabled()) ms.forEach((m) => { if (m.type === 'characterData') capNode(m.target); else m.addedNodes.forEach(capNode); }); })
      .observe(shell, { childList: true, subtree: true, characterData: true });
  }
  window.CountCap = { capText, capNode, watch, LIMIT: COUNT_CAP };
})();

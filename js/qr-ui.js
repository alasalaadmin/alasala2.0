/**
 * qr-ui.js — browser widgets shared by the phone app and the master station:
 *   QRUI.player(container, frames)   shows the frames of a bundle in a loop (animated QR)
 *   QRUI.scanner(container, onText)  reads QR codes from the camera (BarcodeDetector when the
 *                                    browser has it, otherwise jsQR) and reassembles animated QR
 * Everything runs locally; the camera picture never leaves the device.
 */
(function (root) {
  'use strict';
  const AR = {
    slower: 'أبطأ', faster: 'أسرع', bigger: 'رمز أكبر', smaller: 'رمز أصغر', frame: 'الإطار', of: 'من',
    camera: 'الكاميرا', noCamera: 'تعذر فتح الكاميرا. اسمح للتطبيق باستعمالها أو استعمل ملفاً.', reading: 'جارٍ القراءة…', got: 'تمت قراءة', missing: 'ناقص'
  };

  function el(tag, attrs, html) { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (html !== undefined) e.innerHTML = html; return e; }

  function drawQR(canvas, text, ecc) {
    const q = root.qrcode(0, ecc || 'L');
    q.addData(text, 'Byte');
    q.make();
    const n = q.getModuleCount(), quiet = 4;
    const size = Math.min(canvas.parentElement ? canvas.parentElement.clientWidth || 360 : 360, 520);
    const scale = Math.max(2, Math.floor(size / (n + quiet * 2)));
    canvas.width = canvas.height = (n + quiet * 2) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  }

  /** Animated QR player. text: the bundle; opts.chunk (characters per frame), opts.fps */
  function player(container, text, opts) {
    opts = Object.assign({ chunk: 380, fps: 5 }, opts || {});
    container.innerHTML = '';
    const wrap = el('div', { className: 'qrui-player' });
    const canvas = el('canvas', { className: 'qrui-canvas' });
    canvas.style.cssText = 'width:100%;max-width:520px;image-rendering:pixelated;background:#fff;border-radius:12px;display:block;margin:0 auto';
    const info = el('div', { className: 'qrui-info' }); info.style.cssText = 'text-align:center;font-size:12px;color:#475569;margin:6px 0';
    const bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;justify-content:center;flex-wrap:wrap';
    const mk = (label, fn) => { const b = el('button', { type: 'button', textContent: label }); b.style.cssText = 'padding:6px 10px;border-radius:10px;border:1px solid #cbd5e1;background:#f8fafc;font-size:12px;font-weight:700;cursor:pointer'; b.onclick = fn; bar.appendChild(b); return b; };
    wrap.append(canvas, info, bar); container.appendChild(wrap);
    let frames = [], i = 0, timer = null, stopped = false;
    async function build() { frames = await root.QRFrames.split(text, opts.chunk); i = 0; }
    function tick() {
      if (stopped || !frames.length) return;
      drawQR(canvas, frames[i]);
      info.textContent = frames.length > 1 ? AR.frame + ' ' + (i + 1) + ' ' + AR.of + ' ' + frames.length + ' — ' + opts.fps + '/s' : '';
      i = (i + 1) % frames.length;
    }
    function restart() { clearInterval(timer); timer = setInterval(tick, Math.round(1000 / opts.fps)); tick(); }
    mk(AR.slower, () => { opts.fps = Math.max(1, opts.fps - 1); restart(); });
    mk(AR.faster, () => { opts.fps = Math.min(12, opts.fps + 1); restart(); });
    mk(AR.smaller, () => { opts.chunk = Math.max(120, Math.round(opts.chunk * 0.7)); build().then(restart); });
    mk(AR.bigger, () => { opts.chunk = Math.min(1200, Math.round(opts.chunk * 1.4)); build().then(restart); });
    build().then(restart);
    return { stop() { stopped = true; clearInterval(timer); }, frames: () => frames.length };
  }

  /** Single static QR (join request). */
  function still(container, text) {
    container.innerHTML = '';
    const canvas = el('canvas'); canvas.style.cssText = 'width:100%;max-width:420px;image-rendering:pixelated;background:#fff;border-radius:12px;display:block;margin:0 auto';
    container.appendChild(canvas);
    drawQR(canvas, text, 'M');
  }

  /** Camera reader. onDone(text) is called once a complete (single or animated) code was read. */
  function scanner(container, onDone, opts) {
    opts = opts || {};
    container.innerHTML = '';
    const video = el('video', { playsInline: true, muted: true, autoplay: true });
    video.setAttribute('playsinline', ''); video.style.cssText = 'width:100%;max-width:520px;border-radius:12px;background:#000;display:block;margin:0 auto';
    const status = el('div'); status.style.cssText = 'text-align:center;font-size:12px;font-weight:700;color:#334155;margin:6px 0';
    const prog = el('div'); prog.style.cssText = 'height:8px;background:#e2e8f0;border-radius:6px;overflow:hidden;max-width:520px;margin:0 auto';
    const fill = el('div'); fill.style.cssText = 'height:100%;width:0;background:#45b982;transition:width .2s'; prog.appendChild(fill);
    container.append(video, prog, status);
    const asm = new root.QRFrames.Assembler();
    const canvas = el('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream = null, stopped = false, detector = null, busy = false;
    status.textContent = AR.reading;
    if ('BarcodeDetector' in root) { try { detector = new root.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; } }

    async function handle(text) {
      const r = await asm.add(text);
      if (r.status === 'single' && opts.allowSingle !== false) { finish(r.text); return; }
      if (r.status === 'progress' || r.status === 'complete') {
        fill.style.width = Math.round(100 * r.have / r.total) + '%';
        status.textContent = AR.got + ' ' + r.have + ' / ' + r.total + (r.missing && r.missing.length && r.have > r.total * 0.7 ? ' — ' + AR.missing + ': ' + r.missing.join('، ') : '');
      }
      if (r.status === 'complete') finish(r.text);
    }
    function finish(text) { if (stopped) return; stop(); onDone(text); }
    async function loop() {
      if (stopped) return;
      if (!busy && video.readyState >= 2) {
        busy = true;
        try {
          if (detector) {
            const codes = await detector.detect(video);
            for (const c of codes) await handle(c.rawValue);
          } else {
            const w = video.videoWidth, h = video.videoHeight;
            const s = Math.min(1, 720 / Math.max(w, h));
            canvas.width = Math.round(w * s); canvas.height = Math.round(h * s);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = root.jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
            if (code && code.data) await handle(code.data);
          }
        } catch (e) { /* keep scanning */ }
        busy = false;
      }
      requestAnimationFrame(loop);
    }
    function stop() { stopped = true; if (stream) stream.getTracks().forEach((t) => t.stop()); }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: opts.facing || 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => { stream = s; video.srcObject = s; return video.play(); })
      .then(() => loop())
      .catch(() => { status.textContent = AR.noCamera; status.style.color = '#b91c1c'; });
    return { stop, feed: handle };
  }

  root.QRUI = { player, still, scanner, drawQR };
})(typeof self !== 'undefined' ? self : globalThis);

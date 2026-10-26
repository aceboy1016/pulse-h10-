/*
 * PULSE — 心拍グラフ（canvas）
 * 5秒以上の欠測は線をつながず、実測点だけを結ぶ。
 */
(function (root) {
  'use strict';
  const GAP = root.PulsePhysio.RECOVERY.gapMs;

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function prepare(canvas) {
    const dpr = Math.min(root.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function niceRange(min, max) {
    if (min == null || max == null) return [50, 180];
    let lo = Math.floor((min - 8) / 10) * 10, hi = Math.ceil((max + 8) / 10) * 10;
    if (hi - lo < 40) { const mid = (hi + lo) / 2; lo = Math.floor((mid - 20) / 10) * 10; hi = lo + 40; }
    return [Math.max(20, lo), hi];
  }

  function fmtX(ms, unit) {
    const s = Math.round(ms / 1000);
    if (unit === 's') return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  /*
   * opts: { from, to, samples, color, bands:[{from,to}], markers:[{t,label}], refLines:[{bpm,label}],
   *         origin (x軸ラベルの基準時刻), xUnit ('s'|'m'), xStep(ms), yRange:[lo,hi] }
   */
  function draw(canvas, opts) {
    if (!canvas || !canvas.isConnected || canvas.offsetParent === null) return;
    const g = prepare(canvas);
    const ctx = g.ctx, W = g.w, H = g.h;
    const padL = 36, padR = 10, padT = 10, padB = 22;
    const pw = W - padL - padR, ph = H - padT - padB;
    const from = opts.from, to = Math.max(opts.to, opts.from + 1000);
    const samples = opts.samples || [];
    // 表示範囲内の最小・最大
    let mn = null, mx = null;
    for (const s of samples) {
      if (s[0] < from - GAP || s[0] > to) continue;
      if (mn == null || s[1] < mn) mn = s[1];
      if (mx == null || s[1] > mx) mx = s[1];
    }
    (opts.refLines || []).forEach(function (r) { if (r.bpm != null) { mn = mn == null ? r.bpm : Math.min(mn, r.bpm); mx = mx == null ? r.bpm : Math.max(mx, r.bpm); } });
    const yr = opts.yRange || niceRange(mn, mx);
    const X = function (t) { return padL + (t - from) / (to - from) * pw; };
    const Y = function (b) { return padT + (1 - (b - yr[0]) / (yr[1] - yr[0])) * ph; };
    const line = css('--line'), faint = css('--text-3'), font = '11px ' + css('--font-num');

    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
    // 帯（回復区間など）
    (opts.bands || []).forEach(function (b) {
      ctx.fillStyle = b.color || 'rgba(127,224,192,0.08)';
      ctx.fillRect(X(b.from), padT, X(b.to) - X(b.from), ph);
    });
    ctx.restore();

    // 横グリッド
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.font = font; ctx.fillStyle = faint;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const ystep = (yr[1] - yr[0]) > 100 ? 40 : 20;
    for (let b = Math.ceil(yr[0] / ystep) * ystep; b <= yr[1]; b += ystep) {
      const y = Math.round(Y(b)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(String(b), padL - 6, y);
    }
    // 縦目盛
    const origin = opts.origin != null ? opts.origin : from;
    const span = to - from;
    const xStep = opts.xStep || (span <= 150000 ? 30000 : span <= 600000 ? 60000 : span <= 1800000 ? 300000 : 600000);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const first = origin + Math.ceil((from - origin) / xStep) * xStep;
    for (let t = first; t <= to; t += xStep) {
      const x = Math.round(X(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, padT + ph); ctx.lineTo(x, padT + ph + 4); ctx.stroke();
      ctx.fillText(fmtX(t - origin, opts.xUnit), x, padT + ph + 7);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
    // 基準線
    (opts.refLines || []).forEach(function (r) {
      if (r.bpm == null) return;
      const y = Math.round(Y(r.bpm)) + 0.5;
      ctx.setLineDash([4, 4]); ctx.strokeStyle = r.color || faint;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.setLineDash([]);
      if (r.label) { ctx.fillStyle = r.color || faint; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(r.label, padL + 4, y - 2); }
    });
    // マーカー（30/60/120秒など）
    (opts.markers || []).forEach(function (m) {
      const x = Math.round(X(m.t)) + 0.5;
      ctx.strokeStyle = m.color || line; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      if (m.label) { ctx.fillStyle = m.color || faint; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(m.label, x + 3, padT + 2); }
    });
    // 実測線（欠測では切る）
    ctx.strokeStyle = opts.color || css('--lime'); ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    let prev = null; let open = false;
    ctx.beginPath();
    for (const s of samples) {
      if (s[0] < from - GAP) { prev = s; continue; }
      if (s[0] > to + GAP) break;
      if (!prev || s[0] - prev[0] > GAP) {
        ctx.moveTo(X(s[0]), Y(s[1]));
        ctx.lineTo(X(s[0]) + 0.01, Y(s[1])); // 単独点も見えるように
      } else {
        if (!open) ctx.moveTo(X(prev[0]), Y(prev[1]));
        ctx.lineTo(X(s[0]), Y(s[1]));
      }
      open = true;
      prev = s;
    }
    ctx.stroke();
    ctx.restore();

    if (!samples.length && opts.emptyText) {
      ctx.fillStyle = faint; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '13px ' + css('--font-ui');
      ctx.fillText(opts.emptyText, padL + pw / 2, padT + ph / 2);
    }
  }

  root.PulseChart = { draw: draw };
})(window);

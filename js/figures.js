/*
 * PULSE — 強度の参考イメージ（線画SVG）
 */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const GROUND = 'M14 72H106';
  const FIGURES = {
    stand: { head: [60, 13], paths: ['M60 20V46', 'M60 26L51 41', 'M60 26L69 41', 'M60 46L55 71', 'M60 46L65 71'] },
    walk: { head: [59, 13], paths: ['M59 20L61 46', 'M60 27L51 39', 'M60 27L69 37', 'M61 46L51 71', 'M61 46L68 59L71 71'] },
    bike: {
      head: [69, 13], circles: [[35, 58, 13], [85, 58, 13]],
      paths: ['M35 58L52 58L70 40L48 40Z', 'M52 58L46 36', 'M42 35H52', 'M70 40L73 32H79',
        'M50 36L64 20', 'M64 22L76 33', 'M50 36L60 47L53 58']
    },
    run: { head: [67, 11], paths: ['M65 18L56 42', 'M63 24L72 33L79 27', 'M63 24L51 30L47 39', 'M56 42L70 53L65 70', 'M56 42L45 56L34 55'] },
    sprint: {
      head: [76, 14],
      paths: ['M72 20L55 40', 'M69 25L83 31', 'M67 25L53 22', 'M55 40L70 52L73 70', 'M55 40L41 50L29 45',
        'M10 30H25', 'M6 40H21', 'M12 50H24']
    }
  };

  function el(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function render(svg, key) {
    if (!svg || svg.dataset.figure === key) return;
    svg.dataset.figure = key || '';
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const f = FIGURES[key];
    if (!f) return;
    svg.appendChild(el('path', { d: GROUND, class: 'ground' }));
    (f.circles || []).forEach(function (c) { svg.appendChild(el('circle', { cx: c[0], cy: c[1], r: c[2] })); });
    f.paths.forEach(function (d) { svg.appendChild(el('path', { d: d })); });
    svg.appendChild(el('circle', { cx: f.head[0], cy: f.head[1], r: 6 }));
  }

  root.PulseFigures = { render: render };
})(window);
